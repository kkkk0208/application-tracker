import { pageBridge } from "./pageBridge.js";

export async function scanPage(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//.test(tab.url || "")) throw new Error("请先打开普通网站的申请页面");
  let frames;
  let enumerationFailed = false;
  try { frames = await chrome.webNavigation.getAllFrames({ tabId }); } catch { enumerationFailed = true; }
  frames = frames?.length ? frames : [{ frameId: 0, url: tab.url }];
  const results = await Promise.allSettled(frames.map(async (frame) => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, func: pageBridge, args: [{ action: "scan" }] });
    if (!result?.result || !result.documentId) throw new Error("未取得文档标识，请更新 Chrome");
    return { ...result.result, frameId: frame.frameId, documentId: result.documentId };
  }));
  const scanned = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const main = scanned.find((r) => r.frameId === 0);
  if (!main) throw new Error("无法读取目标页面，请在该页面重新点击插件后重试");
  const failedFrames = frames.flatMap((frame, index) => {
    if (results[index].status !== "rejected") return [];
    let origin = "";
    try { const url = new URL(frame.url); if (/^https?:$/.test(url.protocol)) origin = url.origin; } catch { /* Non-web frames cannot request a host permission. */ }
    return [{ frameId: frame.frameId, origin, reason: "此页面区域无法读取，请检查访问权限或刷新网页" }];
  });
  const snapshot = { id: crypto.randomUUID(), tabId, url: tab.url, title: tab.title || main.title, frames: scanned, failedFrames, pageType: main.pageType, jobText: scanned.map((r) => r.jobText).filter(Boolean).join("\n"), fields: [], coverage: { scanned: scanned.length, total: frames.length, failed: failedFrames.length, unknown: enumerationFailed } };
  snapshot.fields = scanned.flatMap((frame) => frame.fields.map((field) => ({ ...field, localFieldId: field.fieldId, fieldId: `${frame.documentId}:${field.fieldId}`, groupId: `${frame.documentId}:${field.groupId}`, frameId: frame.frameId, documentId: frame.documentId })));
  if (scanned.some((r) => r.pageType === "application")) snapshot.pageType = "application";
  else if (scanned.some((r) => r.pageType === "form") && snapshot.pageType !== "login") snapshot.pageType = "form";
  return snapshot;
}
export async function checkTarget(snapshot) {
  const tab = await chrome.tabs.get(snapshot.tabId);
  if (tab.url !== snapshot.url) throw new Error("目标页面已跳转，请重新识别");
  const main = snapshot.frames.find((f) => f.frameId === 0);
  const [result] = await chrome.scripting.executeScript({ target: { tabId: snapshot.tabId, documentIds: [main.documentId] }, func: pageBridge, args: [{ action: "ping" }] });
  if (result?.result?.token !== main.token || result?.result?.scanId !== main.scanId) throw new Error("页面快照已过期，请重新识别");
  return tab;
}
export async function fieldAction(snapshot, item, action, extra = {}) {
  await checkTarget(snapshot);
  const frame = snapshot.frames.find((f) => f.documentId === item.documentId);
  if (!frame) throw new Error("无法找到原字段所在页面");
  const [result] = await chrome.scripting.executeScript({ target: { tabId: snapshot.tabId, documentIds: [frame.documentId] }, func: pageBridge, args: [{ action, token: frame.token, scanId: frame.scanId, url: frame.url, fieldId: item.localFieldId, ...extra }] });
  if (!result?.result) throw new Error("页面没有返回操作结果");
  return result.result;
}
export async function inspectOptions(snapshot, item, extra = {}) {
  const result = await fieldAction(snapshot, item, "inspect-options", extra);
  if (result.status !== "inspected") return result;
  const field = { ...result.field, localFieldId: item.localFieldId, fieldId: item.fieldId,
    groupId: `${item.documentId}:${result.field.groupId}`, frameId: item.frameId, documentId: item.documentId };
  const index = snapshot.fields.findIndex((candidate) => candidate.fieldId === item.fieldId);
  if (index !== -1) snapshot.fields[index] = field;
  return { ...result, field };
}
export async function pageChanges(snapshot) {
  const results = await Promise.allSettled(snapshot.frames.map(async (frame) => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: snapshot.tabId, documentIds: [frame.documentId] }, func: pageBridge, args: [{ action: "changes", token: frame.token, scanId: frame.scanId, url: frame.url }] });
    return { added: result.result.added, changed: result.result.changed.map((id) => `${frame.documentId}:${id}`) };
  }));
  if (results.some((r) => r.status === "rejected")) throw new Error("部分页面已变化或无法访问，请重新识别");
  return { added: results.reduce((n, r) => n + r.value.added, 0), changed: results.flatMap((r) => r.value.changed) };
}

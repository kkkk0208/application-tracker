import { pageBridge } from "./pageBridge.js";

function mainScanError(reason, tab, tabId) {
  // Chrome injection failures can contain complete URLs. Keep only a stable
  // category and the site's origin; never surface raw errors or route tokens.
  const message = String(reason?.message || "");
  let code = reason?.code || "PAGE_SCAN_FAILED";
  if (/cannot access (?:contents|this frame|page)|manifest must request permission|missing host permission|not allowed to access/i.test(message)) code = "PAGE_ACCESS_REQUIRED";
  else if (/no (?:tab|frame) with id|frame .*removed|tab (?:was |is )?closed|document .*unloaded/i.test(message)) code = "PAGE_CHANGED";
  if (!["PAGE_ACCESS_REQUIRED", "PAGE_CHANGED", "PAGE_DOCUMENT_UNAVAILABLE"].includes(code)) code = "PAGE_SCAN_FAILED";
  const descriptions = {
    PAGE_ACCESS_REQUIRED: "尚未获得此站点的读取权限。请点击下方“允许读取此站点”，或回到该页面点击浏览器工具栏里的插件图标后重试。",
    PAGE_CHANGED: "读取时页面或标签页已变化，请等待页面加载完成后重新识别。",
    PAGE_DOCUMENT_UNAVAILABLE: "Chrome 未返回页面文档标识，请更新浏览器并重新加载扩展后重试。",
    PAGE_SCAN_FAILED: "页面扫描未能完成，请重新识别；若仍失败，请反馈错误码 PAGE_SCAN_FAILED。"
  };
  const error = new Error(descriptions[code]);
  Object.assign(error, { code, tabId, pageUrl: tab.url, origin: new URL(tab.url).origin, title: tab.title || "当前申请页面" });
  return error;
}

export async function scanPage(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//.test(tab.url || "")) throw new Error("请先打开普通网站的申请页面");
  let frames;
  let enumerationFailed = false;
  try { frames = await chrome.webNavigation.getAllFrames({ tabId }); } catch { enumerationFailed = true; }
  frames = frames?.length ? frames : [{ frameId: 0, url: tab.url }];
  const results = await Promise.allSettled(frames.map(async (frame) => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, func: pageBridge, args: [{ action: "scan" }] });
    if (!result?.documentId) throw Object.assign(new Error("Missing document identity"), { code: "PAGE_DOCUMENT_UNAVAILABLE" });
    if (!result.result || !Array.isArray(result.result.fields)) throw new Error("Invalid scan result");
    return { ...result.result, frameId: frame.frameId, documentId: result.documentId };
  }));
  const scanned = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const main = scanned.find((r) => r.frameId === 0);
  if (!main) throw mainScanError(results[frames.findIndex((frame) => frame.frameId === 0)]?.reason, tab, tabId);
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

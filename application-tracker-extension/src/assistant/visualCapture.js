import { pageBridge } from "./pageBridge.js";
import { checkTarget } from "./session.js";

const MAX_SIDE = 1600;
const fail = (code, message) => Object.assign(new Error(message), { code });
const abortCheck = (signal) => { if (signal?.aborted) throw fail("VISUAL_CANCELLED", "已取消截图识别"); };
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const rectValid = (rect) => rect && [rect.x, rect.y, rect.width, rect.height].every(finite) && rect.width > 0 && rect.height > 0;
function validateLayout(layout) {
  const v = layout?.viewport;
  if (!v || ![v.width, v.height, v.scrollX, v.scrollY, v.devicePixelRatio, v.visualScale, v.visualOffsetX, v.visualOffsetY].every(finite) || v.width < 1 || v.height < 1 || v.width > 20000 || v.height > 20000 || !Array.isArray(layout.fields) || !Array.isArray(layout.redactions) || layout.fields.length > 30 || layout.redactions.length > 5000) throw fail("VISUAL_LAYOUT", "未能安全读取页面布局，请继续使用网页文字识别");
  if (Math.abs(v.visualScale - 1) > 0.001 || Math.abs(v.visualOffsetX) > 0.01 || Math.abs(v.visualOffsetY) > 0.01) throw fail("VISUAL_ZOOM", "请先恢复页面的触控缩放，再进行截图识别");
  if (layout.changed) throw fail("VISUAL_LAYOUT_CHANGED", "截图期间页面滚动或布局发生变化，请重新识别");
  for (const field of layout.fields) if (typeof field.localFieldId !== "string" || !field.localFieldId || !rectValid(field.rect)) throw fail("VISUAL_LAYOUT", "页面字段位置不完整，请重新识别");
  for (const rect of layout.redactions) if (!rectValid(rect)) throw fail("VISUAL_LAYOUT", "页面遮盖区域不完整，请重新识别");
  return layout;
}
const layoutSignature = (layout) => JSON.stringify([layout.viewport, layout.fields, layout.redactions]);

async function readLayout(snapshot, main, signal, watch) {
  abortCheck(signal);
  const [result] = await chrome.scripting.executeScript({ target: { tabId: snapshot.tabId, documentIds: [main.documentId] }, func: pageBridge, args: [{ action: "visual-layout", token: main.token, scanId: main.scanId, url: main.url, ...watch }] });
  abortCheck(signal);
  if (result?.documentId && result.documentId !== main.documentId) throw fail("VISUAL_STALE", "截图期间页面已变化，请重新识别");
  return validateLayout(result?.result);
}

async function dataUrlFor(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 32768) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 32768)));
  return `data:image/png;base64,${btoa(chunks.join(""))}`;
}

// Layout and field rectangles use viewport-relative CSS pixels. Returned scale
// converts CSS coordinates to output image pixels. Raw pixels never leave this
// function or enter storage; masking happens before the image is downscaled.
export async function renderVisualCapture(rawImageUrl, layout, fields, { signal } = {}) {
  abortCheck(signal); validateLayout(layout);
  if (typeof rawImageUrl !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(rawImageUrl)) throw fail("VISUAL_IMAGE", "浏览器未返回可用的截图");
  let bitmap;
  let source;
  let output;
  try {
    const response = await fetch(rawImageUrl, { signal });
    bitmap = await createImageBitmap(await response.blob());
    abortCheck(signal);
    const { width, height } = layout.viewport;
    const sx = bitmap.width / width, sy = bitmap.height / height;
    if (!finite(sx) || !finite(sy) || sx <= 0 || sy <= 0 || Math.abs(bitmap.width - width * sy) > 2 || Math.abs(bitmap.height - height * sx) > 2) throw fail("VISUAL_SIZE", "截图尺寸与当前页面不一致，请重新识别");
    source = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = source.getContext("2d", { alpha: false });
    if (!ctx) throw fail("VISUAL_CANVAS", "当前浏览器无法处理截图，请继续使用网页文字识别");
    ctx.drawImage(bitmap, 0, 0);
    ctx.fillStyle = "#e8ece9";
    for (const rect of layout.redactions) {
      const left = Math.max(0, Math.floor((rect.x - 4) * sx)), top = Math.max(0, Math.floor((rect.y - 4) * sy));
      const right = Math.min(bitmap.width, Math.ceil((rect.x + rect.width + 4) * sx)), bottom = Math.min(bitmap.height, Math.ceil((rect.y + rect.height + 4) * sy));
      ctx.fillRect(left, top, right - left, bottom - top);
    }
    abortCheck(signal);
    const ratio = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const outputWidth = Math.max(1, Math.round(bitmap.width * ratio)), outputHeight = Math.max(1, Math.round(bitmap.height * ratio));
    output = new OffscreenCanvas(outputWidth, outputHeight);
    const out = output.getContext("2d", { alpha: false });
    if (!out) throw fail("VISUAL_CANVAS", "当前浏览器无法处理截图，请继续使用网页文字识别");
    out.drawImage(source, 0, 0, outputWidth, outputHeight);
    const scaleX = outputWidth / width, scaleY = outputHeight / height;
    out.strokeStyle = "#165dd8"; out.lineWidth = 2;
    out.font = "bold 13px sans-serif"; out.textBaseline = "top";
    for (const field of fields) {
      if (!rectValid(field.rect) || !/^V(?:[1-9]|[12]\d|30)$/.test(field.marker)) throw fail("VISUAL_MARKER", "截图字段编号无效，请重新识别");
      const x = field.rect.x * scaleX, y = field.rect.y * scaleY;
      out.strokeRect(x + 1, y + 1, Math.max(1, field.rect.width * scaleX - 2), Math.max(1, field.rect.height * scaleY - 2));
      const tagWidth = out.measureText(field.marker).width + 8;
      out.fillStyle = "#165dd8"; out.fillRect(x, y, tagWidth, 19);
      out.fillStyle = "#fff"; out.fillText(field.marker, x + 4, y + 3);
    }
    const blob = await output.convertToBlob({ type: "image/png" });
    abortCheck(signal);
    const imageUrl = await dataUrlFor(blob);
    abortCheck(signal);
    return { imageUrl, scale: scaleX };
  } catch (error) {
    abortCheck(signal);
    if (error?.code?.startsWith("VISUAL_")) throw error;
    throw fail("VISUAL_IMAGE", "截图处理失败，请继续使用网页文字识别或稍后重试");
  } finally {
    bitmap?.close?.();
    if (source) { source.width = 1; source.height = 1; }
    if (output) { output.width = 1; output.height = 1; }
  }
}

export async function captureVisualContext(snapshot, { signal } = {}) {
  abortCheck(signal);
  const main = snapshot?.frames?.find((frame) => frame.frameId === 0);
  if (!main?.documentId || !snapshot?.tabId || !/^https?:\/\//.test(snapshot.url || "")) throw fail("VISUAL_TARGET", "请先识别当前申请网站，再使用截图识别");
  const firstTab = await chrome.tabs.get(snapshot.tabId);
  abortCheck(signal);
  const windowId = firstTab.windowId;
  let invalidated = false;
  const changed = (info) => { if (info.windowId === windowId && info.tabId !== snapshot.tabId) invalidated = true; };
  const updated = (tabId, info) => { if (tabId === snapshot.tabId && (info.url || info.status === "loading")) invalidated = true; };
  const focused = (id) => { if (id !== windowId) invalidated = true; };
  const guard = () => { abortCheck(signal); if (invalidated) throw fail("VISUAL_STALE", "截图期间切换了页面，请回到原申请页重新识别"); };
  const assertActive = async () => {
    guard();
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    guard();
    if (active.length !== 1 || active[0].id !== snapshot.tabId || active[0].windowId !== windowId || active[0].url !== snapshot.url || active[0].pendingUrl) throw fail("VISUAL_INACTIVE", "请先切回助手绑定的申请页面，再使用截图识别");
    try { await checkTarget(snapshot); } catch { throw fail("VISUAL_STALE", "目标页面或文档已变化，请重新识别"); }
    guard();
  };
  let rawImageUrl;
  const watchId = crypto.randomUUID();
  let watchStarted = false;
  chrome.tabs.onActivated.addListener(changed);
  chrome.tabs.onUpdated.addListener(updated);
  chrome.windows?.onFocusChanged?.addListener(focused);
  try {
    await assertActive();
    watchStarted = true;
    const before = await readLayout(snapshot, main, signal, { startWatch: watchId });
    const mainFields = new Map((snapshot.fields || []).filter((field) => field.frameId === 0 && field.documentId === main.documentId && field.supported && !field.value).map((field) => [field.localFieldId, field]));
    const fields = before.fields.filter((field) => mainFields.has(field.localFieldId)).slice(0, 30).map((field, index) => ({ fieldId: mainFields.get(field.localFieldId).fieldId, marker: `V${index + 1}`, rect: { ...field.rect } }));
    if (!fields.length) throw fail("VISUAL_EMPTY", "当前视口没有可截图识别的空白字段，可继续使用网页文字识别");
    await assertActive();
    try { rawImageUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" }); }
    catch (error) {
      guard();
      if (/activeTab|permission|<all_urls>|not allowed|cannot access/i.test(error?.message || "")) throw fail("VISUAL_PERMISSION", "当前页面没有截图权限，请在此申请页重新点击扩展图标；也可继续使用网页文字识别");
      throw fail("VISUAL_CAPTURE", "无法截取当前页面，请继续使用网页文字识别或稍后重试");
    }
    await assertActive();
    const after = await readLayout(snapshot, main, signal, { watchId });
    if (layoutSignature(before) !== layoutSignature(after)) throw fail("VISUAL_LAYOUT_CHANGED", "截图期间页面滚动或布局发生变化，请重新识别");
    const rendered = await renderVisualCapture(rawImageUrl, before, fields, { signal });
    rawImageUrl = undefined;
    await assertActive();
    const finalLayout = await readLayout(snapshot, main, signal, { watchId });
    if (layoutSignature(before) !== layoutSignature(finalLayout)) throw fail("VISUAL_LAYOUT_CHANGED", "截图期间页面滚动或布局发生变化，请重新识别");
    guard();
    return { imageUrl: rendered.imageUrl, fields, viewport: { width: before.viewport.width, height: before.viewport.height, scrollX: before.viewport.scrollX, scrollY: before.viewport.scrollY, scale: rendered.scale }, capturedAt: new Date().toISOString(), maskedCount: before.redactions.length };
  } finally {
    rawImageUrl = undefined;
    if (watchStarted) {
      try { await chrome.scripting.executeScript({ target: { tabId: snapshot.tabId, documentIds: [main.documentId] }, func: pageBridge, args: [{ action: "visual-layout", token: main.token, scanId: main.scanId, url: main.url, releaseWatch: watchId }] }); } catch { /* Navigation destroys the old document; a 5s expiry also releases abandoned watches. */ }
    }
    chrome.tabs.onActivated.removeListener(changed);
    chrome.tabs.onUpdated.removeListener(updated);
    chrome.windows?.onFocusChanged?.removeListener(focused);
    guard();
  }
}

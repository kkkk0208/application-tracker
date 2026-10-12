import test from "node:test";
import assert from "node:assert/strict";
import { captureVisualContext, renderVisualCapture } from "../src/assistant/visualCapture.js";

const rawImage = "data:image/png;base64,UkFXX0lNQUdFX1NFQ1JFVA==";
const layout = () => ({ viewport: { width: 1000, height: 500, scrollX: 0, scrollY: 20, devicePixelRatio: 2, visualScale: 1, visualOffsetX: 0, visualOffsetY: 0 }, fields: [{ localFieldId: "f1", rect: { x: 40, y: 60, width: 200, height: 30 } }], redactions: [{ x: 40, y: 60, width: 200, height: 30 }, { x: 350, y: 50, width: 300, height: 100 }] });
const snapshot = () => ({ tabId: 12, url: "https://example.com/apply", frames: [{ frameId: 0, documentId: "doc-main", token: "token", scanId: "scan", url: "https://example.com/apply" }], fields: [{ frameId: 0, documentId: "doc-main", localFieldId: "f1", fieldId: "doc-main:f1", supported: true, value: "" }] });
const event = () => { const listeners = new Set(); return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), emit: (...args) => listeners.forEach((fn) => fn(...args)), count: () => listeners.size }; };

async function harness(run) {
  const previous = Object.fromEntries(["chrome", "fetch", "OffscreenCanvas", "createImageBitmap"].map((key) => [key, globalThis[key]]));
  const state = { tab: { id: 12, windowId: 3, url: "https://example.com/apply", active: true }, activeId: 12, token: "token", layout: layout(), captured: 0, canvases: [], actions: [], bitmapClosed: false };
  const activated = event(), updated = event(), focused = event();
  const context = (canvas) => ({
    drawImage(...args) { canvas.calls.push(["draw", ...args.map((value) => typeof value === "object" ? "bitmap" : value)]); },
    fillRect(...args) { canvas.calls.push(["fill", this.fillStyle, ...args]); },
    strokeRect(...args) { canvas.calls.push(["stroke", ...args]); },
    fillText(...args) { canvas.calls.push(["text", ...args]); },
    measureText(text) { return { width: text.length * 7 }; }
  });
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; this.originalSize = [width, height]; this.calls = []; this.context = context(this); state.canvases.push(this); }
    getContext() { return this.context; }
    async convertToBlob() { return new Blob([JSON.stringify({ redacted: true, width: this.width, height: this.height })], { type: "image/png" }); }
  }
  globalThis.OffscreenCanvas = Canvas;
  globalThis.fetch = async (url) => { assert.equal(url, rawImage); return { blob: async () => new Blob(["private pixels"]) }; };
  globalThis.createImageBitmap = async () => { await state.onDecode?.(); return { width: 2000, height: 1000, close() { state.bitmapClosed = true; } }; };
  globalThis.chrome = {
    tabs: {
      get: async () => ({ ...state.tab }),
      query: async (query) => { assert.deepEqual(query, { active: true, lastFocusedWindow: true }); return [{ ...state.tab, id: state.activeId }]; },
      captureVisibleTab: async (windowId, options) => { assert.equal(windowId, 3); assert.deepEqual(options, { format: "png" }); state.captured++; await state.onCapture?.(); if (state.captureError) throw state.captureError; return rawImage; },
      onActivated: activated, onUpdated: updated
    },
    windows: { onFocusChanged: focused },
    scripting: { executeScript: async ({ target, args }) => {
      assert.deepEqual(target, { tabId: 12, documentIds: ["doc-main"] });
      const request = args[0]; state.actions.push(request.releaseWatch ? "visual-release" : request.action);
      return [{ documentId: "doc-main", result: request.action === "ping" ? { token: state.token, scanId: "scan" } : structuredClone(state.layout) }];
    } },
    storage: new Proxy({}, { get() { throw new Error("Screenshot capture must never access storage"); } })
  };
  try { await run(state, { activated, updated, focused }); }
  finally {
    assert.equal(activated.count(), 0, "activation listener leaked");
    assert.equal(updated.count(), 0, "navigation listener leaked");
    assert.equal(focused.count(), 0, "focus listener leaked");
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
}

test("visual capture masks before resizing, numbers main-frame fields and never stores raw images", async () => harness(async (state) => {
  const input = snapshot();
  input.fields.push({ frameId: 4, documentId: "child", localFieldId: "f2", fieldId: "child:f2", supported: true, value: "" });
  const result = await captureVisualContext(input);
  assert.equal(state.captured, 1);
  assert.deepEqual(result.fields, [{ fieldId: "doc-main:f1", marker: "V1", rect: { x: 40, y: 60, width: 200, height: 30 } }]);
  assert.deepEqual(result.viewport, { width: 1000, height: 500, scrollX: 0, scrollY: 20, scale: 1.6 });
  assert.equal(result.maskedCount, 2);
  assert.notEqual(result.imageUrl, rawImage);
  assert.deepEqual(state.canvases.map((canvas) => canvas.originalSize), [[2000, 1000], [1600, 800]]);
  assert.deepEqual(state.canvases[0].calls[1], ["fill", "#e8ece9", 72, 112, 416, 76]);
  assert.ok(state.canvases[1].calls.some((call) => call[0] === "text" && call[1] === "V1"));
  assert.equal(state.bitmapClosed, true);
  assert.ok(state.canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
  assert.equal(state.actions.filter((action) => action === "visual-layout").length, 3);
  assert.equal(state.actions.filter((action) => action === "visual-release").length, 1);
}));

test("inactive and non-web targets fail before any screenshot", async () => harness(async (state) => {
  state.activeId = 99;
  await assert.rejects(captureVisualContext(snapshot()), { code: "VISUAL_INACTIVE" });
  await assert.rejects(captureVisualContext({ ...snapshot(), url: "chrome://settings" }), { code: "VISUAL_TARGET" });
  assert.equal(state.captured, 0);
}));

test("switching away and back during capture permanently discards that screenshot", async () => harness(async (state, events) => {
  state.onCapture = () => { events.activated.emit({ tabId: 99, windowId: 3 }); events.activated.emit({ tabId: 12, windowId: 3 }); };
  await assert.rejects(captureVisualContext(snapshot()), { code: "VISUAL_STALE" });
  assert.equal(state.canvases.length, 0);
}));

test("navigation events and changed document identity discard captures", async () => harness(async (state, events) => {
  state.onCapture = () => events.updated.emit(12, { status: "loading" });
  await assert.rejects(captureVisualContext(snapshot()), { code: "VISUAL_STALE" });
  state.onCapture = () => { state.token = "different-document"; };
  await assert.rejects(captureVisualContext(snapshot()), { code: "VISUAL_STALE" });
}));

test("losing browser focus and returning during capture discards the image", async () => harness(async (state, events) => {
  state.onCapture = () => { events.focused.emit(-1); events.focused.emit(3); };
  await assert.rejects(captureVisualContext(snapshot()), { code: "VISUAL_STALE" });
  assert.equal(state.canvases.length, 0);
}));

test("a transient layout mutation remains invalid even after geometry is restored", async () => harness(async (state) => {
  state.onCapture = () => { state.layout.changed = true; };
  await assert.rejects(captureVisualContext(snapshot()), { code: "VISUAL_LAYOUT_CHANGED" });
  assert.equal(state.canvases.length, 0);
  assert.equal(state.actions.filter((action) => action === "visual-release").length, 1);
}));

test("scroll or geometry changes and late rendering changes invalidate the image", async () => harness(async (state) => {
  state.onCapture = () => { state.layout.viewport.scrollY++; };
  await assert.rejects(captureVisualContext(snapshot()), { code: "VISUAL_LAYOUT_CHANGED" });
  state.onCapture = undefined; state.layout = layout();
  state.onDecode = () => { state.layout.fields[0].rect.x++; };
  await assert.rejects(captureVisualContext(snapshot()), { code: "VISUAL_LAYOUT_CHANGED" });
  assert.equal(state.bitmapClosed, true);
}));

test("cancellation before and during capture returns no image and removes listeners", async () => harness(async (state) => {
  const before = new AbortController(); before.abort();
  await assert.rejects(captureVisualContext(snapshot(), { signal: before.signal }), { code: "VISUAL_CANCELLED" });
  assert.equal(state.captured, 0);
  const during = new AbortController(); state.onCapture = () => during.abort();
  await assert.rejects(captureVisualContext(snapshot(), { signal: during.signal }), { code: "VISUAL_CANCELLED" });
  assert.equal(state.canvases.length, 0);
}));

test("missing activeTab permission has an actionable DOM fallback message", async () => harness(async (state) => {
  state.captureError = new Error("Either <all_urls> or activeTab permission is required");
  await assert.rejects(captureVisualContext(snapshot()), (error) => error.code === "VISUAL_PERMISSION" && /重新点击扩展图标/.test(error.message) && /文字识别/.test(error.message));
  assert.equal(state.canvases.length, 0);
}));

test("empty candidate sets and pinch-zoom refuse unsafe captures", async () => harness(async (state) => {
  state.layout.fields = [];
  await assert.rejects(captureVisualContext(snapshot()), { code: "VISUAL_EMPTY" });
  state.layout = layout(); state.layout.viewport.visualScale = 1.5;
  await assert.rejects(captureVisualContext(snapshot()), { code: "VISUAL_ZOOM" });
  assert.equal(state.captured, 0);
}));

test("canvas rendering rejects remote image URLs and mismatched image dimensions", async () => harness(async () => {
  await assert.rejects(renderVisualCapture("https://example.com/private.png", layout(), []), { code: "VISUAL_IMAGE" });
  const wrong = layout(); wrong.viewport.height = 800;
  await assert.rejects(renderVisualCapture(rawImage, wrong, []), { code: "VISUAL_SIZE" });
}));

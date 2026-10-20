import test from "node:test";
import assert from "node:assert/strict";
import { scanPage } from "../src/assistant/session.js";

function installChrome(t, { frames, rejected = [], pageTypes = {}, enumerationFailed = false, scanError, scriptResult }) {
  const old = globalThis.chrome;
  globalThis.chrome = {
    tabs: { get: async () => ({ url: "https://main.example/apply", title: "申请表" }) },
    webNavigation: { getAllFrames: async () => { if (enumerationFailed) throw new Error("unavailable"); return frames; } },
    scripting: { executeScript: async ({ target }) => {
      const id = target.frameIds[0];
      if (scanError && id === 0) throw scanError;
      if (rejected.includes(id)) throw new Error("Cannot access https://private.example/?token=secret");
      if (scriptResult) return scriptResult;
      return [{ documentId: `doc-${id}`, result: { pageType: pageTypes[id] || "form", fields: [{ fieldId: "f1", groupId: "g1", label: "姓名" }] } }];
    } }
  };
  t.after(() => { if (old === undefined) delete globalThis.chrome; else globalThis.chrome = old; });
}

test("scan records failed child frame IDs and origins without query tokens or raw errors", async (t) => {
  installChrome(t, { frames: [{ frameId: 0, url: "https://main.example/apply" }, { frameId: 2, url: "https://embedded.example:8443/form?token=secret#value" }, { frameId: 4, url: "about:blank" }], rejected: [2, 4] });
  const snapshot = await scanPage(7);
  assert.deepEqual(snapshot.coverage, { scanned: 1, total: 3, failed: 2, unknown: false });
  assert.deepEqual(snapshot.failedFrames.map(({ frameId, origin }) => ({ frameId, origin })), [{ frameId: 2, origin: "https://embedded.example:8443" }, { frameId: 4, origin: "" }]);
  assert.ok(!JSON.stringify(snapshot).includes("secret"));
  assert.equal(snapshot.fields[0].fieldId, "doc-0:f1");
});

test("a successfully granted child frame joins the preview with its own document identity", async (t) => {
  installChrome(t, { frames: [{ frameId: 0, url: "https://main.example/apply" }, { frameId: 2, url: "https://embedded.example/form" }], pageTypes: { 0: "unknown", 2: "application" } });
  const snapshot = await scanPage(7);
  assert.equal(snapshot.pageType, "application");
  assert.deepEqual(snapshot.failedFrames, []);
  assert.deepEqual(snapshot.fields.map((field) => field.fieldId), ["doc-0:f1", "doc-2:f1"]);
});

test("frame enumeration failure retains main page scan and unknown coverage", async (t) => {
  installChrome(t, { enumerationFailed: true });
  const snapshot = await scanPage(7);
  assert.deepEqual(snapshot.coverage, { scanned: 1, total: 1, failed: 0, unknown: true });
  assert.deepEqual(snapshot.failedFrames, []);
});

test("main frame permission failure offers only the bound site's origin without raw browser errors", async (t) => {
  installChrome(t, { frames: [{ frameId: 0, url: "https://main.example/apply" }], scanError: new Error("Cannot access contents of url https://private.example/?token=secret. Extension manifest must request permission to access this host.") });
  await assert.rejects(scanPage(7), (error) => {
    assert.equal(error.code, "PAGE_ACCESS_REQUIRED"); assert.equal(error.origin, "https://main.example"); assert.equal(error.tabId, 7);
    assert.match(error.message, /允许读取此站点/); assert.ok(!error.message.includes("secret"));
    return true;
  });
});

test("a scan script exception is not described as missing host permission", async (t) => {
  installChrome(t, { frames: [{ frameId: 0 }], scanError: new TypeError("Cannot read property at https://private.example/?token=secret") });
  await assert.rejects(scanPage(7), (error) => error.code === "PAGE_SCAN_FAILED" && !error.message.includes("secret") && !error.message.includes("允许"));
});

test("navigation during injection is reported separately from permissions", async (t) => {
  installChrome(t, { frames: [{ frameId: 0 }], scanError: new Error("No frame with id 0 in tab 7.") });
  await assert.rejects(scanPage(7), (error) => error.code === "PAGE_CHANGED" && /加载完成/.test(error.message));
});

test("missing browser document identity is distinguished from a scan failure", async (t) => {
  installChrome(t, { frames: [{ frameId: 0 }], scriptResult: [{ result: { fields: [] } }] });
  await assert.rejects(scanPage(7), (error) => error.code === "PAGE_DOCUMENT_UNAVAILABLE" && /更新浏览器/.test(error.message));
});

test("an invalid scan response cannot become an empty successful preview", async (t) => {
  installChrome(t, { frames: [{ frameId: 0 }], scriptResult: [{ documentId: "doc-0", result: {} }] });
  await assert.rejects(scanPage(7), (error) => error.code === "PAGE_SCAN_FAILED");
});

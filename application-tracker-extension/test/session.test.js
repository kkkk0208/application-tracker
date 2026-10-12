import test from "node:test";
import assert from "node:assert/strict";
import { scanPage } from "../src/assistant/session.js";

function installChrome(t, { frames, rejected = [], pageTypes = {}, enumerationFailed = false }) {
  const old = globalThis.chrome;
  globalThis.chrome = {
    tabs: { get: async () => ({ url: "https://main.example/apply", title: "申请表" }) },
    webNavigation: { getAllFrames: async () => { if (enumerationFailed) throw new Error("unavailable"); return frames; } },
    scripting: { executeScript: async ({ target }) => {
      const id = target.frameIds[0];
      if (rejected.includes(id)) throw new Error("Cannot access https://private.example/?token=secret");
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

test("main frame access failure still requires returning to the target website", async (t) => {
  installChrome(t, { frames: [{ frameId: 0, url: "https://main.example/apply" }], rejected: [0] });
  await assert.rejects(scanPage(7), /无法读取目标页面/);
});

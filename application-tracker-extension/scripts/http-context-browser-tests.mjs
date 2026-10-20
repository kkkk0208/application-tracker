// Exercise the real MV3 isolated world on non-localhost HTTP, not a main-world
// mock. Synthetic routes never contact a recruitment site or read user data.
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(tmpdir(), "application-http-test-"));
const extensionPath = path.join(temporary, "extension");
const fixtures = [
  { url: "http://bank-fixture.test/apply", secure: false },
  { url: "http://127.0.0.1:8765/apply", secure: true },
  { url: "https://secure-fixture.test/apply", secure: true }
];
const html = '<!doctype html><meta charset="utf-8"><title>HTTP fixture</title><form><label>姓名<input id="name"></label><label>开始时间<input id="start"></label><label>工作职责<textarea id="duties"></textarea></label><label>学历<select id="degree"><option value="">请选择</option><option>本科</option><option>硕士</option></select></label></form>';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let context;
let passed = 0;
try {
  await cp(path.join(root, "src"), path.join(extensionPath, "src"), { recursive: true });
  await cp(path.join(root, "vendor"), path.join(extensionPath, "vendor"), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  manifest.host_permissions = fixtures.map(({ url }) => new URL(url).origin + "/*");
  await writeFile(path.join(extensionPath, "manifest.json"), JSON.stringify(manifest));
  context = await playwright.chromium.launchPersistentContext(path.join(temporary, "profile"), {
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: process.platform === "win32" ? "chrome" : "chromium" }),
    headless: true, ignoreDefaultArgs: ["--disable-extensions"], args: ["--enable-unsafe-extension-debugging"]
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: extensionPath });
  await cdp.detach();
  const controller = await context.newPage();
  await controller.goto(`chrome-extension://${extensionId}/src/records/records.html`);
  await controller.evaluate(async () => (await import(chrome.runtime.getURL("src/storage.js"))).replaceAllRecords([]));
  const worker = context.serviceWorkers().find((item) => item.url().startsWith("chrome-extension://")) || await context.waitForEvent("serviceworker");
  await context.route(/https?:\/\/(bank-fixture\.test|127\.0\.0\.1:8765|secure-fixture\.test)\//, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  const getTabId = (url) => worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id, url);
  console.log(`Runtime: Chrome ${context.browser().version()}, real MV3 isolated worlds, disposable profile`);

  for (const fixture of fixtures) {
    const page = await context.newPage(); await page.goto(fixture.url);
    const tabId = await getTabId(fixture.url);
    const result = await controller.evaluate(async (tabId) => {
      const [{ result: capabilities }] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: () => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID, randomValues: typeof crypto.getRandomValues }) });
      const { scanPage, fieldAction, checkTarget, pageChanges, inspectOptions } = await import(chrome.runtime.getURL("src/assistant/session.js"));
      const snapshot = await scanPage(tabId);
      const inspected = await inspectOptions(snapshot, snapshot.fields.find((item) => item.label === "学历"));
      const field = snapshot.fields.find((item) => item.label === "姓名");
      const filled = await fieldAction(snapshot, field, "fill", { operationId: crypto.randomUUID(), value: "Fixture Applicant" });
      const undone = await fieldAction(snapshot, field, "undo", { operationId: crypto.randomUUID(), value: filled.before, expected: filled.after });
      const changes = await pageChanges(snapshot);
      const next = await scanPage(tabId);
      let staleRejected = false; try { await checkTarget(snapshot); } catch { staleRejected = true; }
      return { capabilities, fields: snapshot.fields.length, fill: filled.status, undo: undone.status, changes, inspected: inspected.status, optionTexts: inspected.options.map((option) => option.text),
        token: snapshot.frames[0].token, scanId: snapshot.frames[0].scanId, nextToken: next.frames[0].token, nextScanId: next.frames[0].scanId, staleRejected, next };
    }, tabId);
    assert.equal(result.capabilities.secure, fixture.secure);
    assert.equal(result.capabilities.uuid, fixture.secure ? "function" : "undefined");
    assert.equal(result.capabilities.randomValues, "function");
    assert.equal(result.fields, 4); assert.equal(result.fill, "verified"); assert.equal(result.undo, "verified");
    assert.equal(result.inspected, "inspected"); assert.ok(result.optionTexts.includes("本科") && result.optionTexts.includes("硕士"));
    assert.equal(await page.locator("#degree").inputValue(), "");
    assert.equal(await page.locator("#name").inputValue(), "");
    assert.equal(result.changes.added, 0); assert.deepEqual(result.changes.changed, []);
    assert.equal(result.token, result.nextToken); assert.notEqual(result.scanId, result.nextScanId);
    assert.ok([result.token, result.scanId, result.nextScanId].every((id) => uuid.test(id))); assert.equal(result.staleRejected, true);
    await page.locator("#name").fill("Manual correction");
    const manual = await controller.evaluate(async (snapshot) => {
      const { fieldAction } = await import(chrome.runtime.getURL("src/assistant/session.js"));
      return fieldAction(snapshot, snapshot.fields.find((item) => item.label === "姓名"), "fill", { operationId: crypto.randomUUID(), value: "Another answer" });
    }, result.next);
    assert.equal(manual.code, "USER_EDITED"); assert.equal(await page.locator("#name").inputValue(), "Manual correction");
    passed++; console.log(`PASS ${fixture.url}: scan, UUID v4, fill/undo, changes, stale snapshot and manual-edit protection`);
    if (!fixture.secure) {
      await page.locator("#name").fill("");
      await worker.evaluate(async (tabId) => {
        const tab = await chrome.tabs.get(tabId);
        await chrome.storage.local.set({ "applicationTracker.profile": { fullNameZh: "Fixture Applicant" }, "applicationTracker.aiSettings": { enabled: false } });
        await chrome.storage.session.set({ [`applicationTracker.assistant.target.${tab.windowId}`]: tabId });
      }, tabId);
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/assistant.html`);
      await panel.locator("#prepare").click();
      await panel.waitForFunction(() => !document.getElementById("fill").hidden && !document.getElementById("fill").disabled);
      assert.equal(await panel.locator(".question").count(), 4);
      assert.equal(await panel.locator(".question").filter({ hasText: "姓名" }).locator("[data-answer]").inputValue(), "Fixture Applicant");
      assert.equal(await panel.locator("#allowPageAccess").isVisible(), false);
      assert.equal(await page.locator("#name").inputValue(), "");
      passed++; console.log("PASS real side panel prepares an HTTP preview without writing or asking for additional access");
      await panel.close();
    }
    await page.close();
  }

  for (const fault of ["init", "discover", "describe", "arbitrary-name"]) {
    const page = await context.newPage(); const url = `http://bank-fixture.test/${fault}?token=private-fixture-token`;
    await page.goto(url); const tabId = await getTabId(url);
    await controller.evaluate(async ({ tabId, fault }) => chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: (fault) => {
      const fail = () => { const error = new TypeError("private-field-value https://private.example/?token=private-fixture-token"); if (fault === "arbitrary-name") error.name = "private-fixture-token"; throw error; };
      if (fault === "init" || fault === "arbitrary-name") crypto.getRandomValues = fail;
      if (fault === "discover") document.querySelectorAll = fail;
      if (fault === "describe") Object.defineProperty(document.getElementById("name"), "value", { get: fail });
    }, args: [fault] }), { tabId, fault });
    const result = await controller.evaluate(async (tabId) => {
      const { pageBridge } = await import(chrome.runtime.getURL("src/assistant/pageBridge.js"));
      const { scanPage, checkTarget, pageChanges, fieldAction } = await import(chrome.runtime.getURL("src/assistant/session.js"));
      const [{ result: bridge, documentId }] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: pageBridge, args: [{ action: "scan" }] });
      let session; try { await scanPage(tabId); } catch (error) { session = { code: error.code, message: error.message }; }
      let initialization;
      if (bridge.stage === "init") {
        const snapshot = { tabId, url: (await chrome.tabs.get(tabId)).url, frames: [{ frameId: 0, documentId, token: "absent", scanId: "absent" }] };
        initialization = [];
        for (const action of ["ping", "changes", "fill", "undo", "inspect-options"]) {
          const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: pageBridge, args: [{ action }] });
          initialization.push({ action, code: result?.code, stage: result?.stage });
        }
        for (const action of ["ping", "changes", "fill"]) {
          try {
            if (action === "ping") await checkTarget(snapshot);
            else if (action === "changes") await pageChanges(snapshot);
            else await fieldAction(snapshot, { documentId }, "fill", { value: "must not be written" });
          } catch (error) { initialization.push({ client: action, code: error.code }); }
        }
      }
      return { bridge, session, ...(initialization ? { initialization } : {}) };
    }, tabId);
    assert.deepEqual(Object.keys(result.bridge).sort(), ["code", "errorName", "secureContext", "stage", "status"]);
    assert.equal(result.bridge.code, "BRIDGE_EXCEPTION"); assert.equal(result.bridge.stage, fault === "arbitrary-name" ? "init" : fault);
    assert.equal(result.bridge.errorName, fault === "arbitrary-name" ? "Error" : "TypeError"); assert.equal(result.bridge.secureContext, false);
    assert.equal(result.session.code, "BRIDGE_EXCEPTION"); assert.match(result.session.message, /非安全页面/);
    assert.ok(!/private-|https?:|stack|field-value/.test(JSON.stringify(result)));
    if (result.initialization) assert.ok(result.initialization.every((entry) => entry.code === "BRIDGE_EXCEPTION" && (!entry.action || entry.stage === "init")));
    passed++; console.log(`PASS scan ${fault} diagnostic reports fixed categories without raw page/error contents`);
    await page.close();
  }
  for (const kind of ["discover", "describe"]) {
    const page = await context.newPage(); const url = `http://bank-fixture.test/change-${kind}`;
    await page.goto(url); const tabId = await getTabId(url);
    const result = await controller.evaluate(async ({ tabId, kind }) => {
      const { scanPage, pageChanges } = await import(chrome.runtime.getURL("src/assistant/session.js"));
      const snapshot = await scanPage(tabId);
      await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: (kind) => {
        const fail = () => { throw new TypeError("private-field-value"); };
        if (kind === "discover") { const field = document.createElement("input"); field.getClientRects = fail; document.body.append(field); }
        else Object.defineProperty(document.getElementById("name"), "value", { get: fail });
      }, args: [kind] });
      try { await pageChanges(snapshot); return { unexpectedSuccess: true }; }
      catch (error) { return { code: error.code, message: error.message }; }
    }, { tabId, kind });
    assert.equal(result.code, "BRIDGE_EXCEPTION"); assert.match(result.message, kind === "discover" ? /控件收集/ : /字段描述/);
    assert.ok(!result.message.includes("private-field-value"));
    passed++; console.log(`PASS changes ${kind} faults retain safe diagnostics instead of a generic navigation error`);
    await page.close();
  }
  {
    const page = await context.newPage(); const url = "http://bank-fixture.test/busy-and-stale";
    await page.goto(url); const tabId = await getTabId(url);
    const result = await controller.evaluate(async (tabId) => {
      const { pageBridge } = await import(chrome.runtime.getURL("src/assistant/pageBridge.js"));
      const { scanPage, pageChanges } = await import(chrome.runtime.getURL("src/assistant/session.js"));
      const snapshot = await scanPage(tabId); const frame = snapshot.frames[0];
      await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: () => { globalThis.__applicationAssistantV2.busy = true; } });
      const codes = [];
      for (const request of [{ action: "scan" }, { action: "changes", token: frame.token, scanId: frame.scanId, url: snapshot.url }]) {
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: pageBridge, args: [request] }); codes.push(result?.code);
      }
      await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: () => { globalThis.__applicationAssistantV2.busy = false; } });
      frame.token = "old-token";
      try { await pageChanges(snapshot); } catch (error) { codes.push(error.code); }
      return codes;
    }, tabId);
    assert.deepEqual(result, ["BRIDGE_BUSY", "BRIDGE_BUSY", "SNAPSHOT_STALE"]);
    passed++; console.log("PASS expected busy and stale read-only states have explicit result codes"); await page.close();
  }
  console.log(`HTTP context MV3 cases passed: ${passed}`);
} finally {
  await context?.close();
  const target = path.resolve(temporary);
  if (path.dirname(target) === path.resolve(tmpdir()) && path.basename(target).startsWith("application-http-test-")) await rm(target, { recursive: true, force: true, maxRetries: 3 });
}

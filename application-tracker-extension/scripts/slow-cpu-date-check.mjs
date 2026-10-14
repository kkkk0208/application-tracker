// Date panels on a slow CPU: Chrome DevTools CPU throttling (4x) on real component fixtures.
// Panels render asynchronously; date writes must wait for them instead of reading once.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pageBridge } from "../src/assistant/pageBridge.js";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const root = path.resolve(import.meta.dirname, "..");
const server = createServer(async (req, res) => {
  const file = path.resolve(root, "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  try { res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8"); res.end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) });
const rate = Number(process.env.CPU_THROTTLE || 4);
const cases = [["日期", "date", "2027-06-15"], ["月份", "month", "2027-08"], ["任职时间", "range", ["2027-06-01", "2027-08-31"]]];
let passed = 0; const failures = [];
try {
  for (const library of ["antd3", "antd5", "element"]) for (const [label, id, value] of cases) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 1200 } });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/test/fixtures/components/${library}.html`);
      await page.waitForFunction(() => window.fixtureReady === true);
      await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate });
      const snapshot = await page.evaluate(pageBridge, { action: "scan" });
      const field = snapshot.fields.find((item) => item.label === label);
      if (!field) throw new Error("field not found");
      const result = await page.evaluate(pageBridge, { action: "fill", token: snapshot.token, scanId: snapshot.scanId, url: snapshot.url, fieldId: field.fieldId, operationId: crypto.randomUUID(), value: Array.isArray(value) ? JSON.stringify(value) : value });
      if (result.status !== "verified") throw new Error(`${result.code}: ${result.reason}`);
      assert.deepEqual(await page.evaluate((id) => window.fixtureValues[id], id), value, "Framework date state must match the requested calendar date");
      const undone = await page.evaluate(pageBridge, { action: "undo", token: snapshot.token, scanId: snapshot.scanId, url: snapshot.url, fieldId: field.fieldId, operationId: crypto.randomUUID(), value: result.before, expected: result.after });
      assert.equal(undone.status, "verified", JSON.stringify(undone));
      const after = await page.evaluate((id) => window.fixtureValues[id], id);
      assert.ok(after == null || after === "" || Array.isArray(after) && !after.length, "Slow CPU undo must clear the real framework value");
      passed++; console.log(`PASS ${library} ${label} at ${rate}x CPU`);
    } catch (error) { failures.push(`${library} ${label}`); console.log(`FAIL ${library} ${label} at ${rate}x CPU: ${error.message}`); }
    finally { await context.close(); }
  }
} finally { await browser.close(); server.close(); }
console.log(`Slow CPU date cases passed: ${passed}; failed: ${failures.length}`);
if (failures.length) process.exitCode = 1;

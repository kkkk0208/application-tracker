// Machine-independent guard: scan and change checks must grow roughly linearly with field count.
// The 2026-10-14 snapshot grew ~25x from 60 to 300 fields (quadratic repeated-block detection).
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pageBridge } from "../src/assistant/pageBridge.js";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<!doctype html><html><head><style>.row{display:flex;gap:16px}.row>div{flex:1}</style></head><body><main id="fixture"></main></body></html>'); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) });
const layouts = {
  "form-group": (n) => '<h2>虚构测试资料</h2>' + Array.from({ length: n }, (_u, i) => `<div class="form-group"><label for="f-${i}">测试字段${i}</label><input id="f-${i}"></div>`).join(""),
  "two-column rows": (n) => '<h3>分区</h3>' + Array.from({ length: n / 2 }, (_u, i) => `<div class="row"><div class="form-item"><label>题目${i}a<input></label></div><div class="form-item"><label>题目${i}b<select><option value="">请选择</option><option>是</option></select></label></div></div>`).join("")
};
const limit = Number(process.env.SCALING_LIMIT || 12);
let failed = false;
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const median = async (fn) => { const samples = []; for (let i = 0; i < 5; i++) { const start = Date.now(); await fn(); samples.push(Date.now() - start); } return samples.sort((a, b) => a - b)[2]; };
  for (const [name, make] of Object.entries(layouts)) {
    const timing = {};
    for (const count of [60, 300]) {
      await page.locator("#fixture").evaluate((node, html) => { node.innerHTML = html; }, make(count));
      await page.evaluate(pageBridge, { action: "scan" });
      const scan = await median(() => page.evaluate(pageBridge, { action: "scan" }));
      const snapshot = await page.evaluate(pageBridge, { action: "scan" });
      const changes = await median(() => page.evaluate(pageBridge, { action: "changes", token: snapshot.token, scanId: snapshot.scanId, url: snapshot.url }));
      timing[count] = { scan, changes };
    }
    const ratio = Math.max(timing[300].scan, 1) / Math.max(timing[60].scan, 1);
    const changesRatio = Math.max(timing[300].changes, 1) / Math.max(timing[60].changes, 1);
    const ok = ratio <= limit && changesRatio <= limit;
    failed ||= !ok;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: scan 60→300 ${timing[60].scan}ms→${timing[300].scan}ms (x${ratio.toFixed(1)}), changes ${timing[60].changes}ms→${timing[300].changes}ms (x${changesRatio.toFixed(1)}), limit x${limit}`);
  }
} finally { await browser.close(); server.close(); }
if (failed) process.exitCode = 1;

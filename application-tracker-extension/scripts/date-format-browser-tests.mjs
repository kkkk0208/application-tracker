// Regression cases for date formats taken from dateFmt, data-date-format or placeholder text.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pageBridge } from "../src/assistant/pageBridge.js";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<!doctype html><html><head><title>Date format fixture</title></head><body><main id="fixture"></main></body></html>'); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) });
const page = await browser.newPage();
let passed = 0;
const failures = [];
async function fixture(html) {
  await page.goto(origin);
  await page.locator("#fixture").evaluate((node, source) => { node.innerHTML = source; }, html);
  return page.evaluate(pageBridge, { action: "scan" });
}
const fill = (s, field, value) => page.evaluate(pageBridge, { action: "fill", token: s.token, scanId: s.scanId, url: s.url, fieldId: field.fieldId, operationId: crypto.randomUUID(), value });
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error.message}`); }
}
try {
  for (const value of ["2020.09", "2020-09"]) {
    await check(`My97 dateFmt yyyy.MM accepts ${value} and verifies 2020.09`, async () => {
      const s = await fixture(`<label>入学时间<input class="Wdate" onclick="WdatePicker({dateFmt:'yyyy.MM'})"></label>`);
      assert.equal(s.fields[0].dateFormat, "YYYY.MM");
      const result = await fill(s, s.fields[0], value);
      assert.equal(result.status, "verified", JSON.stringify(result));
      assert.equal(await page.locator("input").inputValue(), "2020.09");
    });
  }
  for (const [placeholder, value, expected] of [["入学时间(YYYY-MM)", "2020-09", "2020-09"], ["yyyy-mm-dd", "2020-09-15", "2020-09-15"], ["Start Date (YYYY-MM)", "2020-09", "2020-09"]]) {
    await check(`placeholder ${placeholder} is a format hint, never written into the field`, async () => {
      const s = await fixture(`<div class="el-form-item"><label class="el-form-item__label">入学时间</label><div class="el-date-editor el-input"><input class="el-input__inner" placeholder="${placeholder}"></div></div>`);
      const result = await fill(s, s.fields[0], value);
      assert.equal(result.status, "verified", JSON.stringify(result));
      assert.equal(await page.locator("input").inputValue(), expected);
    });
  }
} finally { await browser.close(); server.close(); }
console.log(`Date format browser cases passed: ${passed}; failed: ${failures.length}`);
if (failures.length) process.exitCode = 1;

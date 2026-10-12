import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pageBridge } from "../src/assistant/pageBridge.js";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const root = path.resolve(import.meta.dirname, "..");
const selectedLibrary = process.argv.find((arg) => arg.startsWith("--library="))?.split("=")[1];
const selectedCase = process.argv.find((arg) => arg.startsWith("--case="))?.split("=")[1];
const scanOnly = process.argv.includes("--scan");
const debug = process.argv.includes("--debug");
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = path.resolve(root, "." + pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const types = { ".js": "text/javascript", ".css": "text/css", ".woff": "font/woff", ".ttf": "font/ttf" };
    res.setHeader("Content-Type", types[path.extname(file)] || "text/html; charset=utf-8");
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let passed = 0;
const failures = [];
try {
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) });
  const context = await browser.newContext({ viewport: { width: 1366, height: 1200 } });
  await context.route("**/*", (route) => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  let pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  async function fixture(library) {
    pageErrors = [];
    await page.goto(`${origin}/test/fixtures/components/${library}.html`);
    await page.waitForFunction(() => window.fixtureReady === true);
    assert.deepEqual(pageErrors, [], "The actual component library must initialize without errors");
    return page.evaluate(pageBridge, { action: "scan" });
  }
  const fieldFor = (snapshot, label) => {
    const matches = snapshot.fields.filter((field) => field.label === label);
    assert.equal(matches.length, 1, `Expected one ${label} control, got ${JSON.stringify(snapshot.fields.map(({ label, kind, supported }) => ({ label, kind, supported })))}`);
    assert.equal(matches[0].supported, true, `${label}: ${matches[0].reason}`);
    return matches[0];
  };
  const outstanding = new Set();
  function tracked(pending) {
    outstanding.add(pending);
    pending.finally(() => outstanding.delete(pending)).catch(() => {});
    return pending;
  }
  const action = (snapshot, field, value, extra = {}) => tracked(page.evaluate(pageBridge, { action: "fill", token: snapshot.token, scanId: snapshot.scanId, url: snapshot.url, fieldId: field.fieldId, operationId: crypto.randomUUID(), value, ...extra }));
  const inspect = (snapshot, field, extra = {}) => tracked(page.evaluate(pageBridge, { action: "inspect-options", token: snapshot.token, scanId: snapshot.scanId, url: snapshot.url, fieldId: field.fieldId, ...extra }));
  const stateValue = (id) => page.evaluate((key) => window.fixtureValues[key], id);
  const menus = '.ant-select-dropdown:visible, .ant-cascader-menus:visible, .ant-picker-dropdown:visible, .ant-calendar-picker-container:visible, .el-select-dropdown:visible, .el-cascader__dropdown:visible, .el-picker-panel:visible';
  const menusClosed = async () => assert.equal(await page.locator(menus).count(), 0, "Opened component menus must close again");
  const encoded = (value) => Array.isArray(value) ? JSON.stringify(value) : value;
  const normalizedEmpty = (value) => value == null || value === "" || (Array.isArray(value) && value.length === 0);
  async function check(library, name, fn) {
    if (selectedCase && !name.includes(selectedCase)) return;
    try { await fn(); passed++; console.log(`PASS ${library}: ${name}`); }
    catch (error) {
      const message = `${library}: ${name}: ${error.message}`;
      failures.push(message); console.error(`FAIL ${message}`);
      if (debug) console.log(JSON.stringify(await page.evaluate(() => ({
        values: window.fixtureValues,
        inputs: [...document.querySelectorAll("input")].map((input) => ({ value: input.value, placeholder: input.placeholder, className: input.className })),
        menus: [...document.querySelectorAll(".ant-select-dropdown,.ant-cascader-menus,.ant-picker-dropdown,.ant-calendar-picker-container,.el-select-dropdown,.el-cascader__dropdown,.el-picker-panel")].filter((element) => element.getClientRects().length).map((element) => element.outerHTML.slice(0, 18000))
      })), null, 2));
    }
    finally { await Promise.allSettled([...outstanding]); }
  }

  const controls = [
    { id: "degree", label: "学历", kind: "custom-select", value: "硕士" },
    { id: "school", label: "学校", kind: "custom-select", value: "星海大学" },
    { id: "location", label: "所在地", kind: "cascader", value: ["广东省", "深圳市", "南山区"] },
    { id: "date", label: "日期", kind: "date", value: "2027-06-15" },
    { id: "month", label: "月份", kind: "date", value: "2027-08" },
    { id: "range", label: "任职时间", kind: "date", value: ["2027-06-01", "2027-08-31"] },
    { id: "gender", label: "性别", kind: "radio", value: "女" },
    { id: "languages", label: "语言", kind: "checkboxes", value: ["中文", "英语"] }
  ];
  for (const library of ["antd3", "antd5", "element"].filter((value) => !selectedLibrary || selectedLibrary === value)) {
    if (scanOnly) {
      const snapshot = await fixture(library);
      console.log(JSON.stringify({ library, fields: snapshot.fields }, null, 2));
      continue;
    }
    for (const control of controls) {
      await check(library, `${control.id} opens, selects, retains and ${control.kind === "radio" ? "reports unavailable empty undo" : "undoes"}`, async () => {
        const snapshot = await fixture(library);
        const field = fieldFor(snapshot, control.label);
        assert.equal(field.kind, control.kind);
        const result = await action(snapshot, field, encoded(control.value));
        assert.equal(result.status, "verified", JSON.stringify(result));
        assert.deepEqual(await stateValue(control.id), control.value, "Framework state must retain the chosen value");
        await menusClosed();
        const undo = await action(snapshot, field, result.before, { action: "undo", expected: result.after });
        if (control.kind === "radio") {
          // These real controlled groups expose no public clear action. A DOM
          // checked mutation alone would falsely claim success over React/Vue.
          assert.equal(undo.code, "UNDO_UNSUPPORTED", JSON.stringify(undo));
          assert.ok(undo.reason);
          assert.deepEqual(await stateValue(control.id), control.value, "An unavailable undo must preserve framework state");
          const selectedLabels = await page.locator(`[data-fixture-field="${control.id}"] input:checked`).evaluateAll((nodes) => nodes.map((node) => node.closest("label").innerText.trim()));
          assert.deepEqual(selectedLabels, [control.value], "An unavailable undo must also preserve the selected DOM control");
        } else {
          assert.equal(undo.status, "verified", JSON.stringify(undo));
          assert.ok(normalizedEmpty(await stateValue(control.id)), "Undo must clear both framework state and displayed value");
        }
        await menusClosed();
      });
    }
    for (const control of controls.filter((control) => ["degree", "school"].includes(control.id))) {
      await check(library, `${control.id} inspection restores closed menu and search text`, async () => {
        const snapshot = await fixture(library);
        const field = fieldFor(snapshot, control.label);
        const result = await inspect(snapshot, field, control.id === "school" ? { query: "星海" } : {});
        assert.equal(result.status, "inspected", JSON.stringify(result));
        assert.equal(result.restored, true, JSON.stringify(result));
        assert.ok(result.options.some((option) => option.text === control.value));
        assert.ok(normalizedEmpty(await stateValue(control.id)));
        await menusClosed();
        const searchValues = await page.locator(`[data-fixture-field="${control.id}"] input:not([readonly])`).evaluateAll((nodes) => nodes.map((node) => node.value));
        assert.ok(searchValues.every((value) => value === ""), "Inspection must restore the original empty search query");
      });
    }
    await check(library, "degree manual choice during option loading stops automation", async () => {
      const snapshot = await fixture(library);
      const pending = action(snapshot, fieldFor(snapshot, "学历"), "硕士");
      const option = page.locator(".ant-select-dropdown-menu-item:visible, .ant-select-item-option:visible, .el-select-dropdown__item:visible").filter({ hasText: /^本科$/ }).first();
      await option.click({ force: true });
      const result = await pending;
      assert.equal(result.code, "USER_EDITED", JSON.stringify(result));
      assert.equal(await stateValue("degree"), "本科");
    });
    await check(library, "location manual path choice stops automation", async () => {
      const snapshot = await fixture(library);
      const pending = action(snapshot, fieldFor(snapshot, "所在地"), JSON.stringify(["广东省", "深圳市", "南山区"]));
      const options = () => page.locator(".ant-cascader-menu-item:visible, .el-cascader-node:visible");
      await options().filter({ hasText: /^广东省$/ }).first().click();
      const result = await pending;
      assert.equal(result.code, "USER_EDITED", JSON.stringify(result));
      await options().filter({ hasText: /^广州市$/ }).first().click();
      await options().filter({ hasText: /^天河区$/ }).first().click();
      assert.deepEqual(await stateValue("location"), ["广东省", "广州市", "天河区"]);
    });
    await check(library, "date manual clear during verification is preserved", async () => {
      const snapshot = await fixture(library);
      const pending = action(snapshot, fieldFor(snapshot, "日期"), "2027-06-15");
      await page.waitForFunction(() => window.fixtureValues.date === "2027-06-15");
      const block = page.locator('[data-fixture-field="date"]');
      await block.locator(".ant-calendar-picker, .ant-picker, .el-date-editor").first().hover();
      await block.locator(".ant-calendar-picker-clear, .ant-picker-clear, .el-icon-circle-close").first().click();
      const result = await pending;
      assert.equal(result.code, "USER_EDITED", JSON.stringify(result));
      assert.ok(normalizedEmpty(await stateValue("date")), "The user's manual clear must remain intact");
    });
    await check(library, "school manual search during inspection is preserved", async () => {
      const snapshot = await fixture(library);
      const pending = inspect(snapshot, fieldFor(snapshot, "学校"), { query: "星海" });
      const search = page.locator('[data-fixture-field="school"] input:not([readonly])').first();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-fixture-field="school"] input')].some((input) => input.value === "星海"));
      await search.fill("用户自己搜索");
      const result = await pending;
      assert.equal(result.code, "USER_EDITED", JSON.stringify(result));
      assert.equal(await search.inputValue(), "用户自己搜索");
      assert.ok(normalizedEmpty(await stateValue("school")));
    });
  }

  if (!selectedLibrary || selectedLibrary === "my97") {
    if (scanOnly) console.log(JSON.stringify({ library: "my97", fields: (await fixture("my97")).fields }, null, 2));
    else {
      for (const control of [
        { id: "date", label: "日期", value: "2027-06-15", expected: "2027-06-15" },
        { id: "month", label: "月份", value: "2027-08", expected: "2027-08" },
        { id: "chineseMonth", label: "中文月份", value: "2027-08", expected: "2027年08月" }
      ]) {
        await check("my97", `${control.id} formats, retains and undoes`, async () => {
          const snapshot = await fixture("my97");
          const field = fieldFor(snapshot, control.label);
          assert.equal(field.adapter, "my97-date");
          const result = await action(snapshot, field, control.value);
          assert.equal(result.status, "verified", JSON.stringify(result));
          assert.equal(await stateValue(control.id), control.expected);
          const undo = await action(snapshot, field, "", { action: "undo", expected: result.after });
          assert.equal(undo.status, "verified", JSON.stringify(undo));
          assert.equal(await stateValue(control.id), "");
        });
      }
      await check("my97", "manual change during verification is preserved", async () => {
        const snapshot = await fixture("my97");
        const field = fieldFor(snapshot, "月份");
        const pending = action(snapshot, field, "2027-08");
        await page.waitForFunction(() => document.getElementById("month").value === "2027-08");
        await page.locator("#month").fill("2028-02");
        const result = await pending;
        assert.equal(result.code, "USER_EDITED", JSON.stringify(result));
        assert.equal(await stateValue("month"), "2028-02");
      });
    }
  }
  if (!scanOnly) console.log(`Component browser cases passed: ${passed}; failed: ${failures.length}`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
if (failures.length) process.exitCode = 1;

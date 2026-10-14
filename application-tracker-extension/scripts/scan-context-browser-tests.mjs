// Isolated synthetic regressions for question boundaries, context and consent.
// BRIDGE_SOURCE can point to an older snapshot to reproduce the pre-fix behavior.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = process.env.BRIDGE_SOURCE || path.resolve(import.meta.dirname, "../src/assistant/pageBridge.js");
const { pageBridge } = await import(pathToFileURL(path.resolve(source)).href);
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end('<!doctype html><html><head><title>Scan context fixture</title><style>[data-option]{display:inline-block;margin:8px;padding:8px;cursor:pointer}.form-row{display:flex;gap:16px}[role="combobox"]{min-height:28px;min-width:180px} [role="option"]{padding:6px}</style></head><body><main id="fixture"></main></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) });
const page = await browser.newPage();
const origin = `http://127.0.0.1:${server.address().port}`;
const failures = [];
let passed = 0;
const only = process.env.SCAN_CASES?.split(",");
async function check(code, name, fn) {
  if (only && !only.includes(code)) return;
  try { await fn(); passed++; console.log(`PASS ${code}: ${name}`); }
  catch (error) { failures.push(`${code}: ${name}`); console.log(`FAIL ${code}: ${name}: ${error.message}`); }
}
async function fixture(html) {
  await page.goto(origin);
  await page.locator("#fixture").evaluate((node, html) => { node.innerHTML = html; }, html);
  return page.evaluate(pageBridge, { action: "scan" });
}
const group = (question, options = ["男", "女"], attr = "") => `<fieldset ${attr}><legend>${question}</legend><div role="radiogroup">${options.map((label) => `<div data-option role="radio" aria-checked="false"><span>${label}</span></div>`).join("")}</div></fieldset>`;
const nativeGroup = (question, options = ["男", "女"]) => `<fieldset><legend>${question}</legend><div role="radiogroup">${options.map((label, index) => `<label><input type="radio" name="native-fixture" value="${index}">${label}</label>`).join("")}</div></fieldset>`;
const inspect = (snapshot, field) => page.evaluate(pageBridge, { action: "inspect-options", token: snapshot.token, scanId: snapshot.scanId, url: snapshot.url, fieldId: field.fieldId });
try {
  await check("A", "fieldset legend names a role choice nested in a group", async () => {
    const snapshot = await fixture(group("性别"));
    assert.equal(snapshot.fields.length, 1);
    assert.equal(snapshot.fields[0].label, "性别");
    assert.equal(snapshot.fields[0].supported, true);
  });
  await check("A", "native radios use the outer legend rather than an option label", async () => {
    const snapshot = await fixture(nativeGroup("性别"));
    assert.equal(snapshot.fields.length, 1);
    assert.equal(snapshot.fields[0].label, "性别");
    assert.equal(snapshot.fields[0].supported, true);
  });
  await check("A", "submit buttons before a privacy group cannot disguise consent", async () => {
    const snapshot = await fixture('<form><div><button>提交</button><button>继续</button></div>' + group("同意隐私条款", ["同意", "不同意"]) + '</form>');
    assert.equal(snapshot.fields.length, 1);
    assert.equal(snapshot.fields[0].label, "同意隐私条款");
    assert.equal(snapshot.fields[0].supported, false);
  });
  await check("A", "explicit generic ARIA question cannot hide agreement options", async () => {
    const snapshot = await fixture('<div role="radiogroup" aria-label="条款选择"><div data-option role="radio" aria-checked="false">I agree</div><div data-option role="radio" aria-checked="false">I disagree</div></div>');
    assert.equal(snapshot.fields.length, 1);
    assert.equal(snapshot.fields[0].supported, false, JSON.stringify(snapshot.fields[0]));
  });
  await check("A", "acceptance of terms is manual for a single native checkbox", async () => {
    const snapshot = await fixture('<label><input type="checkbox">我已阅读并接受使用条款</label>');
    assert.equal(snapshot.fields.length, 1);
    assert.equal(snapshot.fields[0].supported, false, JSON.stringify(snapshot.fields[0]));
  });
  await check("A", "an education fieldset with several questions lends no question legend", async () => {
    const snapshot = await fixture('<fieldset><legend>教育经历</legend><label>学校名称<input id="school"></label><div role="radiogroup"><div data-option role="radio" aria-checked="false">本科</div><div data-option role="radio" aria-checked="false">硕士</div></div></fieldset>');
    const choice = snapshot.fields.find((field) => field.kind === "choice");
    assert.ok(choice);
    assert.notEqual(choice.label, "教育经历");
  });
  await check("A", "a broad ARIA education fieldset is not the question of a nested choice", async () => {
    const snapshot = await fixture('<fieldset aria-label="教育经历"><legend>教育经历</legend><label>学校名称<input id="school"></label><div role="radiogroup"><div data-option role="radio" aria-checked="false">本科</div><div data-option role="radio" aria-checked="false">硕士</div></div></fieldset>');
    const choice = snapshot.fields.find((field) => field.kind === "choice");
    assert.ok(choice);
    assert.notEqual(choice.label, "教育经历");
  });
  await check("I", "one form can contain several independently named sections", async () => {
    const snapshot = await fixture('<form><h2>基本信息</h2><label>姓名<input id="name"></label><h2>教育经历</h2><label>学校名称<input id="school"></label></form>');
    assert.deepEqual(snapshot.fields.map((field) => field.section), ["基本信息", "教育经历"]);
    assert.equal(snapshot.fields[0].entityHint, "self");
    assert.equal(snapshot.fields[1].entityHint, "education");
  });
  await check("J", "two different rows inside one education block stay in one group", async () => {
    const snapshot = await fixture('<fieldset><legend>教育经历</legend><div class="form-row"><label>学校名称<input></label><label>专业<input></label></div><div class="form-row"><label>学历<input></label><label>毕业时间<input></label></div></fieldset>');
    assert.equal(snapshot.fields.length, 4);
    assert.equal(new Set(snapshot.fields.map((field) => field.groupId)).size, 1, JSON.stringify(snapshot.fields.map(({ label, groupId, groupIndex }) => ({ label, groupId, groupIndex }))));
    assert.deepEqual(snapshot.fields.map((field) => field.groupIndex), [1, 1, 1, 1]);
  });
  await check("J", "two repeated education blocks retain distinct instance indices", async () => {
    const item = '<div class="education-item"><label>学校名称<input></label><label>专业<input></label><label>学历<input></label></div>';
    const snapshot = await fixture(`<section><h2>教育经历</h2>${item}${item}</section>`);
    assert.equal(snapshot.fields.length, 6);
    assert.deepEqual(snapshot.fields.map((field) => field.groupIndex), [1, 1, 1, 2, 2, 2]);
    assert.equal(new Set(snapshot.fields.map((field) => field.groupId)).size, 2);
  });
  await check("P", "a clearly named adjustment preference is a business question", async () => {
    const snapshot = await fixture(group("是否同意调剂", ["是", "否"]).replace('role="radiogroup"', 'role="radiogroup" aria-label="是否同意调剂"'));
    assert.equal(snapshot.fields[0].supported, true, JSON.stringify(snapshot.fields[0]));
  });
  await check("P", "privacy or authorization stays manual even when adjustment is mentioned", async () => {
    for (const title of ["是否同意调剂并授权使用个人信息", "是否同意出差并确认隐私条款", "本人承诺以上信息真实"]) {
      const snapshot = await fixture(group(title, ["是", "否"]));
      assert.equal(snapshot.fields[0].supported, false, title);
    }
  });
  await check("K", "unadapted readonly dropdown tells the user to choose manually", async () => {
    const snapshot = await fixture('<div class="layui-form-item"><label class="layui-form-label">学历</label><select hidden><option>本科</option></select><div class="layui-form-select"><input readonly placeholder="请选择"></div></div>');
    assert.equal(snapshot.fields.length, 1);
    assert.equal(snapshot.fields[0].supported, false);
    assert.match(snapshot.fields[0].reason, /下拉.*(?:不支持|手动)/);
  });
  await check("M", "a permanent unrelated listbox cannot be the dropdown menu", async () => {
    const snapshot = await fixture('<ul role="listbox" id="permanent"><li role="option">常驻项目</li></ul><div role="combobox" aria-label="学历" aria-expanded="false" id="degree"><span class="selected-value"></span></div><ul role="listbox" id="degrees" hidden><li role="option">本科</li><li role="option">硕士</li></ul>');
    await page.evaluate(() => {
      const control = document.querySelector("#degree");
      const menu = document.querySelector("#degrees");
      control.onclick = () => { menu.hidden = !menu.hidden; control.setAttribute("aria-expanded", String(!menu.hidden)); };
      document.addEventListener("keydown", (event) => { if (event.key === "Escape") { menu.hidden = true; control.setAttribute("aria-expanded", "false"); } });
    });
    const result = await inspect(snapshot, snapshot.fields[0]);
    assert.equal(result.status, "inspected", JSON.stringify(result));
    assert.deepEqual(result.field.options.map((option) => option.text), ["本科", "硕士"]);
    assert.equal(await page.locator("#permanent").isVisible(), true);
    assert.equal(await page.locator("#degrees").isVisible(), false);
  });
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(`Scan context cases passed: ${passed}; failed: ${failures.length}`);
if (failures.length) process.exitCode = 1;

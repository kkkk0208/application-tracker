import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pageBridge } from "../src/assistant/pageBridge.js";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end('<!doctype html><html><head><title>Choice control fixture</title><style>[data-option]{display:inline-block;margin:8px;padding:12px;cursor:pointer}[aria-checked="true"],.selected{background:#aee}</style></head><body><main id="fixture"></main></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) });
const page = await browser.newPage();
let passed = 0;
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

async function fixture(html) {
  await page.goto(origin);
  await page.locator("#fixture").evaluate((node, source) => { node.innerHTML = source; }, html);
  await page.evaluate(() => {
    window.programClicks = 0;
    window.trustedClicks = 0;
    for (const member of document.querySelectorAll("[data-option]")) member.addEventListener("click", (event) => {
      if (event.isTrusted) window.trustedClicks++; else window.programClicks++;
      if (member.getAttribute("aria-disabled") === "true") return;
      const group = member.closest("[data-choice-group]");
      if (!group) return;
      const wasSelected = member.getAttribute("aria-checked") === "true" || member.classList.contains("selected");
      if (group.dataset.multiple !== "true") for (const peer of group.querySelectorAll("[data-option]")) {
        peer.setAttribute("aria-checked", "false"); peer.classList.remove("selected");
      }
      if (group.dataset.classState === "true") member.classList.toggle("selected", !wasSelected);
      else member.setAttribute("aria-checked", String(!wasSelected));
    });
  });
  return page.evaluate(pageBridge, { action: "scan" });
}
const action = (snapshot, field, value, extra = {}) => page.evaluate(pageBridge, { action: "fill", token: snapshot.token, scanId: snapshot.scanId, url: snapshot.url, fieldId: field.fieldId, operationId: crypto.randomUUID(), value, ...extra });
const undo = (snapshot, field, result) => action(snapshot, field, "", { action: "undo", expected: result.after });
const selected = () => page.locator('[data-option][aria-checked="true"], [data-option].selected').allTextContents();
const group = (kind, title = "性别", values = ["男", "女"]) => `<fieldset><legend>${title}</legend><div data-choice-group ${kind === "radio" ? 'role="radiogroup"' : kind === "checkbox" ? 'role="group" data-multiple="true"' : 'data-class-state="true"'}>${values.map((text, index) => `<div id="option-${index}" data-option ${kind === "div" ? 'class="custom-choice" tabindex="0"' : `role="${kind}" aria-checked="false"`}><span>${text}</span></div>`).join("")}</div></fieldset>`;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

try {
  await check("role radio uses the group question and synonym matching, verifies and undoes a toggleable fixture", async () => {
    const snapshot = await fixture(group("radio"));
    assert.equal(snapshot.fields.length, 1);
    const field = snapshot.fields[0];
    assert.equal(field.kind, "choice"); assert.equal(field.label, "性别");
    assert.equal(field.value, ""); assert.equal(field.supported, true);
    assert.deepEqual(field.options.map((option) => option.text), ["男", "女"]);
    const result = await action(snapshot, field, "Male");
    assert.equal(result.status, "verified"); assert.equal(result.after, "男");
    assert.deepEqual(await selected(), ["男"]);
    assert.equal((await undo(snapshot, field, result)).status, "verified");
    assert.deepEqual(await selected(), []);
    assert.equal((await page.evaluate(pageBridge, { action: "scan" })).fields[0].value, "");
  });

  await check("role checkboxes verify the complete selected set and undo every selected member", async () => {
    const snapshot = await fixture(group("checkbox", "语言能力", ["中文", "English", "法语"]));
    const field = snapshot.fields[0];
    assert.equal(snapshot.fields.length, 1); assert.equal(field.label, "语言能力");
    assert.equal(field.kind, "choice"); assert.equal(field.constraints.multiple, true);
    const result = await action(snapshot, field, JSON.stringify(["中文", "English"]));
    assert.equal(result.status, "verified"); assert.deepEqual(JSON.parse(result.after), ["中文", "English"]);
    assert.deepEqual(await selected(), ["中文", "English"]);
    assert.equal((await undo(snapshot, field, result)).status, "verified");
    assert.deepEqual(await selected(), []);
  });

  await check("same-class clickable div options group without native inputs or ARIA roles", async () => {
    const snapshot = await fixture(group("div", "工作城市", ["深圳", "广州"]));
    const field = snapshot.fields[0];
    assert.equal(snapshot.fields.length, 1); assert.equal(field.kind, "choice");
    assert.equal(field.label, "工作城市"); assert.equal(field.constraints.multiple, false);
    const result = await action(snapshot, field, "深圳");
    assert.equal(result.status, "verified"); assert.deepEqual(await selected(), ["深圳"]);
    assert.equal((await undo(snapshot, field, result)).status, "verified");
    assert.deepEqual(await selected(), []);
  });

  await check("choice groups remain separate and read checked classes without replacing existing answers", async () => {
    const first = group("div", "工作城市", ["深圳", "广州"]).replace('class="custom-choice"', 'class="custom-choice active"');
    const snapshot = await fixture(first + group("radio", "性别", ["男", "女"]).replaceAll('id="option-', 'id="gender-'));
    assert.deepEqual(snapshot.fields.map((field) => field.label), ["工作城市", "性别"]);
    assert.equal(snapshot.fields[0].value, "深圳");
    assert.equal((await action(snapshot, snapshot.fields[0], "广州")).status, "skipped");
    assert.equal(await page.evaluate(() => window.programClicks), 0);
    for (const state of ["is-checked", "selected", "checked", "on"]) {
      await page.locator("#option-0").evaluate((node, state) => { node.className = `custom-choice ${state}`; }, state);
      assert.equal((await page.evaluate(pageBridge, { action: "scan" })).fields[0].value, "深圳");
    }
  });

  await check("a trusted click on another radio option's child stops verification and preserves the user's selection", async () => {
    const snapshot = await fixture(group("radio"));
    const pending = action(snapshot, snapshot.fields[0], "男");
    await page.waitForFunction(() => window.programClicks === 1);
    await page.locator("#option-1 span").click();
    const result = await pending;
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.equal(result.code, "USER_EDITED");
    assert.deepEqual(await selected(), ["女"]);
    assert.equal(await page.evaluate(() => window.trustedClicks), 1);
    assert.equal(await page.evaluate(() => window.programClicks), 1);
  });

  await check("a trusted checkbox edit stops the pending operation and retains the manual choice", async () => {
    const snapshot = await fixture(group("checkbox", "语言能力", ["中文", "English", "法语"]));
    const pending = action(snapshot, snapshot.fields[0], JSON.stringify(["中文", "English"]));
    await page.waitForFunction(() => window.programClicks >= 1);
    await page.locator("#option-2 span").click();
    const result = await pending;
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.equal(result.code, "USER_EDITED");
    assert.ok((await selected()).includes("法语"));
    assert.equal(await page.evaluate(() => window.trustedClicks), 1);
  });

  await check("default submit buttons, their child spans and consent choices are never clicked", async () => {
    const snapshot = await fixture('<form id="unsafe-form"><div><button class="custom-choice"><span class="option">提交</span></button><button class="custom-choice"><span class="option">继续</span></button></div>' + group("checkbox", "同意隐私条款", ["同意", "不同意"]) + '</form>');
    await page.evaluate(() => { window.submissions = 0; document.getElementById("unsafe-form").onsubmit = (event) => { event.preventDefault(); window.submissions++; }; });
    assert.equal(snapshot.fields.length, 1);
    assert.equal(snapshot.fields[0].label, "同意隐私条款");
    assert.equal(snapshot.fields[0].supported, false);
    const result = await action(snapshot, snapshot.fields[0], '["同意"]');
    assert.notEqual(result.status, "verified");
    assert.equal(await page.evaluate(() => window.submissions), 0);
    assert.equal(await page.evaluate(() => window.programClicks), 0);
    assert.deepEqual(await selected(), []);
  });

  await check("disabled custom choices cannot be selected", async () => {
    const snapshot = await fixture(group("radio").replace('id="option-1"', 'id="option-1" aria-disabled="true"'));
    assert.equal(snapshot.fields[0].options[1].disabled, true);
    const result = await action(snapshot, snapshot.fields[0], "女");
    assert.notEqual(result.status, "verified");
    assert.equal(await page.evaluate(() => window.programClicks), 0);
  });

  await check("nearby text excludes input values, textarea, contenteditable and private content", async () => {
    const snapshot = await fixture('<div class="form-group"><input id="unknown" placeholder="补充说明"><span>公开的题目提示 PUBLIC_HELP</span><input value="PRIVATE_INPUT"><textarea>PRIVATE_TEXTAREA</textarea><div contenteditable="true">PRIVATE_EDITABLE</div><div role="textbox">PRIVATE_TEXTBOX</div><span data-private>PRIVATE_MARKED</span><span hidden>PRIVATE_HIDDEN</span></div>');
    const field = snapshot.fields.find((candidate) => candidate.identity.id === "unknown");
    assert.equal(field.labelSource, "placeholder");
    assert.match(field.nearbyText, /PUBLIC_HELP/);
    assert.ok(!field.nearbyText.includes("PRIVATE"), field.nearbyText);
    assert.ok(field.nearbyText.length <= 160);
    const none = await fixture('<div class="form-group"><input id="unknown"><span>公开说明 PUBLIC_NONE</span><textarea>PRIVATE_TEXTAREA</textarea></div>');
    const unnamed = none.fields.find((candidate) => candidate.identity.id === "unknown");
    assert.equal(unnamed.labelSource, "none");
    assert.match(unnamed.nearbyText, /PUBLIC_NONE/);
    assert.ok(!unnamed.nearbyText.includes("PRIVATE"));
  });
  for (const label of ["是否同意外派", "是否同意轮岗", "是否同意参加夜班值守", "Do you agree to work in Hong Kong?"]) {
    await check(`business agreement remains fillable: ${label}`, async () => {
      const choices = label.startsWith("Do") ? ["Yes", "No"] : ["同意", "不同意"];
      const snapshot = await fixture(group("radio", label, choices));
      const field = snapshot.fields[0];
      assert.equal(field.supported, true, field.reason);
      const result = await action(snapshot, field, choices[0]);
      assert.equal(result.status, "verified"); assert.equal(result.after, choices[0]);
    });
  }
  await check("legal agreement and a single acceptance checkbox stay manual", async () => {
    for (const html of [group("radio", "是否同意外派并授权共享资料", ["同意", "不同意"]), '<label>我同意参加轮岗<input type="checkbox"></label>']) {
      const snapshot = await fixture(html);
      assert.equal(snapshot.fields[0].supported, false);
    }
  });
  assert.deepEqual(errors, []);
  console.log(`Choice and privacy browser cases passed: ${passed}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pageBridge } from "../src/assistant/pageBridge.js";
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const root = path.resolve(import.meta.dirname, "..");
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/fixture") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<!doctype html><html><head><title>Application fixture</title></head><body><main id="fixture"></main></body></html>'); return; }
  const file = path.resolve(root, "." + pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try { res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8"); res.end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) });
const page = await browser.newPage();
let passed = 0;
async function fixture(html) { await page.goto(origin + "/fixture"); await page.locator("#fixture").evaluate((el, text) => { el.innerHTML = text; }, html); return page.evaluate(pageBridge, { action: "scan" }); }
const action = (s, f, value, extra = {}) => page.evaluate(pageBridge, { action: "fill", token: s.token, scanId: s.scanId, url: s.url, fieldId: f.fieldId, operationId: crypto.randomUUID(), value, ...extra });
const inspect = (s, f, extra = {}) => page.evaluate(pageBridge, { action: "inspect-options", token: s.token, scanId: s.scanId, url: s.url, fieldId: f.fieldId, ...extra });
async function dropdown({ delay = 0, search = false, closeable = true } = {}) {
  const snapshot = await fixture(`<div class="form-item"><label>学历</label><div id="degree" role="combobox" aria-label="学历" aria-controls="degrees" aria-expanded="false" style="min-height:24px"><span class="selected-value"></span>${search ? '<input aria-autocomplete="list" aria-label="学历搜索">' : ''}</div></div><div id="degrees" role="listbox" hidden></div>`);
  await page.evaluate(({ delay, closeable }) => {
    const box = document.querySelector('[role="combobox"]');
    const menu = document.getElementById("degrees");
    let generation = 0;
    const close = () => { if (closeable) { generation++; menu.hidden = true; box.setAttribute("aria-expanded", "false"); } };
    const populate = (query = "") => {
      const next = ++generation;
      menu.setAttribute("aria-busy", "true");
      menu.innerHTML = "<p>Loading…</p>";
      setTimeout(() => {
        if (next !== generation) return;
        menu.innerHTML = query ? '<div role="option" data-value="master">Master’s degree</div>' : '<div role="option" data-value="master">Master’s degree</div><div role="option" data-value="bachelor">Bachelor’s degree</div><div role="option" aria-disabled="true">Doctorate (closed)</div>';
        menu.setAttribute("aria-busy", "false");
      }, delay);
    };
    box.onclick = (event) => {
      if (event.target.matches("input")) return;
      if (!menu.hidden && closeable) close();
      else { menu.hidden = false; box.setAttribute("aria-expanded", "true"); populate(); }
    };
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
    box.querySelector("input")?.addEventListener("input", (event) => populate(event.target.value));
    menu.onclick = (event) => {
      const option = event.target.closest('[role="option"]');
      if (!option || option.getAttribute("aria-disabled") === "true") return;
      box.querySelector(".selected-value").textContent = option.textContent;
      close();
    };
  }, { delay, closeable });
  return snapshot;
}
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
try {
  await check("job context excludes application summaries and blocks containing answers", async () => {
    const s = await fixture('<article><h2>已填写的申请摘要</h2><p>私人回答 SAMPLE_PRIVATE_ANSWER</p></article><section class="job-description">岗位职责 SAMPLE_JOB_CONTEXT</section><section data-job-description><label>补充说明<textarea>SAMPLE_FORM_ANSWER</textarea></label></section>');
    assert.match(s.jobText, /SAMPLE_JOB_CONTEXT/);
    assert.equal(s.jobText.includes("SAMPLE_PRIVATE_ANSWER"), false);
    assert.equal(s.jobText.includes("SAMPLE_FORM_ANSWER"), false);
  });
  await check("stable node survives insertion before it", async () => {
    const s = await fixture('<form><label>姓名<input id="name"></label><label>邮箱<input id="email" type="email"></label></form>');
    await page.locator("form").evaluate((el) => el.insertAdjacentHTML("afterbegin", '<input id="injected">'));
    assert.equal((await action(s, s.fields[1], "test@example.com")).status, "verified");
    assert.equal(await page.locator("#email").inputValue(), "test@example.com"); assert.equal(await page.locator("#injected").inputValue(), "");
  });
  await check("unique semantic replacement is rebound and verified", async () => {
    const s = await fixture('<label>姓名<input id="name"></label>');
    await page.locator("#name").evaluate((el) => el.replaceWith(el.cloneNode()));
    const result = await action(s, s.fields[0], "Example");
    assert.equal(result.status, "verified"); assert.equal(result.rebound, true); assert.equal(await page.locator("#name").inputValue(), "Example");
    assert.deepEqual(await page.evaluate(pageBridge, { action: "changes", token: s.token, scanId: s.scanId, url: s.url }), { added: 0, changed: [] });
  });
  await check("user-entered values are preserved", async () => {
    const s = await fixture('<label>姓名<input id="name"></label>'); await page.locator("#name").fill("User value");
    assert.equal((await action(s, s.fields[0], "Example")).status, "skipped"); assert.equal(await page.locator("#name").inputValue(), "User value");
  });
  await check("pre-filled and newly read-only inputs stay unchanged", async () => {
    const s = await fixture('<label>姓名<input id="name" value="Existing"></label><label>邮箱<input id="email"></label>');
    assert.equal((await action(s, s.fields[0], "Example")).status, "skipped");
    await page.locator("#email").evaluate((el) => el.readOnly = true);
    assert.notEqual((await action(s, s.fields[1], "test@example.com")).status, "verified");
  });
  await check("changed label invalidates operation", async () => {
    const s = await fixture('<label>姓名<input id="name"></label>'); await page.locator("label").evaluate((el) => el.firstChild.textContent = "父亲姓名");
    assert.equal((await action(s, s.fields[0], "Example")).status, "failed");
  });
  await check("old scan and navigation cannot execute", async () => {
    const s = await fixture('<label>姓名<input></label>'); await page.evaluate(pageBridge, { action: "scan" });
    await assert.rejects(action(s, s.fields[0], "Example"));
    await page.reload(); await assert.rejects(action(s, s.fields[0], "Example"));
  });
  await check("negative option substrings and ambiguous duplicates rejected", async () => {
    const s = await fixture('<label>是否<select><option value="">请选择</option><option value="no">不是</option></select></label>');
    assert.equal((await action(s, s.fields[0], "是")).status, "failed");
    assert.equal((await action(s, s.fields[0], "不是")).status, "verified");
  });
  await check("radio group selects real No option, not unchecked Yes", async () => {
    const s = await fixture('<fieldset><legend>需要签证吗</legend><label><input type="radio" name="visa" value="y">是</label><label><input type="radio" name="visa" value="n">否</label></fieldset>');
    assert.equal(s.fields.length, 1); assert.equal(s.fields[0].label, "需要签证吗");
    assert.equal((await action(s, s.fields[0], "否")).status, "verified"); assert.equal(await page.locator('[value="n"]').isChecked(), true);
  });
  await check("checkbox group verifies complete selected set", async () => {
    const s = await fixture('<fieldset><legend>语言能力</legend><label><input type="checkbox" name="language" value="zh">中文</label><label><input type="checkbox" name="language" value="en">English</label></fieldset>');
    assert.equal(s.fields.length, 1); assert.equal((await action(s, s.fields[0], JSON.stringify(["中文", "English"]))).status, "verified");
  });
  await check("password file and consent are unsupported and password is not read", async () => {
    const s = await fixture('<label>密码<input type="password" value="secret"></label><label>简历<input type="file"></label><label><input type="checkbox">同意条款</label>');
    assert.ok(s.fields.every((f) => !f.supported)); assert.ok(!JSON.stringify(s).includes("secret"));
  });
  await check("controlled deferred input reset is not a success", async () => {
    const s = await fixture('<label>姓名<input id="name"></label>');
    await page.locator("#name").evaluate((el) => el.addEventListener("input", () => setTimeout(() => el.value = "", 180)));
    assert.equal((await action(s, s.fields[0], "Example")).status, "failed");
  });
  await check("invalid email is not a success", async () => {
    const s = await fixture('<label>邮箱<input type="email"></label>');
    assert.equal((await action(s, s.fields[0], "bad-address")).status, "failed");
  });
  await check("operation ids make retries idempotent", async () => {
    const s = await fixture('<label>姓名<input></label>'); const operationId = crypto.randomUUID();
    const first = await action(s, s.fields[0], "Example", { operationId });
    const second = await action(s, s.fields[0], "Other", { operationId }); assert.deepEqual(second, first);
  });
  await check("undo restores required empty baseline and preserves later user edit", async () => {
    const s = await fixture('<label>姓名<input id="name" required></label>');
    await action(s, s.fields[0], "Example");
    assert.equal((await action(s, s.fields[0], "", { action: "undo", expected: "Example" })).status, "verified");
    await page.locator("#name").fill("User edit");
    assert.equal((await action(s, s.fields[0], "", { action: "undo", expected: "Example" })).status, "skipped");
  });
  await check("open shadow root is scanned and filled", async () => {
    await fixture('<div id="host"></div>');
    await page.locator("#host").evaluate((el) => el.attachShadow({ mode: "open" }).innerHTML = '<label>邮箱<input type="email"></label>');
    const s = await page.evaluate(pageBridge, { action: "scan" }); assert.equal(s.fields.length, 1);
    assert.equal((await action(s, s.fields[0], "test@example.com")).status, "verified");
  });
  await check("custom dropdown only selects real options and verifies committed text", async () => {
    const s = await fixture('<label>学历</label><div class="sd-Select-container" role="combobox" aria-label="学历" aria-controls="menu"><span class="sd-Select-value"></span></div><div id="menu" role="listbox" hidden><div role="option">硕士</div><div role="option">本科</div></div>');
    await page.evaluate(() => { const box = document.querySelector('[role="combobox"]'); const menu = document.getElementById("menu"); box.onclick = () => menu.hidden = false; menu.onclick = (e) => { box.firstChild.textContent = e.target.textContent; menu.hidden = true; }; });
    assert.equal((await action(s, s.fields[0], "硕士")).status, "verified");
  });
  await check("frame targets are isolated even when local ids repeat", async () => {
    await fixture('<label>主页面搜索<input></label><iframe srcdoc="<label>学校<input></label>"></iframe>');
    const frame = page.frames()[1]; await frame.waitForSelector("input");
    const main = await page.evaluate(pageBridge, { action: "scan" }); const child = await frame.evaluate(pageBridge, { action: "scan" });
    await assert.rejects(frame.evaluate(pageBridge, { action: "fill", token: main.token, scanId: main.scanId, url: main.url, fieldId: main.fields[0].fieldId, operationId: crypto.randomUUID(), value: "wrong" }));
    assert.equal(await frame.locator("input").inputValue(), ""); assert.notEqual(child.token, main.token);
  });
  await check("inspection exposes stable semantic options and restores closed menu", async () => {
    const s = await dropdown();
    const observed = await inspect(s, s.fields[0]);
    assert.equal(observed.status, "inspected"); assert.equal(observed.restored, true);
    assert.equal(observed.field.options[0].text, "Master’s degree"); assert.equal(observed.options[2].disabled, true);
    assert.equal(await page.locator("#degrees").isVisible(), false);
    assert.equal(await page.locator(".selected-value").textContent(), "");
    const again = await inspect(s, s.fields[0]);
    assert.deepEqual(again.options.map((o) => o.id), observed.options.map((o) => o.id));
    const result = await action(s, s.fields[0], observed.options[0].text, { optionId: observed.options[0].id });
    assert.equal(result.status, "verified");
  });
  await check("late options wait for loading completion before selection", async () => {
    const s = await dropdown({ delay: 1050 });
    assert.equal((await inspect(s, s.fields[0])).status, "inspected");
    assert.equal((await action(s, s.fields[0], "Master’s degree")).status, "verified");
  });
  await check("inspection preserves a menu that was already open", async () => {
    const s = await dropdown(); await page.locator("#degree").click();
    const result = await inspect(s, s.fields[0]);
    assert.equal(result.status, "inspected"); assert.equal(result.restored, true);
    assert.equal(await page.locator("#degrees").isVisible(), true);
  });
  await check("inspection never invents search text and restores an explicit query", async () => {
    const s = await dropdown({ delay: 550, search: true });
    assert.equal((await inspect(s, s.fields[0])).status, "inspected");
    assert.equal(await page.locator("#degree input").inputValue(), "");
    const searched = await inspect(s, s.fields[0], { query: "Master" });
    assert.equal(searched.status, "inspected"); assert.equal(searched.options.length, 1);
    assert.equal(await page.locator("#degree input").inputValue(), "");
    assert.equal((await action(s, s.fields[0], "Master’s degree")).status, "verified");
  });
  await check("changed inspected candidates require another review", async () => {
    const s = await dropdown(); await inspect(s, s.fields[0]);
    await page.evaluate(() => {
      const box = document.getElementById("degree"); const menu = document.getElementById("degrees");
      box.onclick = () => { menu.hidden = false; menu.setAttribute("aria-busy", "false"); box.setAttribute("aria-expanded", "true"); menu.innerHTML = '<div role="option">Different degree</div>'; };
    });
    const result = await action(s, s.fields[0], "Master’s degree");
    assert.equal(result.code, "OPTIONS_CHANGED"); assert.equal(result.retryable, false);
    assert.equal(await page.locator(".selected-value").textContent(), "");
  });
  await check("manual typing during dropdown wait stops selection without overwriting", async () => {
    const s = await dropdown({ delay: 900, search: true });
    const pending = action(s, s.fields[0], "Master’s degree");
    await page.locator("#degrees").waitFor({ state: "visible" });
    await page.locator("#degree input").fill("My manual query");
    const result = await pending;
    assert.equal(result.code, "USER_EDITED"); assert.equal(result.status, "skipped");
    assert.equal(await page.locator("#degree input").inputValue(), "My manual query");
    assert.equal(await page.locator(".selected-value").textContent(), "");
  });
  await check("manual typing during verification remains intact", async () => {
    const s = await fixture('<label>姓名<input id="name"></label>');
    const pending = action(s, s.fields[0], "Example");
    await page.waitForFunction(() => document.getElementById("name").value === "Example");
    await page.locator("#name").fill("User correction");
    const result = await pending;
    assert.equal(result.code, "USER_EDITED"); assert.equal(await page.locator("#name").inputValue(), "User correction");
  });
  await check("equivalent replacement during verification retains operation and undo", async () => {
    const s = await fixture('<label>姓名<input id="name"></label>');
    await page.locator("#name").evaluate((el) => el.addEventListener("input", () => setTimeout(() => el.replaceWith(el.cloneNode()), 100), { once: true }));
    const result = await action(s, s.fields[0], "Example");
    assert.equal(result.status, "verified"); assert.equal(result.rebound, true);
    assert.equal((await action(s, s.fields[0], "", { action: "undo", expected: "Example" })).status, "verified");
  });
  await check("ambiguous semantic replacements and edited replacements are rejected", async () => {
    let s = await fixture('<div><label>姓名<input></label></div><div><label>姓名<input></label></div>');
    await page.locator("input").first().evaluate((el) => el.replaceWith(el.cloneNode()));
    assert.equal((await action(s, s.fields[0], "Example")).code, "AMBIGUOUS_REPLACEMENT");
    assert.deepEqual(await page.locator("input").evaluateAll((nodes) => nodes.map((el) => el.value)), ["", ""]);
    s = await fixture('<label>姓名<input id="name"></label>');
    await page.locator("input").evaluate((el) => { const clone = el.cloneNode(); clone.value = "User edit"; el.replaceWith(clone); });
    assert.equal((await action(s, s.fields[0], "Example")).code, "USER_EDITED");
    assert.equal(await page.locator("input").inputValue(), "User edit");
  });
  await check("unsafe menu restoration reports an explicit reason without selecting", async () => {
    const s = await dropdown({ closeable: false });
    const result = await inspect(s, s.fields[0]);
    assert.equal(result.code, "MENU_RESTORE_FAILED"); assert.equal(result.restored, false);
    assert.equal(await page.locator(".selected-value").textContent(), "");
  });
  await check("scan records conflicting family context without reading password values", async () => {
    const s = await fixture('<form><h2>工作经历</h2><fieldset><legend>家庭成员</legend><label>父亲职位<input></label><label>密码<input type="password" value="hidden-secret"></label></fieldset></form>');
    assert.equal(s.fields[0].entityHint, "family"); assert.ok(s.fields[0].contextConflicts.length);
    assert.ok(s.fields[0].contextEvidence.some((item) => item.source === "group" && item.text === "家庭成员"));
    assert.equal(JSON.stringify(s).includes("hidden-secret"), false);
  });
  await check("autocomplete input itself exposes options and verifies its committed value", async () => {
    const s = await fixture('<label>学校<input id="school" role="combobox" aria-autocomplete="list" aria-controls="schools" aria-expanded="false"></label><div id="schools" role="listbox" hidden><div role="option">Example University</div></div>');
    await page.evaluate(() => {
      const input = document.getElementById("school"); const menu = document.getElementById("schools");
      input.onclick = () => { menu.hidden = false; input.setAttribute("aria-expanded", "true"); };
      input.onkeydown = (event) => { if (event.key === "Escape") { menu.hidden = true; input.setAttribute("aria-expanded", "false"); } };
      menu.onclick = (event) => { input.value = event.target.textContent; menu.hidden = true; input.setAttribute("aria-expanded", "false"); };
    });
    assert.equal((await inspect(s, s.fields[0])).status, "inspected");
    assert.equal((await action(s, s.fields[0], "Example University")).status, "verified");
    assert.equal(await page.locator("#school").inputValue(), "Example University");
  });
  await check("search waits for changed results even without a loading marker", async () => {
    const s = await dropdown({ search: true });
    await page.evaluate(() => {
      const input = document.querySelector("#degree input");
      const clone = input.cloneNode(); input.replaceWith(clone);
      clone.addEventListener("input", () => {
        const query = clone.value;
        setTimeout(() => { if (query) document.getElementById("degrees").innerHTML = '<div role="option">Filtered degree</div>'; }, 700);
      });
    });
    await page.locator("#degree").click();
    await page.waitForFunction(() => document.querySelectorAll('#degrees [role="option"]').length === 3);
    const result = await inspect(s, s.fields[0], { query: "Filter" });
    assert.equal(result.status, "inspected"); assert.deepEqual(result.options.map((option) => option.text), ["Filtered degree"]);
    assert.equal(await page.locator("#degree input").inputValue(), "");
  });
  await check("a transient unopened menu gets only one bounded retry", async () => {
    const s = await dropdown();
    await page.evaluate(() => {
      const box = document.getElementById("degree"); const open = box.onclick; let attempts = 0;
      box.onclick = (event) => { box.dataset.attempts = String(++attempts); if (attempts > 1) open(event); };
    });
    const result = await action(s, s.fields[0], "Master’s degree");
    assert.equal(result.status, "verified"); assert.equal(result.retries, 1);
    assert.equal(await page.locator("#degree").getAttribute("data-attempts"), "2");
  });
  console.log(`Browser cases passed: ${passed}`);
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }

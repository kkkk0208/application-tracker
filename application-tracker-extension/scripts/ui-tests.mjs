// UI integration uses real Chrome DOMs and an explicit Chrome API test adapter.
// This does not substitute for loading the unpacked extension in a real side panel.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pageBridge } from "../src/assistant/pageBridge.js";
import { createMutationQueue, MUTATION_MESSAGE } from "../src/storageMutations.js";
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const root = path.resolve(import.meta.dirname, "..");
const fixture = '<!doctype html><html><head><meta charset="utf-8"><title>示例公司 · 分析师申请</title></head><body><form><section><h2>基本信息</h2><label>姓名<input id="name" required></label><label>邮箱<input id="email" type="email"></label></section><section><h2>硕士教育</h2><label>学校名称<input id="school"></label></section><section><h2>申请问题</h2><label>自我介绍<textarea id="intro"></textarea></label><label>奖惩情况<textarea id="awards"></textarea></label></section></form><iframe src="/child"></iframe></body></html>';
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === "/apply") return res.end(fixture);
  if (req.url === "/child") return res.end('<label>个人网站<input id="website"></label>');
  const file = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname);
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  try { if (file.endsWith(".js")) res.setHeader("Content-Type", "text/javascript"); if (file.endsWith(".css")) res.setHeader("Content-Type", "text/css"); res.end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
  const target = await browser.newPage(); await target.goto(origin + "/apply");
  const captureClient = await target.context().newCDPSession(target);
  const panel = await browser.newPage({ viewport: { width: 420, height: 1000 } });
  const profile = { fullNameZh: "示例申请人", email: "profile@example.com", masterUniversityZh: "示例大学", website: "https://portfolio.example.com", commonAnswers: { selfIntroduction: { zh: "这是一段待核对的自我介绍。", en: "" } } };
  const originalProfile = structuredClone(profile);
  const storage = { local: { "applicationTracker.profile": profile, "applicationTracker.aiSettings": { enabled: false }, "applicationTracker.questionMemory": [{ id: "legacy-one", question: "其他技能", answer: "SQL", language: "zh", pageUrl: "https://example.com/apply" }] }, session: { "applicationTracker.assistant.target.1": 1 } };
  const readStorage = (name, keys) => structuredClone(Object.fromEntries((keys == null ? Object.keys(storage[name]) : Array.isArray(keys) ? keys : [keys]).filter((key) => key in storage[name]).map((key) => [key, storage[name][key]])));
  const writeStorage = async (name, data) => {
    const changes = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { oldValue: storage[name][key], newValue: value }]));
    Object.assign(storage[name], structuredClone(data));
    await panel.evaluate(({ changes, area }) => window.__storageEvent?.emit(changes, area), { changes, area: name });
  };
  const mutate = createMutationQueue({ get: async (keys) => readStorage("local", keys), set: (data) => writeStorage("local", data) });
  let lockGate;
  let memoryGate;
  let activeTabId = 1;
  let captureCalls = 0;
  let childPermissionDenied = false;
  let allowChildPermission = false;
  const permissionRequests = [];
  await panel.exposeBinding("testApi", async (source, method, args) => {
    if (method === "tabs.get") return { id: 1, windowId: 1, active: activeTabId === 1, url: target.url(), title: await target.title() };
    if (method === "tabs.query") return [{ id: activeTabId, windowId: 1, active: true, url: activeTabId === 1 ? target.url() : "https://unrelated.example", title: activeTabId === 1 ? await target.title() : "Other tab" }];
    // Native captureVisibleTab does not inject screenshot styles into the page.
    if (method === "tabs.capture") { captureCalls++; return `data:image/png;base64,${(await captureClient.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true })).data}`; }
    if (method === "tabs.update") return {};
    if (method === "frames") return target.frames().map((frame, index) => ({ frameId: index, url: childPermissionDenied && index === 1 ? "https://embedded.example/form?private=token" : frame.url() }));
    if (method === "permissions.request") {
      permissionRequests.push(args);
      if (allowChildPermission) childPermissionDenied = false;
      return allowChildPermission;
    }
    if (method === "script") {
      const { target: route, request } = args;
      const index = route.frameIds?.[0] ?? (route.documentIds?.[0] === "doc1" ? 1 : 0);
      if (index === 1 && childPermissionDenied) throw new Error("Cannot access this frame without host permission");
      const frame = target.frames()[index];
      return [{ frameId: index, documentId: `doc${index}`, result: await frame.evaluate(pageBridge, request) }];
    }
    if (method === "get") return readStorage(args.area, args.keys);
    if (method === "set") return writeStorage(args.area, args.data);
    if (method === "remove") { delete storage[args.area][args.key]; return; }
    if (method === "message") {
      if (args.type === "assistant-lock" && lockGate) {
        const gate = lockGate; lockGate = null; gate.entered(); await gate.wait;
      }
      if (args.type === MUTATION_MESSAGE && args.mutation.operation === "memory.save" && memoryGate) {
        const gate = memoryGate; memoryGate = null; gate.entered(); await gate.wait;
      }
      if (args.type !== MUTATION_MESSAGE) return { ok: true };
      try { return { ok: true, value: await mutate(args.mutation) }; } catch (error) { return { ok: false, error: error.message }; }
    }
    throw new Error(`Unexpected test API ${method}`);
  });
  await panel.addInitScript(() => {
    const event = () => { const listeners = new Set(); return { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener), emit: (...args) => listeners.forEach((listener) => listener(...args)) }; };
    window.__storageEvent = event();
    const area = (name) => ({ get: (keys) => testApi("get", { area: name, keys }), set: (data) => testApi("set", { area: name, data }), remove: (key) => testApi("remove", { area: name, key }) });
    window.chrome = { permissions: { request: (request) => testApi("permissions.request", { request, userGesture: navigator.userActivation.isActive }) }, storage: { local: area("local"), session: area("session"), onChanged: window.__storageEvent }, windows: { getCurrent: async () => ({ id: 1 }), get: async () => ({ id: 1, focused: true }), onFocusChanged: event() }, tabs: { get: (id) => testApi("tabs.get", id), query: (query) => testApi("tabs.query", query), captureVisibleTab: (id, options) => testApi("tabs.capture", { id, options }), update: (id, props) => testApi("tabs.update", { id, props }), onActivated: event(), onUpdated: event(), onRemoved: event() }, webNavigation: { getAllFrames: () => testApi("frames") }, scripting: { executeScript: (args) => testApi("script", { target: args.target, request: args.args[0] }) }, runtime: { sendMessage: (message) => testApi("message", message) } };
  });
  const errors = []; panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(origin + "/src/sidepanel/assistant.html");
  await panel.locator("#prepare").click();
  await panel.locator("#questions .question").first().waitFor();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await panel.locator("#questions .question").count(), 6);
  assert.match(await panel.locator("#coverage").textContent(), /2\/2/);
  assert.match(await panel.locator("#fill").textContent(), /确认并填写\s*5\s*项/);
  console.log("PASS UI merges main and child frame questions through the API adapter");
  assert.equal(await panel.locator("#filter").inputValue(), "all");
  assert.equal(await panel.locator("[data-selected]:checked").count(), 5);
  for (const id of ["name", "email", "school", "intro", "awards"]) assert.equal(await target.locator(`#${id}`).inputValue(), "");
  assert.equal(await target.frames()[1].locator("#website").inputValue(), "");
  await panel.locator("#clearSelection").click();
  assert.equal(await panel.locator("[data-selected]:checked").count(), 0);
  assert.equal(await panel.locator("#fill").isDisabled(), true);
  await panel.locator("#selectAll").click();
  assert.equal(await panel.locator("[data-selected]:checked").count(), 5);
  await panel.locator("#filter").selectOption("attention");
  assert.equal(await panel.locator(".question").count(), 2);
  assert.equal(await panel.locator(".question").filter({ has: panel.locator("label", { hasText: /^自我介绍/ }) }).count(), 1);
  assert.equal(await panel.locator(".question").filter({ has: panel.locator("label", { hasText: /^奖惩情况/ }) }).locator("[data-selected]").isChecked(), false);
  await panel.locator("#filter").selectOption("all");
  assert.match(await panel.locator("#fill").textContent(), /确认并填写\s*5\s*项/);
  for (const id of ["name", "email", "school", "intro", "awards"]) assert.equal(await target.locator(`#${id}`).inputValue(), "");
  console.log("PASS UI previews all valid answers without writing the target and supports select-all, clearing and attention filtering");
  let releaseLock;
  const lockEntered = new Promise((resolve) => { lockGate = { entered: resolve, wait: new Promise((release) => { releaseLock = release; }) }; });
  await panel.locator("#fill").click();
  await lockEntered;
  await panel.locator("#cancel").click();
  releaseLock();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await target.locator("#name").inputValue(), "");
  assert.equal(await target.locator("#school").inputValue(), "");
  assert.equal(await target.locator("#intro").inputValue(), "");
  assert.equal(await target.frames()[1].locator("#website").inputValue(), "");
  assert.equal(await panel.locator("#resultList .result-row").count(), 0);
  console.log("PASS UI cancel while acquiring a delayed lock prevents all subsequent writes");
  await target.locator("#email").fill("user-change@example.com");
  await panel.locator("#fill").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await target.locator("#name").inputValue(), "示例申请人");
  assert.equal(await target.locator("#school").inputValue(), "示例大学");
  assert.equal(await target.locator("#intro").inputValue(), profile.commonAnswers.selfIntroduction.zh);
  assert.equal(await target.locator("#email").inputValue(), "user-change@example.com");
  assert.equal(await target.frames()[1].locator("#website").inputValue(), "https://portfolio.example.com");
  assert.match(await panel.locator("#resultSummary").textContent(), /4\/5/);
  assert.deepEqual(storage.local["applicationTracker.profile"], originalProfile);
  assert.equal(storage.local["applicationTracker.assistant.memories.v2"].length, 1);
  assert.equal(storage.local["applicationTracker.assistant.memories.v2"][0].confirmed, false);
  console.log("PASS UI fill preserves manual edits, profile bytes and unconfirmed memories");
  await panel.locator("#undo").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await target.locator("#name").inputValue(), ""); assert.equal(await target.locator("#school").inputValue(), "");
  assert.equal(await target.locator("#intro").inputValue(), "");
  assert.equal(await target.locator("#email").inputValue(), "user-change@example.com");
  console.log("PASS UI undo restores only assistant-written fields");
  await panel.locator("#prepare").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  const artifacts = path.join(root, "test-artifacts"); await mkdir(artifacts, { recursive: true });
  await panel.screenshot({ path: path.join(artifacts, "assistant-preview.png"), fullPage: true });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await panel.setViewportSize({ width: 320, height: 900 }); assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  console.log("PASS UI fits 320px and 420px widths without horizontal overflow");
  await panel.reload(); await panel.locator("#questions .question").first().waitFor(); assert.equal(await panel.locator("#questions .question").count(), 6);
  console.log("PASS UI session restores on reload");
  await target.reload(); await panel.waitForFunction(() => document.getElementById("fill").disabled);
  assert.match(await panel.locator("#message").textContent(), /变化|重新识别/);
  console.log("PASS UI detects navigation and disables stale plans");

  // Drive the full preparation pipeline with a delayed custom control and a local AI stub.
  // No external API request or real personal data is used.
  await target.goto(origin + "/apply");
  await target.evaluate(() => {
    document.body.innerHTML = `<form><section><h2>硕士教育</h2><label>学校所在地<input id="school-location"></label><div role="combobox" aria-label="学位" aria-controls="degree-menu" aria-expanded="false" tabindex="0" style="padding:16px"><span class="selected-value"></span></div><ul role="listbox" id="degree-menu" hidden></ul></section><section><h2>申请问题</h2><label>自我介绍<textarea id="intro"></textarea></label></section></form>`;
    const control = document.querySelector('[role="combobox"]');
    const menu = document.getElementById("degree-menu");
    const close = () => { menu.hidden = true; control.setAttribute("aria-expanded", "false"); };
    control.addEventListener("click", () => {
      if (control.getAttribute("aria-expanded") === "true") return close();
      menu.hidden = false; menu.innerHTML = ""; control.setAttribute("aria-expanded", "true");
      setTimeout(() => { menu.innerHTML = `<li role="option">Bachelor's degree</li><li role="option">Master's degree</li>`; }, 500);
    });
    control.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
    menu.addEventListener("click", (event) => {
      if (!event.target.matches('[role="option"]')) return;
      control.querySelector(".selected-value").textContent = event.target.textContent; close();
    });
  });
  await writeStorage("local", { "applicationTracker.profile": { ...profile, masterDegreeZh: "硕士" }, "applicationTracker.aiSettings": { enabled: true, apiKey: "fixture-key", model: "fixture-model" } });
  const sentBatches = [];
  await panel.route("https://api.openai.com/v1/responses", async (route) => {
    const payload = route.request().postDataJSON();
    const batch = JSON.parse(payload.input[1].content);
    sentBatches.push(batch);
    const output = payload.text.format.name === "application_question_mapping"
      ? { mappings: batch.fields.map((field) => ({ fieldId: field.fieldId, entityId: field.entityId, intent: null })) }
      : { items: batch.fields.flatMap((field) => {
        if (field.label === "学位") return [{ fieldId: field.fieldId, entityId: field.entityId, kind: "option", factIds: [batch.facts.find((fact) => fact.id.includes(".degree.")).id], optionId: field.options.find((option) => option.text === "Master's degree").id, text: null }];
        if (field.label === "自我介绍") return [{ fieldId: field.fieldId, entityId: field.entityId, kind: "draft", factIds: [batch.facts.find((fact) => fact.id.includes("selfIntroduction") || fact.id.startsWith("education.")).id], optionId: null, text: "根据已确认资料准备的 AI 自我介绍草稿。" }];
        return [];
      }) };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "completed", output_text: JSON.stringify(output) }) });
  });
  await panel.locator("#prepare").click();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  const degree = panel.locator(".question").filter({ has: panel.locator('label', { hasText: /^学位/ }) });
  const location = panel.locator(".question").filter({ has: panel.locator('label', { hasText: /^学校所在地/ }) });
  const intro = panel.locator(".question").filter({ has: panel.locator('label', { hasText: /^自我介绍/ }) });
  assert.equal(await location.locator("[data-answer]").inputValue(), "");
  assert.equal(await location.locator("[data-selected]").isChecked(), false);
  assert.equal(await degree.locator("[data-answer]").inputValue(), "Master's degree");
  assert.equal(await degree.locator("[data-selected]").isChecked(), true);
  assert.equal(await intro.locator("[data-selected]").isChecked(), true);
  assert.equal(await intro.locator("[data-answer]").inputValue(), "根据已确认资料准备的 AI 自我介绍草稿。");
  assert.match(await intro.locator(".source").first().textContent(), /AI 草稿/);
  assert.equal(await target.locator('[role="combobox"] .selected-value').textContent(), "");
  assert.equal(await target.locator("#intro").inputValue(), "");
  assert.equal(await target.locator("#school-location").inputValue(), "");
  assert.equal(await target.locator("#degree-menu").isVisible(), false);
  assert.ok(sentBatches.some((batch) => batch.fields.some((field) => field.label === "学位" && field.options?.length === 2)));
  assert.match(await panel.locator("#fill").textContent(), /确认并填写\s*2\s*项/);
  // No per-question checking: the only write action is this explicit batch confirmation.
  await panel.locator("#fill").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await target.locator('[role="combobox"] .selected-value').textContent(), "Master's degree");
  assert.equal(await target.locator("#intro").inputValue(), "根据已确认资料准备的 AI 自我介绍草稿。");
  assert.equal(await target.locator("#school-location").inputValue(), "");
  await panel.locator("#saveResults").click();
  assert.equal(await panel.locator("[data-learn]").count(), 2);
  assert.equal(await panel.locator("[data-learn-check]:checked").count(), 2);
  assert.equal(storage.local["applicationTracker.assistant.memories.v2"].length, 1);
  console.log("PASS UI previews delayed real options and validated AI prose, then fills both with one confirmation and previews all result memories");

  await panel.locator("#undo").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await target.locator("#intro").inputValue(), "");
  // This custom control has no clear option; reset the synthetic fixture as a
  // user's manual clear before testing a fresh preview, not as an undo guarantee.
  await target.locator('[role="combobox"] .selected-value').evaluate((node) => { node.textContent = ""; });
  await panel.locator("#refresh").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  await panel.locator("#clearSelection").click();
  await intro.locator("[data-answer]").fill("人工核对的草稿");
  assert.equal(await intro.locator("[data-selected]").isChecked(), true);
  await target.locator("form").evaluate((form) => form.insertAdjacentHTML("beforeend", '<section><h2>基本信息</h2><label>邮箱<input type="email" required></label></section>'));
  await panel.locator("#refresh").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await intro.locator("[data-answer]").inputValue(), "人工核对的草稿");
  assert.equal(await intro.locator("[data-selected]").isChecked(), true);
  assert.equal(await degree.locator("[data-selected]").isChecked(), false);
  const email = panel.locator(".question").filter({ has: panel.locator("label", { hasText: /^邮箱/ }) });
  assert.equal(await email.locator("[data-selected]").isChecked(), true);
  assert.equal(await panel.locator('[data-selected]:checked').count(), 2);
  assert.equal(await panel.locator(".question").count(), 4);
  assert.equal(await target.locator('input[type="email"]').inputValue(), "");
  assert.equal(await target.locator("#intro").inputValue(), "");
  console.log("PASS UI refresh preserves edited drafts and manual exclusions while new valid answers stay in preview until confirmation");

  await panel.locator("#language").selectOption("en");
  await panel.locator("#refresh").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.notEqual(await intro.locator("[data-answer]").inputValue(), "人工核对的草稿");
  assert.equal(await intro.locator("[data-selected]").isChecked(), false);
  assert.equal(await email.locator("[data-selected]").isChecked(), true);
  assert.equal(await panel.locator('[data-selected]:checked').count(), 1);
  assert.equal(await target.locator('input[type="email"]').inputValue(), "");
  console.log("PASS UI changing language discards old-language drafts while selecting valid new-language answers for preview");

  await panel.locator("#language").selectOption("zh");
  await panel.locator("#refresh").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  await intro.locator("[data-answer]").fill("第一版回答");
  assert.equal(await intro.locator("[data-selected]").isChecked(), true);
  await panel.locator("#fill").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await target.locator("#intro").inputValue(), "第一版回答");
  await target.locator("#intro").fill("");
  await panel.locator("#refresh").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  await intro.locator("[data-answer]").fill("第二版回答");
  assert.equal(await intro.locator("[data-selected]").isChecked(), true);
  await panel.locator("#fill").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await target.locator("#intro").inputValue(), "第二版回答");
  const introResults = panel.locator(".result-row").filter({ has: panel.locator('strong', { hasText: /^自我介绍$/ }) }).filter({ has: panel.locator("[data-save-answer]") });
  assert.equal(await introResults.count(), 2);
  await introResults.last().locator("[data-save-answer]").click();
  assert.equal(await panel.locator("[data-learn-answer]").inputValue(), "第二版回答");
  // A subsequent language change must not relabel a previously opened answer preview.
  await panel.locator("#language").selectOption("en");
  await panel.locator("#refresh").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  await panel.locator("[data-learn-check]").check();
  await panel.locator("#saveLearned").click();
  await panel.waitForFunction(() => document.getElementById("learnPreview").hidden);
  const learned = storage.local["applicationTracker.assistant.memories.v2"].find((item) => item.answer === "第二版回答");
  assert.ok(learned); assert.equal(learned.language, "zh");
  assert.equal(learned.question, "自我介绍");
  console.log("PASS UI saves the chosen fill operation and preserves its original language across refreshes");

  await panel.locator("#learning").evaluate((details) => { details.open = true; });
  await panel.locator("#learn").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await panel.locator("[data-learn]").count(), 3);
  const expectedMemories = await panel.locator("[data-learn]").evaluateAll((nodes) => nodes.map((node) => ({ question: node.querySelector("label").textContent.trim(), answer: node.querySelector("[data-learn-answer]").value })));
  assert.equal(await panel.locator("[data-learn-check]:checked").count(), 3);
  let releaseMemory;
  const memoryEntered = new Promise((resolve) => { memoryGate = { entered: resolve, wait: new Promise((release) => { releaseMemory = release; }) }; });
  await panel.locator("#saveLearned").click();
  await memoryEntered;
  assert.equal(await panel.locator("#saveLearned").isDisabled(), true);
  assert.equal(await panel.locator("#learn").isDisabled(), true);
  assert.equal(await panel.locator("#language").isDisabled(), true);
  assert.equal(await panel.locator("[data-learn-answer]:disabled").count(), 3);
  // Even a queued duplicate click cannot start a second mutable batch.
  await panel.locator("#saveLearned").dispatchEvent("click");
  releaseMemory();
  await panel.waitForFunction(() => document.getElementById("learnPreview").hidden && !document.getElementById("prepare").disabled);
  for (const expected of expectedMemories) {
    assert.ok(storage.local["applicationTracker.assistant.memories.v2"].some((item) => expected.question.endsWith(item.question) && item.answer === expected.answer && item.language === "en"));
  }
  console.log("PASS UI freezes multi-answer memory saves and locks the preview until the batch completes");

  await writeStorage("local", { "applicationTracker.assistant.memories.v2": [] });
  assert.equal(await panel.locator("#fill").isDisabled(), true);
  assert.match(await panel.locator("#message").textContent(), /问答记忆已更新/);
  console.log("PASS UI memory changes invalidate prepared answers");
  // Render labels only into pixels, so the DOM cannot supply their meaning.
  const visionFixture = async () => {
    await target.goto(origin + "/apply");
    await target.evaluate(() => {
      document.body.innerHTML = '<form><section><h2>申请信息</h2><canvas id="visual-label" width="420" height="90"></canvas><div><input id="image-field"></div></section><section><h2>联系信息</h2><label>邮箱<input id="email" type="email"></label><label>密码<input id="password" type="password" value="synthetic-password-secret"></label></section></form>';
      const canvas = document.getElementById("visual-label");
      const ctx = canvas.getContext("2d"); ctx.font = "22px sans-serif";
      ctx.fillText("本科教育", 10, 30); ctx.fillText("学校名称", 10, 75);
    });
  };
  const visualSettings = { enabled: true, visionEnabled: true, apiKey: "fixture-key", model: "fixture-model" };
  const visualProfile = { ...profile, bachelorUniversityZh: "截图测试本科大学", masterUniversityZh: "另一所硕士大学" };
  await panel.unroute("https://api.openai.com/v1/responses");
  const visualRequests = [];
  let rejectVisual = false;
  await panel.route("https://api.openai.com/v1/responses", async (route) => {
    const payload = route.request().postDataJSON();
    const isVisual = payload.text.format.name === "application_visual_observations";
    const batch = JSON.parse(isVisual ? payload.input[1].content[0].text : payload.input[1].content);
    if (isVisual) {
      visualRequests.push(payload);
      if (rejectVisual) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { message: "Image input unsupported by fixture model" } }) });
    }
    const output = isVisual
      ? { observations: batch.fields.filter((field) => field.label === "未命名问题").map((field) => ({ fieldId: field.fieldId, marker: field.marker, label: "学校名称", section: "本科教育", confidence: 0.98 })) }
      : payload.text.format.name === "application_question_mapping"
        ? { mappings: batch.fields.map((field) => ({ fieldId: field.fieldId, entityId: field.entityId, intent: null })) }
        : { items: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "completed", output_text: JSON.stringify(output) }) });
  });
  await visionFixture();
  await writeStorage("local", { "applicationTracker.profile": visualProfile, "applicationTracker.aiSettings": visualSettings });
  await panel.locator("#language").selectOption("zh");
  await panel.locator("#prepare").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(captureCalls, 1);
  assert.equal(visualRequests.length, 1, await panel.locator("#visionStatus").textContent());
  const imagePayload = visualRequests[0];
  assert.equal(imagePayload.store, false);
  assert.equal(imagePayload.model, "fixture-model");
  assert.equal(imagePayload.input[1].content[1].type, "input_image");
  assert.match(imagePayload.input[1].content[1].image_url, /^data:image\/png;base64,/);
  assert.equal(imagePayload.input[1].content[1].detail, "high");
  assert.ok(!/synthetic-password-secret|截图测试本科大学|profile@example.com/.test(imagePayload.input[1].content[0].text));
  const imageSchool = panel.locator(".question").filter({ has: panel.locator("label", { hasText: /^学校名称$/ }) });
  assert.equal(await imageSchool.locator("[data-answer]").inputValue(), "截图测试本科大学");
  assert.equal(await imageSchool.locator("[data-selected]").isChecked(), true);
  assert.match(await imageSchool.locator(".status").textContent(), /重点核对/);
  assert.match(await panel.locator("#visionStatus").textContent(), /辅助识别 1 项/);
  assert.equal(await target.locator("#image-field").inputValue(), "");
  assert.equal(await target.locator("#email").inputValue(), "");
  assert.ok(!JSON.stringify(storage).includes("data:image/"));
  await panel.screenshot({ path: path.join(artifacts, "assistant-visual-preview.png"), fullPage: true });
  await imageSchool.locator("[data-answer]").fill("人工核对的本科院校");
  await panel.locator("#refresh").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await imageSchool.locator("[data-answer]").inputValue(), "人工核对的本科院校");
  assert.equal(await imageSchool.locator("[data-selected]").isChecked(), true);
  assert.match(await imageSchool.textContent(), /截图辅助/);
  assert.equal(captureCalls, 1); assert.equal(visualRequests.length, 1);
  assert.equal(await target.locator("#image-field").inputValue(), "");
  console.log("PASS UI refreshing a visually identified question preserves its manual draft without asking vision to rewrite it");

  await panel.locator(".binding").evaluate((details) => { details.open = true; });
  await panel.locator("[data-binding]").selectOption("education.bachelor");
  await panel.waitForFunction(() => document.querySelector('[aria-label="学校名称的答案"]').value === "截图测试本科大学");
  await panel.locator("#refresh").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await imageSchool.locator("[data-answer]").inputValue(), "截图测试本科大学");
  assert.equal(await panel.locator("[data-binding]").inputValue(), "education.bachelor");
  assert.equal(captureCalls, 1); assert.equal(visualRequests.length, 1);
  assert.equal(await target.locator("#image-field").inputValue(), "");
  console.log("PASS UI a manual education binding survives a fresh DOM scan of a visually labelled field");
  await panel.locator("#fill").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await target.locator("#image-field").inputValue(), "截图测试本科大学");
  assert.equal(await target.locator("#email").inputValue(), profile.email);
  assert.equal(await target.locator("#password").inputValue(), "synthetic-password-secret");
  assert.ok(!JSON.stringify(storage).includes("data:image/"));
  console.log("PASS UI screenshot observations resolve a canvas-only label to bachelor facts, preview first and fill once without persisting images");

  await visionFixture();
  await writeStorage("local", { "applicationTracker.aiSettings": { ...visualSettings, visionEnabled: false } });
  await panel.locator("#prepare").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(captureCalls, 1); assert.equal(visualRequests.length, 1);
  assert.equal(await panel.locator("#visionStatus").isVisible(), false);
  assert.equal(await panel.getByRole("textbox", { name: "未命名问题的答案", exact: true }).inputValue(), "");
  assert.equal(await panel.getByRole("textbox", { name: "邮箱的答案", exact: true }).inputValue(), profile.email);
  console.log("PASS UI vision opt-out sends no screenshot and preserves ordinary text preparation");

  await writeStorage("local", { "applicationTracker.aiSettings": visualSettings });
  activeTabId = 2;
  await panel.locator("#prepare").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(captureCalls, 1); assert.equal(visualRequests.length, 1);
  assert.match(await panel.locator("#visionStatus").textContent(), /继续使用文字识别/);
  assert.equal(await panel.getByRole("textbox", { name: "邮箱的答案", exact: true }).inputValue(), profile.email);
  assert.equal(await target.locator("#image-field").inputValue(), "");
  activeTabId = 1;
  console.log("PASS UI an unrelated active tab prevents capture and falls back to the bound form's text preview");

  rejectVisual = true;
  await panel.locator("#prepare").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(captureCalls, 2); assert.equal(visualRequests.length, 2);
  assert.match(await panel.locator("#visionStatus").textContent(), /继续使用文字识别.*400/);
  assert.equal(await panel.getByRole("textbox", { name: "邮箱的答案", exact: true }).inputValue(), profile.email);
  assert.equal(await target.locator("#image-field").inputValue(), "");
  assert.ok(!JSON.stringify(storage).includes("data:image/"));
  console.log("PASS UI an image API failure preserves the ordinary preview without writing or persisting a screenshot");

  rejectVisual = false;
  await visionFixture();
  await target.locator("section").first().evaluate((section) => section.insertAdjacentHTML("beforeend", '<label>专业<input id="major"></label>'));
  await writeStorage("local", { "applicationTracker.profile": { ...visualProfile, bachelorMajorZh: "本科专业", masterMajorZh: "硕士专业" } });
  await panel.locator("#prepare").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await imageSchool.locator("[data-answer]").inputValue(), "截图测试本科大学");
  const unresolvedMajor = panel.locator(".question").filter({ has: panel.locator("label", { hasText: /^专业$/ }) });
  assert.equal(await unresolvedMajor.locator("[data-answer]").inputValue(), "");
  assert.equal(await unresolvedMajor.locator("[data-selected]").isChecked(), false);
  assert.match(await unresolvedMajor.textContent(), /截图仅确认/);
  assert.equal(await target.locator("#image-field").inputValue(), "");
  assert.equal(await target.locator("#major").inputValue(), "");
  console.log("PASS UI a partial visual response cannot silently pair bachelor school with a master's major");
  await writeStorage("local", { "applicationTracker.aiSettings": { enabled: false } });
  await target.goto(origin + "/apply");
  childPermissionDenied = true;
  await panel.locator("#prepare").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.match(await panel.locator("#coverage").textContent(), /1\/2/);
  assert.equal(permissionRequests.length, 0, "Scanning must not request permissions automatically");
  const permissionButton = panel.getByRole("button", { name: "允许读取内嵌表单（embedded.example）", exact: true });
  await permissionButton.click();
  await panel.waitForFunction(() => document.getElementById("message").textContent.includes("尚未允许"));
  assert.deepEqual(permissionRequests[0], { request: { origins: ["https://embedded.example/*"] }, userGesture: true });
  assert.equal(await panel.locator("#questions .question").count(), 5);
  allowChildPermission = true;
  await permissionButton.click();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled && document.getElementById("coverage").textContent.includes("2/2"));
  assert.equal(await panel.locator("#framePermissions").isVisible(), false);
  assert.equal(await panel.locator("#questions .question").count(), 6);
  assert.equal(await target.frames()[1].locator("#website").inputValue(), "");
  console.log("PASS UI requests only the failed iframe origin during a user click, preserves denied preview and rescans after grant");

  await target.setContent('<!doctype html><title>其他页面</title><label>邮箱<input id="uncertain-email"></label>');
  await panel.locator("#prepare").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.match(await panel.locator("#pageTypeNotice").textContent(), /尚未确定页面类型/);
  assert.equal(await panel.locator("[data-selected]:checked").count(), 1);
  assert.equal(await target.locator("#uncertain-email").inputValue(), "");
  await target.setContent('<!doctype html><title>岗位详情</title><div class="job-description">工作职责：负责日常财务分析和报表编制。</div><label>邮箱<input id="job-email"></label>');
  await panel.locator("#prepare").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await panel.locator("[data-selected]:checked").count(), 1);
  assert.equal(await target.locator("#job-email").inputValue(), "");
  console.log("PASS UI keeps detected controls available on unknown or job-like pages and writes nothing before confirmation");

  await target.setContent('<!doctype html><title>信息表</title><input id="placeholder-question" placeholder="您的补充说明"><input id="unknown-question">');
  await panel.locator("#prepare").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await panel.locator("[data-label-warning]").count(), 2);
  assert.ok((await panel.locator("[data-label-warning]").allTextContents()).every((text) => text === "题目未识别"));
  console.log("PASS UI marks placeholder-only and unlabeled questions for review");
  assert.deepEqual(errors, []);
  console.log("UI integration cases passed: 24 (Chrome API adapter and local AI stub; not live-model validation)");
} finally { await browser.close(); await new Promise((r) => server.close(r)); }

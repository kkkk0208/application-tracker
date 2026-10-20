// UI integration uses real Chrome DOMs and an explicit Chrome API test adapter.
// This does not substitute for loading the unpacked extension in a real side panel.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pageBridge } from "../src/assistant/pageBridge.js";
import { collectJobSignals } from "../src/jobInfo/collectSignals.js";
import { createMutationQueue, MUTATION_MESSAGE } from "../src/storageMutations.js";
import { toDateInputValue } from "../src/dateUtils.js";
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
  let recordGate;
  let activeTabId = 1;
  let captureCalls = 0;
  let childPermissionDenied = false;
  let allowChildPermission = false;
  let mainPermissionDenied = false;
  let allowMainPermission = false;
  let mainScriptFault = false;
  let mainPermissionGate;
  let mainScanCalls = 0;
  let changesBusy = false;
  let changesFault = false;
  let onChangesBusy;
  const permissionRequests = [];
  const documentIds = new Map();
  await panel.exposeBinding("testApi", async (source, method, args) => {
    if (method === "tabs.get") return { id: 1, windowId: 1, active: activeTabId === 1, url: target.url(), title: await target.title() };
    if (method === "tabs.query") return [{ id: activeTabId, windowId: 1, active: true, url: activeTabId === 1 ? target.url() : "https://unrelated.example", title: activeTabId === 1 ? await target.title() : "Other tab" }];
    // Native captureVisibleTab does not inject screenshot styles into the page.
    if (method === "tabs.capture") { captureCalls++; return `data:image/png;base64,${(await captureClient.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true })).data}`; }
    if (method === "tabs.update") return {};
    if (method === "frames") return target.frames().map((frame, index) => ({ frameId: index, url: childPermissionDenied && index === 1 ? "https://embedded.example/form?private=token" : frame.url() }));
    if (method === "permissions.request") {
      permissionRequests.push(args);
      if (args.request.origins?.[0] === new URL(target.url()).origin + "/*") {
        if (mainPermissionGate) { const gate = mainPermissionGate; mainPermissionGate = null; gate.entered(); await gate.wait; }
        if (allowMainPermission) mainPermissionDenied = false;
        return allowMainPermission;
      }
      if (allowChildPermission) childPermissionDenied = false;
      return allowChildPermission;
    }
    if (method === "script") {
      const { target: route, request, functionName } = args;
      const index = route.frameIds?.[0] ?? [...documentIds.entries()].find(([, id]) => id === route.documentIds?.[0])?.[0];
      if (index === undefined) throw new Error("Original document missing");
      if (index === 0 && request?.action === "scan") {
        mainScanCalls++;
        if (mainPermissionDenied) throw new Error("Cannot access contents of url " + target.url() + ". Extension manifest must request permission to access this host.");
        if (mainScriptFault) throw new TypeError("Scan failed at https://private.example/?token=private-token");
      }
      if (index === 0 && request?.action === "changes" && (changesBusy || changesFault)) {
        onChangesBusy?.(); onChangesBusy = null;
        return [{ frameId: 0, documentId: documentIds.get(0), result: changesBusy ? { status: "skipped", code: "BRIDGE_BUSY" } : { status: "failed", code: "BRIDGE_EXCEPTION", stage: "describe", errorName: "TypeError", secureContext: false, message: "private-diagnostic-token" } }];
      }
      if (index === 1 && childPermissionDenied) throw new Error("Cannot access this frame without host permission");
      const frame = target.frames()[index];
      if (!frame) throw new Error("Original frame missing");
      const ping = await frame.evaluate(pageBridge, { action: "ping" });
      const documentId = `doc${index}:${ping.token}`;
      documentIds.set(index, documentId);
      if (route.documentIds && !route.documentIds.includes(documentId)) throw new Error("Original document missing");
      return [{ frameId: index, documentId, result: functionName === "collectJobSignals" ? await frame.evaluate(collectJobSignals) : await frame.evaluate(pageBridge, request) }];
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
      if (args.type === MUTATION_MESSAGE && args.mutation.operation === "record.create" && recordGate) {
        const gate = recordGate; recordGate = null; gate.entered(); await gate.wait;
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
    window.chrome = { permissions: { request: (request) => testApi("permissions.request", { request, userGesture: navigator.userActivation.isActive }) }, storage: { local: area("local"), session: area("session"), onChanged: window.__storageEvent }, windows: { getCurrent: async () => ({ id: 1 }), get: async () => ({ id: 1, focused: true }), onFocusChanged: event() }, tabs: { get: (id) => testApi("tabs.get", id), query: (query) => testApi("tabs.query", query), captureVisibleTab: (id, options) => testApi("tabs.capture", { id, options }), update: (id, props) => testApi("tabs.update", { id, props }), onActivated: event(), onUpdated: event(), onRemoved: event() }, webNavigation: { getAllFrames: () => testApi("frames") }, scripting: { executeScript: (args) => testApi("script", { target: args.target, functionName: args.func.name, request: args.args?.[0] }) }, runtime: { sendMessage: (message) => testApi("message", message) } };
  });
  const errors = []; panel.on("pageerror", (e) => errors.push(e.message));
  const preparePage = async () => {
    if (!await panel.locator("#prepare").isVisible() && !await panel.locator("#menu").isVisible()) await panel.locator("#menuButton").click();
    await panel.locator("#prepare").click();
  };
  const expandQuestions = async () => {
    const button = panel.locator("#showAll");
    if (await button.isVisible() && (await button.textContent()).trim() === "展开全部题目") await button.click();
  };
  const refreshPreview = async () => {
    await panel.locator(await panel.locator("#refresh").isVisible() ? "#refresh" : "#prepare").click();
  };
  await panel.goto(origin + "/src/sidepanel/assistant.html");
  await preparePage();
  await panel.locator("#questions .question").first().waitFor();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await panel.locator("#questions .question").count(), 6);
  assert.match(await panel.locator("#coverage").textContent(), /2\/2/);
  assert.match(await panel.locator("#fill").textContent(), /填写\s*5\s*项/);
  console.log("PASS UI merges main and child frame questions through the API adapter");
  assert.equal(await panel.locator("#filter").count(), 0);
  assert.equal(await panel.locator("#results").isVisible(), false);
  await panel.setViewportSize({ width: 400, height: 900 });
  assert.equal(await panel.locator('.question').evaluateAll((nodes) => nodes.some((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < innerHeight;
  })), true);
  console.log("PASS UI shows a question in the first 400x900 preview screen and keeps results hidden before filling");
  await panel.setViewportSize({ width: 420, height: 1000 });
  assert.equal(await panel.locator("[data-selected]:checked").count(), 5);
  for (const id of ["name", "email", "school", "intro", "awards"]) assert.equal(await target.locator(`#${id}`).inputValue(), "");
  assert.equal(await target.frames()[1].locator("#website").inputValue(), "");
  await expandQuestions();
  await panel.locator("#clearSelection").click();
  assert.equal(await panel.locator("[data-selected]:checked").count(), 0);
  assert.equal(await panel.locator("#fill").isDisabled(), true);
  await panel.locator("#selectAll").click();
  assert.equal(await panel.locator("[data-selected]:checked").count(), 5);
  assert.equal(await panel.locator('[data-group="attention"] .question').count(), 1);
  assert.equal(await panel.locator('[data-group="attention"] .question').filter({ has: panel.locator("label", { hasText: /^自我介绍/ }) }).count(), 1);
  const optionalAwards = panel.locator('[data-group="optional"] .question').filter({ has: panel.locator("label", { hasText: /^奖惩情况/ }) });
  assert.equal(await optionalAwards.count(), 1);
  assert.equal(await optionalAwards.locator("[data-selected]").isChecked(), false);
  assert.equal(await panel.locator(".question").count(), 6);
  assert.match(await panel.locator("#fill").textContent(), /填写\s*5\s*项/);
  for (const id of ["name", "email", "school", "intro", "awards"]) assert.equal(await target.locator(`#${id}`).inputValue(), "");
  console.log("PASS UI previews all valid answers without writing the target and groups attention separately from other optional questions");
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
  assert.equal(await panel.locator("#results").isVisible(), true);
  assert.equal(await panel.evaluate(() => !!(document.getElementById("results").compareDocumentPosition(document.getElementById("questions")) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  assert.equal(await panel.locator("#resultDone").evaluate((details) => details.open), false);
  assert.equal(await panel.locator('#resultList > .result-row').count(), 1);
  console.log("PASS UI puts fill results above the questions with unsuccessful rows visible and successful rows collapsed");
  assert.deepEqual(storage.local["applicationTracker.profile"], originalProfile);
  assert.equal(storage.local["applicationTracker.assistant.memories.v2"].length, 1);
  assert.equal(storage.local["applicationTracker.assistant.memories.v2"][0].confirmed, false);
  console.log("PASS UI fill preserves manual edits, profile bytes and unconfirmed memories");
  await panel.locator("#undo").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await target.locator("#name").inputValue(), ""); assert.equal(await target.locator("#school").inputValue(), "");
  assert.equal(await target.locator("#intro").inputValue(), "");
  assert.equal(await target.locator("#email").inputValue(), "user-change@example.com");
  console.log("PASS UI undo restores only assistant-written fields");
  await preparePage(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
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
  const privacyMemory = { id: "privacy-confirmed", question: "特殊确认题", answer: "SENTINEL_MEMORY_ANSWER_7731", language: "zh", entityId: "self", scope: "global", confirmed: true, updatedAt: "2026-10-13T00:00:00Z" };
  await writeStorage("local", { "applicationTracker.profile": { ...profile, masterDegreeZh: "硕士" }, "applicationTracker.aiSettings": { enabled: true, apiKey: "fixture-key", model: "fixture-model" }, "applicationTracker.assistant.memories.v2": [...storage.local["applicationTracker.assistant.memories.v2"], privacyMemory] });
  const sentBatches = [];
  const sentRequests = [];
  let rejectDraft = false;
  await panel.route("https://api.openai.com/v1/responses", async (route) => {
    const payload = route.request().postDataJSON();
    const batch = JSON.parse(payload.input[1].content);
    const format = payload.text.format.name;
    sentRequests.push({ payload, batch, format });
    if (format === "job_page_information") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "completed", output_text: JSON.stringify({ company: null, role: null, base: null, confidence: "low" }) }) });
    sentBatches.push(batch);
    if (format === "application_suggestions" && rejectDraft) return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { message: "Fixture rate limit" } }) });
    const output = format === "application_field_pairing"
      ? { pairs: batch.fields.map((field) => {
        const factId = field.label === "学位" ? "education.master.degree.zh" : field.label === "自我介绍" ? "common_answer.selfIntroduction.zh" : null;
        return { fieldId: field.fieldId, source: factId ? "fact" : "none", factId, memoryId: null, transform: "none" };
      }) }
      : { items: batch.fields.flatMap((field) => {
        if (field.label === "自我介绍") return [{ fieldId: field.fieldId, entityId: field.entityId, kind: "draft", factIds: [batch.facts.find((fact) => fact.id.includes("selfIntroduction") || fact.id.startsWith("education.")).id], optionId: null, text: "根据已确认资料准备的 AI 自我介绍草稿。" }];
        return [];
      }) };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "completed", output_text: JSON.stringify(output) }) });
  });
  await preparePage();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  const degree = panel.locator(".question").filter({ has: panel.locator('label', { hasText: /^学位/ }) });
  const location = panel.locator(".question").filter({ has: panel.locator('label', { hasText: /^学校所在地/ }) });
  const intro = panel.locator(".question").filter({ has: panel.locator('label', { hasText: /^自我介绍/ }) });
  assert.equal(await location.locator("[data-answer]").inputValue(), "");
  assert.equal(await location.locator("[data-selected]").isChecked(), false);
  assert.equal(await degree.locator("[data-answer]").inputValue(), "Master's degree");
  assert.equal(await degree.locator("[data-selected]").isChecked(), true);
  assert.equal(await intro.locator("[data-selected]").isChecked(), true);
  assert.equal(await intro.locator("[data-answer]").inputValue(), profile.commonAnswers.selfIntroduction.zh);
  assert.equal(sentRequests.filter((request) => request.format === "application_suggestions").length, 0);
  const pairings = sentRequests.filter((request) => request.format === "application_field_pairing");
  assert.ok(pairings.length > 0);
  for (const request of pairings) {
    const sent = JSON.stringify(request.payload);
    for (const privateValue of [profile.fullNameZh, profile.email, profile.masterUniversityZh, profile.website, profile.commonAnswers.selfIntroduction.zh, privacyMemory.answer, target.url()]) assert.equal(sent.includes(privateValue), false, privateValue);
    assert.equal(request.payload.store, false);
    assert.equal(request.payload.text.format.strict, true);
    assert.equal(request.payload.model, "fixture-model");
    assert.equal(Object.hasOwn(request.batch, "jobText"), false);
    assert.equal(Object.hasOwn(request.batch, "url"), false);
    assert.ok(request.batch.catalog.memories.some((memory) => memory.id === privacyMemory.id));
    assert.ok(request.batch.catalog.facts.every((fact) => !Object.hasOwn(fact, "value")));
  }
  assert.match(await panel.locator("#aiNote").textContent(), /不收资料内容|不接收资料内容/);
  console.log("PASS UI pairs questions from catalog names without sending profile values, memory answers, the page URL or job text");
  await intro.locator("[data-draft]").click();
  await intro.locator("[data-draft-confirmation]").waitFor();
  assert.match(await intro.textContent(), /将发送.*这道题.*岗位描述/);
  await intro.locator("[data-draft-cancel]").click();
  assert.equal(sentRequests.filter((request) => request.format === "application_suggestions").length, 0);
  assert.equal(await intro.locator("[data-answer]").inputValue(), profile.commonAnswers.selfIntroduction.zh);
  rejectDraft = true;
  await intro.locator("[data-draft]").click();
  await intro.locator("[data-draft-send]").click();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await intro.locator("[data-answer]").inputValue(), profile.commonAnswers.selfIntroduction.zh);
  assert.equal(await target.locator("#intro").inputValue(), "");
  rejectDraft = false;
  await intro.locator("[data-draft]").click();
  await intro.locator("[data-draft-send]").click();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await intro.locator("[data-answer]").inputValue(), "根据已确认资料准备的 AI 自我介绍草稿。");
  const drafts = sentRequests.filter((request) => request.format === "application_suggestions");
  assert.equal(drafts.length, 2);
  for (const { batch } of drafts) {
    assert.equal(batch.fields.length, 1);
    assert.equal(batch.fields[0].label, "自我介绍");
    assert.equal(Object.hasOwn(batch.fields[0], "answer"), false);
    assert.equal(Object.hasOwn(batch.fields[0], "value"), false);
    assert.equal(Object.hasOwn(batch, "url"), false);
    assert.ok(batch.facts.length > 0);
    assert.ok(batch.facts.every((fact) => /^common_answer\.selfIntroduction\.|^education\.|^experience\./.test(fact.id)));
    assert.equal(JSON.stringify(batch).includes(privacyMemory.answer), false);
    assert.equal(JSON.stringify(batch).includes(profile.email), false);
    assert.equal(JSON.stringify(batch).includes(profile.website), false);
  }
  console.log("PASS UI sends only one explicitly confirmed draft question, cancellation sends nothing and API errors preserve the original preview answer");
  assert.match(await intro.locator(".source").first().textContent(), /AI 草稿/);
  assert.equal(await target.locator('[role="combobox"] .selected-value').textContent(), "");
  assert.equal(await target.locator("#intro").inputValue(), "");
  assert.equal(await target.locator("#school-location").inputValue(), "");
  assert.equal(await target.locator("#degree-menu").isVisible(), false);
  assert.deepEqual((await degree.locator('[data-answer] option').allTextContents()).filter(Boolean).slice(-2), ["Bachelor's degree", "Master's degree"]);
  assert.ok(pairings.every(({ batch }) => !batch.fields.some((field) => field.label === "学位")), "Exact local degree matching should not send another AI request");
  assert.match(await panel.locator("#fill").textContent(), /填写\s*2\s*项/);
  // No per-question checking: the only write action is this explicit batch confirmation.
  await panel.locator("#fill").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await target.locator('[role="combobox"] .selected-value').textContent(), "Master's degree");
  assert.equal(await target.locator("#intro").inputValue(), "根据已确认资料准备的 AI 自我介绍草稿。");
  assert.equal(await target.locator("#school-location").inputValue(), "");
  await panel.locator("#saveResults").click();
  assert.equal(await panel.locator("[data-learn]").count(), 2);
  assert.equal(await panel.locator("[data-learn-check]:checked").count(), 2);
  assert.equal(storage.local["applicationTracker.assistant.memories.v2"].length, 2);
  console.log("PASS UI previews delayed real options and validated AI prose, then fills both with one confirmation and previews all result memories");

  await panel.locator("#undo").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await target.locator("#intro").inputValue(), "");
  // This custom control has no clear option; reset the synthetic fixture as a
  // user's manual clear before testing a fresh preview, not as an undo guarantee.
  await target.locator('[role="combobox"] .selected-value').evaluate((node) => { node.textContent = ""; });
  await refreshPreview(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  await panel.locator("#clearSelection").click();
  await intro.locator("[data-answer]").fill("人工核对的草稿");
  assert.equal(await intro.locator("[data-selected]").isChecked(), true);
  await target.locator("form").evaluate((form) => form.insertAdjacentHTML("beforeend", '<section><h2>基本信息</h2><label>邮箱<input type="email" required></label></section>'));
  await refreshPreview(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
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
  await refreshPreview(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.notEqual(await intro.locator("[data-answer]").inputValue(), "人工核对的草稿");
  assert.equal(await intro.locator("[data-selected]").isChecked(), false);
  assert.equal(await email.locator("[data-selected]").isChecked(), true);
  assert.equal(await panel.locator('[data-selected]:checked').count(), 1);
  assert.equal(await target.locator('input[type="email"]').inputValue(), "");
  console.log("PASS UI changing language discards old-language drafts while selecting valid new-language answers for preview");

  await panel.locator("#language").selectOption("zh");
  await refreshPreview(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  await intro.locator("[data-answer]").fill("第一版回答");
  assert.equal(await intro.locator("[data-selected]").isChecked(), true);
  await panel.locator("#fill").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await target.locator("#intro").inputValue(), "第一版回答");
  await target.locator("#intro").fill("");
  await refreshPreview(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  await intro.locator("[data-answer]").fill("第二版回答");
  assert.equal(await intro.locator("[data-selected]").isChecked(), true);
  await panel.locator("#fill").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await target.locator("#intro").inputValue(), "第二版回答");
  const introResults = panel.locator(".result-row").filter({ has: panel.locator('strong', { hasText: /^自我介绍$/ }) });
  assert.equal(await introResults.count(), 2);
  assert.equal(await panel.locator("[data-save-answer]").count(), 0);
  await panel.locator("#saveResults").click();
  const introLearning = panel.locator("[data-learn]").filter({ has: panel.locator('label', { hasText: /自我介绍/ }) });
  assert.equal(await introLearning.count(), 1);
  for (const checkbox of await panel.locator("[data-learn-check]").all()) await checkbox.uncheck();
  await introLearning.locator("[data-learn-check]").check();
  assert.equal(await introLearning.locator("[data-learn-answer]").inputValue(), "第二版回答");
  // A subsequent language change must not relabel a previously opened answer preview.
  await panel.locator("#language").selectOption("en");
  await refreshPreview(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await introLearning.locator("[data-learn-check]").isChecked(), true);
  await panel.locator("#saveLearned").click();
  await panel.waitForFunction(() => document.getElementById("learnPreview").hidden);
  const learned = storage.local["applicationTracker.assistant.memories.v2"].find((item) => item.answer === "第二版回答");
  assert.ok(learned); assert.equal(learned.language, "zh");
  assert.equal(learned.question, "自我介绍");
  console.log("PASS UI saves the chosen fill operation and preserves its original language across refreshes");

  await panel.locator("#menuButton").click();
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
  const visualTextRequests = [];
  let rejectVisual = false;
  await panel.route("https://api.openai.com/v1/responses", async (route) => {
    const payload = route.request().postDataJSON();
    const isVisual = payload.text.format.name === "application_visual_observations";
    if (!isVisual) visualTextRequests.push(payload);
    const batch = JSON.parse(isVisual ? payload.input[1].content[0].text : payload.input[1].content);
    if (isVisual) {
      visualRequests.push(payload);
      if (rejectVisual) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { message: "Image input unsupported by fixture model" } }) });
    }
    const output = isVisual
      ? { observations: batch.fields.filter((field) => field.label === "未命名问题").map((field) => ({ fieldId: field.fieldId, marker: field.marker, label: "学校名称", section: "本科教育", confidence: 0.98 })) }
      : payload.text.format.name === "job_page_information"
        ? { company: null, role: null, base: null, confidence: "low" }
      : payload.text.format.name === "application_field_pairing"
        ? { pairs: batch.fields.map((field) => ({ fieldId: field.fieldId, source: "none", factId: null, memoryId: null, transform: "none" })) }
        : { items: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "completed", output_text: JSON.stringify(output) }) });
  });
  await visionFixture();
  await writeStorage("local", { "applicationTracker.profile": visualProfile, "applicationTracker.aiSettings": visualSettings });
  await panel.locator("#language").selectOption("zh");
  await preparePage(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
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
  assert.match(await imageSchool.locator(".status").textContent(), /请核对/);
  assert.match(await panel.locator("#visionStatus").textContent(), /辅助识别 1 项/);
  assert.equal(await target.locator("#image-field").inputValue(), "");
  assert.equal(await target.locator("#email").inputValue(), "");
  assert.ok(!JSON.stringify(storage).includes("data:image/"));
  await panel.screenshot({ path: path.join(artifacts, "assistant-visual-preview.png"), fullPage: true });
  await imageSchool.locator("[data-answer]").fill("人工核对的本科院校");
  await refreshPreview(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await imageSchool.locator("[data-answer]").inputValue(), "人工核对的本科院校");
  assert.equal(await imageSchool.locator("[data-selected]").isChecked(), true);
  assert.match(await imageSchool.textContent(), /截图辅助/);
  assert.equal(captureCalls, 1); assert.equal(visualRequests.length, 1);
  assert.equal(await target.locator("#image-field").inputValue(), "");
  console.log("PASS UI refreshing a visually identified question preserves its manual draft without asking vision to rewrite it");

  await expandQuestions();
  if (!await panel.locator("[data-binding]").isVisible()) await panel.locator(".binding > summary").click();
  await panel.locator("[data-binding]").selectOption("education.bachelor");
  await panel.waitForFunction(() => document.querySelector('[aria-label="学校名称的答案"]').value === "截图测试本科大学");
  await refreshPreview(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
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
  await preparePage(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  await expandQuestions();
  assert.equal(captureCalls, 1); assert.equal(visualRequests.length, 1);
  assert.equal(await panel.locator("#visionStatus").isVisible(), false);
  assert.equal(await panel.getByRole("textbox", { name: "未命名问题的答案", exact: true }).inputValue(), "");
  assert.equal(await panel.getByRole("textbox", { name: "邮箱的答案", exact: true }).inputValue(), profile.email);
  console.log("PASS UI vision opt-out sends no screenshot and preserves ordinary text preparation");

  // Start with a fresh, unresolved visual field; the prior manual education
  // binding is intentionally preserved by a refresh and must not mask this case.
  await visionFixture();
  await writeStorage("local", { "applicationTracker.aiSettings": visualSettings });
  activeTabId = 2;
  await preparePage(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  await expandQuestions();
  assert.equal(captureCalls, 1); assert.equal(visualRequests.length, 1);
  assert.match(await panel.locator("#visionStatus").textContent(), /继续使用文字识别/);
  assert.equal(await panel.getByRole("textbox", { name: "邮箱的答案", exact: true }).inputValue(), profile.email);
  assert.equal(await target.locator("#image-field").inputValue(), "");
  activeTabId = 1;
  console.log("PASS UI an unrelated active tab prevents capture and falls back to the bound form's text preview");

  rejectVisual = true;
  await preparePage(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  await expandQuestions();
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
  await preparePage(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
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
  await preparePage(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
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
  await preparePage(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.match(await panel.locator("#pageTypeNotice").textContent(), /尚未确定页面类型/);
  assert.equal(await panel.locator("[data-selected]:checked").count(), 1);
  assert.equal(await target.locator("#uncertain-email").inputValue(), "");
  await target.setContent('<!doctype html><title>岗位详情</title><div class="job-description">工作职责：负责日常财务分析和报表编制。</div><label>邮箱<input id="job-email"></label>');
  await preparePage(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await panel.locator("[data-selected]:checked").count(), 1);
  assert.equal(await target.locator("#job-email").inputValue(), "");
  console.log("PASS UI keeps detected controls available on unknown or job-like pages and writes nothing before confirmation");

  await target.setContent('<!doctype html><title>信息表</title><input id="placeholder-question" placeholder="您的补充说明"><input id="unknown-question">');
  await preparePage(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await panel.locator("[data-label-warning]").count(), 2);
  assert.ok((await panel.locator("[data-label-warning]").allTextContents()).every((text) => text === "题目未识别"));
  console.log("PASS UI marks placeholder-only and unlabeled questions for review");

  const failedWriteFixture = async ({ reject = true, clear = false } = {}) => {
    await target.setContent('<!doctype html><title>申请信息</title><form><section><h2>基本信息</h2><label>姓名<input id="failed-name"></label><label>邮箱<input id="failed-email" type="email"></label></section></form>');
    await target.locator("#failed-name").evaluate((input, { reject, clear }) => {
      input.addEventListener("input", () => {
        if (clear) input.value = "";
        input.setCustomValidity(reject && input.value ? "Synthetic validation rejection" : "");
      });
    }, { reject, clear });
    await preparePage(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
    await expandQuestions();
    await panel.locator("#clearSelection").click();
    await panel.getByRole("checkbox", { name: "选中姓名", exact: true }).check();
  };
  const completePanelAction = async (id) => {
    if (id === "#prepare") await preparePage(); else await panel.locator(id).click();
    await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  };
  const sessionKey = "applicationTracker.assistant.session.1";
  await failedWriteFixture();
  await completePanelAction("#fill");
  assert.equal(await target.locator("#failed-name").inputValue(), profile.fullNameZh);
  const failedChange = storage.session[sessionKey].results[0];
  assert.equal(failedChange.status, "failed"); assert.equal(failedChange.code, "VALIDATION_FAILED");
  assert.equal(failedChange.undoable, true); assert.equal(failedChange.before, ""); assert.equal(failedChange.after, profile.fullNameZh);
  assert.equal(await panel.locator("#undo").isDisabled(), false);
  assert.equal(await panel.locator("[data-save-answer]").count(), 0);
  assert.match(await panel.locator("#resultSummary").textContent(), /写入失败但可撤销 1 项/);
  await expandQuestions();
  await panel.getByRole("checkbox", { name: "选中邮箱", exact: true }).check();
  await completePanelAction("#fill");
  assert.equal(storage.session[sessionKey].results.length, 2);
  assert.equal(storage.session[sessionKey].results[0].operationId, failedChange.operationId);
  await completePanelAction("#undo");
  assert.equal(await target.locator("#failed-name").inputValue(), "");
  assert.equal(await target.locator("#failed-email").inputValue(), "");
  assert.ok(storage.session[sessionKey].results.every((result) => result.undone));
  assert.equal(await panel.locator("#undo").isDisabled(), true);
  console.log("PASS UI preserves failed assistant changes across later fills and undoes them without offering them as verified memories");

  await failedWriteFixture({ clear: true });
  await completePanelAction("#fill");
  const unchangedFailure = storage.session[sessionKey].results[0];
  assert.equal(unchangedFailure.status, "failed"); assert.equal(unchangedFailure.before, unchangedFailure.after);
  assert.equal(await target.locator("#failed-name").inputValue(), "");
  assert.equal(await panel.locator("#undo").isDisabled(), true);
  console.log("PASS UI leaves undo disabled when a failed write did not change the field");

  await failedWriteFixture({ reject: false });
  await panel.locator("#fill").click();
  await target.waitForFunction((expected) => document.getElementById("failed-name").value === expected, profile.fullNameZh);
  await target.locator("#failed-name").fill("人工修改的姓名");
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  const userChange = storage.session[sessionKey].results[0];
  assert.equal(userChange.status, "skipped"); assert.equal(userChange.code, "USER_EDITED");
  assert.notEqual(userChange.before, userChange.after);
  assert.equal(await target.locator("#failed-name").inputValue(), "人工修改的姓名");
  assert.equal(await panel.locator("#undo").isDisabled(), true);
  console.log("PASS UI never treats a user's trusted edit during a failed operation as an assistant change");

  await failedWriteFixture();
  await completePanelAction("#fill");
  const completedFailure = storage.session[sessionKey].results[0];
  // Recreate the persisted state at an interrupted response boundary. The real
  // page bridge still owns the completed operation and supplies its cached result.
  storage.session[sessionKey].pending = Object.fromEntries(["operationId", "fieldId", "answer", "undo", "label", "contextPath", "entityId", "language", "pageUrl"].map((key) => [key, completedFailure[key]]));
  storage.session[sessionKey].results = [];
  const interruptedItem = storage.session[sessionKey].plan.find((item) => item.fieldId === completedFailure.fieldId);
  Object.assign(interruptedItem, { value: "", status: "ready", selected: true });
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById("resultSummary").textContent.includes("写入失败但可撤销 1 项"));
  assert.equal(await panel.locator("#undo").isDisabled(), false);
  assert.equal(storage.session[sessionKey].results.length, 1);
  await target.locator("#failed-name").fill("失败后的人工修正");
  await completePanelAction("#undo");
  assert.equal(await target.locator("#failed-name").inputValue(), "失败后的人工修正");
  assert.equal(storage.session[sessionKey].results[0].undone, undefined);
  assert.equal(storage.session[sessionKey].results[0].undoBlocked, true);
  assert.equal(await panel.locator("#undo").isDisabled(), true);
  assert.match(await panel.locator("#resultList").textContent(), /撤销未完成/);
  console.log("PASS UI recovers failed changes after interruption and refuses undo after a later manual correction");

  const cleanupFixture = async (mode) => {
    await target.setContent('<!doctype html><title>申请信息</title><form><section><h2>硕士教育</h2><div id="cleanup-select" role="combobox" aria-label="学位" aria-controls="cleanup-menu" aria-expanded="false" tabindex="0" style="padding:16px"><span class="selected-value"></span></div><ul id="cleanup-menu" role="listbox" hidden><li role="option">Bachelor\'s degree</li><li role="option">Master\'s degree</li></ul><p id="cleanup-error" data-error hidden>Synthetic validation rejection</p></section></form>');
    await target.evaluate((mode) => {
      const control = document.getElementById("cleanup-select");
      const selected = control.querySelector(".selected-value");
      const menu = document.getElementById("cleanup-menu");
      const close = () => { menu.hidden = true; control.setAttribute("aria-expanded", "false"); };
      let hasSelection = false;
      control.addEventListener("click", () => {
        if (control.getAttribute("aria-expanded") === "true") return close();
        menu.hidden = false; control.setAttribute("aria-expanded", "true");
      });
      menu.addEventListener("click", (event) => {
        if (!event.target.matches('[role="option"]')) return;
        selected.textContent = event.target.textContent;
        hasSelection = true;
        if (mode === "validation-overwrite") document.getElementById("cleanup-error").hidden = false;
        // Keep the popup open after selection, so dismissal occurs only after
        // verification. This exposes the real bridge's cleanup window.
      });
      control.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (!hasSelection) return close(); // Option inspection must stay ordinary.
        control.dataset.cleanupStarted = "true";
        control.dataset.valueBeforeCleanup = selected.textContent;
        if (mode !== "trusted-edit") setTimeout(() => { selected.textContent = "Bachelor's degree"; }, 120);
        setTimeout(close, 450);
      });
    }, mode);
    await completePanelAction("#prepare");
    await expandQuestions();
    await panel.getByRole("combobox", { name: "学位的答案", exact: true }).selectOption("Master's degree");
    assert.equal(await panel.getByRole("checkbox", { name: "选中学位", exact: true }).isChecked(), true);
  };

  await cleanupFixture("trusted-edit");
  await panel.locator("#fill").click();
  await target.waitForFunction(() => document.getElementById("cleanup-select").dataset.cleanupStarted === "true");
  assert.equal(await target.locator("#cleanup-select").getAttribute("data-value-before-cleanup"), "Master's degree");
  await target.getByRole("option", { name: "Bachelor's degree", exact: true }).click();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  const cleanupUserEdit = storage.session[sessionKey].results[0];
  assert.equal(cleanupUserEdit.status, "skipped"); assert.equal(cleanupUserEdit.code, "USER_EDITED");
  assert.equal(await target.locator("#cleanup-select .selected-value").textContent(), "Bachelor's degree");
  assert.equal(await panel.locator("#undo").isDisabled(), true);
  assert.equal(await panel.locator("[data-save-answer]").count(), 0);
  console.log("PASS UI rejects a trusted edit during popup dismissal after verification instead of reporting a successful fill");

  await cleanupFixture("validation-overwrite");
  await completePanelAction("#fill");
  const cleanupValidation = storage.session[sessionKey].results[0];
  assert.equal(cleanupValidation.status, "failed"); assert.equal(cleanupValidation.code, "VALIDATION_FAILED");
  assert.equal(await target.locator("#cleanup-select").getAttribute("data-value-before-cleanup"), "Master's degree");
  assert.equal(await target.locator("#cleanup-select .selected-value").textContent(), "Bachelor's degree");
  assert.equal(cleanupValidation.undoable, false);
  assert.equal(await panel.locator("#undo").isDisabled(), true);
  assert.equal(await panel.locator("[data-save-answer]").count(), 0);
  console.log("PASS UI does not claim a site's different value written during cleanup after validation failed");

  await cleanupFixture("verified-overwrite");
  await completePanelAction("#fill");
  const cleanupOverwrite = storage.session[sessionKey].results[0];
  assert.equal(cleanupOverwrite.status, "failed"); assert.equal(cleanupOverwrite.code, "VALUE_NOT_RETAINED");
  assert.equal(await target.locator("#cleanup-select").getAttribute("data-value-before-cleanup"), "Master's degree");
  assert.equal(await target.locator("#cleanup-select .selected-value").textContent(), "Bachelor's degree");
  assert.equal(cleanupOverwrite.undoable, false);
  assert.equal(await panel.locator("#undo").isDisabled(), true);
  assert.equal(await panel.locator("[data-save-answer]").count(), 0);
  console.log("PASS UI checks the final value after popup dismissal and rejects a previously verified value that the site replaced");

  await target.goto(origin + "/apply");
  await writeStorage("local", { "applicationTracker.aiSettings": { ...visualSettings, visionEnabled: false } });
  await completePanelAction("#prepare");
  const staleIntro = panel.locator('.question').filter({ has: panel.locator('label', { hasText: /^自我介绍/ }) });
  await staleIntro.locator("[data-draft]").click();
  await staleIntro.locator("[data-draft-confirmation]").waitFor();
  const draftCountBeforeStale = visualTextRequests.filter((request) => request.text.format.name === "application_suggestions").length;
  await target.reload();
  await panel.waitForFunction(() => document.getElementById("fill").disabled && document.getElementById("message").textContent.includes("变化"));
  const sendAfterStale = staleIntro.locator("[data-draft-send]");
  assert.ok(await sendAfterStale.count() === 0 || await sendAfterStale.isDisabled());
  if (await sendAfterStale.count()) await sendAfterStale.dispatchEvent("click");
  assert.equal(visualTextRequests.filter((request) => request.text.format.name === "application_suggestions").length, draftCountBeforeStale);
  assert.equal(await target.locator("#intro").inputValue(), "");
  console.log("PASS UI revokes a draft confirmation after page changes and a queued send cannot issue an AI request");
  await writeStorage("local", { "applicationTracker.aiSettings": { enabled: false } });

  await target.goto(origin + "/apply");
  await target.evaluate(() => {
    document.body.innerHTML = `<form><section><h2>申请问题</h2>${Array.from({ length: 25 }, (_, index) => `<label>补充说明 ${index + 1}<textarea required></textarea></label>`).join("")}</section></form>`;
  });
  await completePanelAction("#prepare");
  const visibleQuestionCount = () => panel.locator(".question").evaluateAll((nodes) => nodes.filter((node) => node.getBoundingClientRect().height > 0).length);
  assert.equal(await panel.locator('.question').count(), 25);
  assert.equal(await visibleQuestionCount(), 15);
  await panel.locator("#showAll").click();
  assert.equal(await panel.locator('.question').count(), 25);
  assert.equal(await visibleQuestionCount(), 25);
  await panel.locator("#showAll").click();
  assert.equal(await visibleQuestionCount(), 15);
  await panel.locator("[data-more-toggle]").click();
  assert.equal(await panel.locator('.question').count(), 25);
  assert.equal(await visibleQuestionCount(), 25);
  console.log("PASS UI renders all 25 attention questions while hiding overflow, and normal expand controls reveal them without deleting rows");

  const recordCount = () => (storage.local["applicationTracker.records"] || []).length;
  const recordBaseline = recordCount();
  const recordFixture = async (structured = true) => {
    await target.goto(origin + "/apply");
    await target.evaluate((structured) => {
      document.title = "填写简历";
      document.body.innerHTML = '<form><section><h2>基本信息</h2><label>姓名<input id="record-name"></label><label>邮箱<input id="record-email" type="email"></label></section></form>';
      if (structured) {
        const node = document.createElement("script"); node.type = "application/ld+json";
        node.textContent = JSON.stringify({ "@type": "JobPosting", title: "分析师", hiringOrganization: { name: "示例投递公司" }, jobLocation: { address: { addressLocality: "香港" } } });
        document.head.appendChild(node);
      }
    }, structured);
  };
  await recordFixture();
  await completePanelAction("#prepare");
  assert.equal(await panel.locator("#recordCard").isVisible(), false);
  assert.equal(recordCount(), recordBaseline);
  await completePanelAction("#fill");
  await panel.waitForFunction(() => document.getElementById("recordRole")?.value === "分析师");
  assert.equal(await panel.locator("#recordCard").isVisible(), true);
  assert.equal(await panel.locator("#recordCompany").inputValue(), "示例投递公司");
  assert.match(await panel.locator("#recordCard [data-record-origin]").textContent(), /结构化数据/);
  assert.equal(recordCount(), recordBaseline);
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await panel.locator("#recordCard").scrollIntoViewIfNeeded();
  await panel.screenshot({ path: path.join(artifacts, "assistant-record-card.png"), fullPage: true });
  console.log("PASS UI prepares structured job information without saving and shows its source in the record card only after filling");

  await panel.locator("#saveRecord").click();
  await panel.waitForFunction(() => document.getElementById("recordCard")?.textContent.includes("已记录 ✓") && !document.getElementById("prepare").disabled);
  assert.equal(recordCount(), recordBaseline + 1);
  const savedRecord = storage.local["applicationTracker.records"].at(-1);
  assert.deepEqual([savedRecord.company, savedRecord.role, savedRecord.portalLink, savedRecord.status, savedRecord.appliedDate], ["示例投递公司", "分析师", target.url(), "applied", toDateInputValue()]);
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById("recordCard")?.textContent.includes("已记录 ✓"));
  assert.equal(await panel.locator("#recordCard #saveRecord, #recordCard #saveRecordAnyway").count(), 0);
  assert.equal(recordCount(), recordBaseline + 1);
  console.log("PASS UI saves a record only after a click, preserves the correct page and date, and restores its saved state on panel reload");

  await recordFixture();
  await completePanelAction("#prepare");
  await completePanelAction("#fill");
  await panel.locator("#saveRecordAnyway").waitFor();
  assert.match(await panel.locator("#recordCard").textContent(), /已记录过：示例投递公司.*分析师/);
  assert.equal(recordCount(), recordBaseline + 1);
  await panel.locator("#recordRole").fill("人工核对岗位");
  assert.equal(await panel.locator("#saveRecordAnyway").isDisabled(), true);
  await panel.locator("#recordRole").press("Tab");
  await panel.waitForFunction(() => document.getElementById("saveRecordAnyway") && !document.getElementById("saveRecordAnyway").disabled);
  assert.equal(await panel.locator("#recordRole").inputValue(), "人工核对岗位");
  assert.equal(recordCount(), recordBaseline + 1);
  await panel.locator("#saveRecordAnyway").click();
  await panel.waitForFunction(() => document.getElementById("recordCard")?.textContent.includes("已记录 ✓") && !document.getElementById("prepare").disabled);
  assert.equal(recordCount(), recordBaseline + 2);
  assert.equal(storage.local["applicationTracker.records"].at(-1).role, "人工核对岗位");
  console.log("PASS UI rechecks duplicates after an edit and blur, and records again only after the separate still-record confirmation");

  await recordFixture(false);
  await completePanelAction("#prepare");
  await completePanelAction("#fill");
  await panel.locator("#recordRecent").waitFor();
  assert.equal(await panel.locator("#recordCompany").inputValue(), "");
  assert.equal(await panel.locator("#recordRole").inputValue(), "");
  await panel.locator("#saveRecordAnyway").click();
  await panel.locator("#recordCard [data-record-error]").waitFor();
  assert.match(await panel.locator("#recordCard [data-record-error]").textContent(), /请填写公司.*请填写岗位/);
  assert.equal(recordCount(), recordBaseline + 2);
  await panel.locator("#recordRecent").selectOption("0");
  await panel.waitForFunction(() => document.getElementById("recordRole")?.value === "分析师");
  assert.equal(await panel.locator("#recordCompany").inputValue(), "示例投递公司");
  assert.match(await panel.locator("#recordCard [data-record-origin]").textContent(), /最近岗位/);
  assert.equal(recordCount(), recordBaseline + 2);
  console.log("PASS UI keeps recent jobs as unselected candidates, reports empty required record fields inline and fills a recent job only after selection");

  await panel.unroute("https://api.openai.com/v1/responses");
  let releaseJobInfo;
  let jobRequested = false;
  const jobGate = new Promise((resolve) => { releaseJobInfo = resolve; });
  await panel.route("https://api.openai.com/v1/responses", async (route) => {
    const payload = route.request().postDataJSON(), batch = JSON.parse(payload.input[1].content);
    const format = payload.text.format.name;
    let output;
    if (format === "job_page_information") {
      jobRequested = true; await jobGate;
      output = { company: "AI 识别公司", role: "AI 识别岗位", base: "香港", confidence: "medium" };
    } else if (format === "application_field_pairing") output = { pairs: batch.fields.map((field) => ({ fieldId: field.fieldId, source: "none", factId: null, memoryId: null, transform: "none" })) };
    else output = { items: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "completed", output_text: JSON.stringify(output) }) });
  });
  await recordFixture(false);
  await writeStorage("local", { "applicationTracker.aiSettings": { ...visualSettings, visionEnabled: false } });
  const jobStarted = panel.waitForRequest((request) => request.url() === "https://api.openai.com/v1/responses" && request.postDataJSON().text.format.name === "job_page_information");
  await completePanelAction("#prepare");
  await jobStarted;
  await completePanelAction("#fill");
  assert.equal(jobRequested, true);
  await panel.locator("#recordCompany").fill("手动填写公司");
  await panel.locator("#recordRole").fill("手动填写岗位");
  await panel.locator("#recordRole").fill("");
  releaseJobInfo();
  await panel.waitForFunction(async () => {
    const key = "applicationTracker.assistant.session.1";
    return (await chrome.storage.session.get(key))[key]?.recordDraft?.base === "香港";
  });
  assert.equal(await panel.locator("#recordCompany").inputValue(), "手动填写公司");
  assert.equal(await panel.locator("#recordRole").inputValue(), "");
  assert.equal(recordCount(), recordBaseline + 2);
  console.log("PASS UI a late public job AI response preserves manual company edits and a deliberately cleared role");

  await panel.locator("#recordRole").fill("人工岗位");
  await panel.locator("#recordRole").press("Tab");
  await panel.waitForFunction(() => document.getElementById("saveRecordAnyway") && !document.getElementById("saveRecordAnyway").disabled);
  let releaseRecord;
  const recordEntered = new Promise((resolve) => { recordGate = { entered: resolve, wait: new Promise((release) => { releaseRecord = release; }) }; });
  await panel.locator("#saveRecordAnyway").click();
  await recordEntered;
  assert.equal(await panel.locator("#recordCompany").isDisabled(), true);
  assert.equal(await panel.locator("#recordRole").isDisabled(), true);
  assert.equal(await panel.locator("#prepare").isDisabled(), true);
  await panel.locator("#saveRecordAnyway").dispatchEvent("click");
  await target.reload();
  await panel.evaluate(() => chrome.tabs.onUpdated.emit(1, { status: "loading" }));
  releaseRecord();
  await panel.waitForFunction(() => document.getElementById("recordCard")?.textContent.includes("已记录 ✓") && !document.getElementById("prepare").disabled);
  assert.equal(recordCount(), recordBaseline + 3);
  assert.match(await panel.locator("#recordCard").textContent(), /已记录.*页面已变化/);
  assert.ok(storage.session[sessionKey].recordSaved?.id);
  assert.equal(storage.local["applicationTracker.records"].at(-1).role, "人工岗位");
  console.log("PASS UI freezes record saving, rejects duplicate clicks and keeps a committed save marked successful when navigation precedes its response");
  await panel.unroute("https://api.openai.com/v1/responses");
  const aliasLabel = "请举例说明你是如何解决问题的", broadLabel = "你如何处理工作中信息不完整的情况？";
  const openMemory = { id: "open-memory-review", question: "分享一个克服困难的经历", answer: "已确认的解决问题经历", language: "zh", entityId: "self", scope: "global", confirmed: true, updatedAt: "2026-10-14T00:00:00Z" };
  let broadDraftRequests = 0;
  await panel.route("https://api.openai.com/v1/responses", async (route) => {
    const payload = route.request().postDataJSON(), batch = JSON.parse(payload.input[1].content), format = payload.text.format.name;
    let output;
    if (format === "application_field_pairing") {
      assert.ok(!JSON.stringify(batch).includes(openMemory.answer));
      output = { pairs: batch.fields.map((field) => ({ fieldId: field.fieldId, source: field.label === aliasLabel ? "memory" : "none", memoryId: field.label === aliasLabel ? openMemory.id : null, factId: null, transform: "none" })) };
    } else if (format === "application_suggestions") {
      broadDraftRequests++;
      assert.equal(batch.fields.length, 1); assert.equal(batch.fields[0].label, broadLabel);
      assert.ok(batch.facts.length); assert.equal(Object.hasOwn(batch, "url"), false);
      assert.ok(!JSON.stringify(batch).includes(profile.email));
      output = { items: [{ fieldId: batch.fields[0].fieldId, entityId: "self", kind: "draft", factIds: [batch.facts[0].id], text: "经确认资料整理的长文本草稿。", optionId: null }] };
    } else output = { company: null, role: null, base: null, confidence: "low" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "completed", output_text: JSON.stringify(output) }) });
  });
  await writeStorage("local", { "applicationTracker.profile": profile, "applicationTracker.aiSettings": { enabled: true, apiKey: "fixture-key", model: "fixture-model", visionEnabled: false }, "applicationTracker.assistant.memories.v2": [openMemory] });
  await target.setContent(`<!doctype html><title>申请表</title><label>${aliasLabel}<textarea id="alias-memory"></textarea></label><label>${broadLabel}<textarea id="broad-text"></textarea></label>`);
  await completePanelAction("#prepare"); await expandQuestions();
  const alias = panel.locator(".question").filter({ has: panel.getByRole("textbox", { name: aliasLabel + "的答案", exact: true }) });
  assert.equal(await alias.locator("[data-answer]").inputValue(), openMemory.answer);
  assert.equal(await alias.locator("[data-selected]").isChecked(), false);
  assert.equal(await panel.locator("#fill").isDisabled(), true);
  assert.equal(await target.locator("#alias-memory").inputValue(), "");
  await alias.locator("[data-selected]").check(); await completePanelAction("#fill");
  assert.equal(await target.locator("#alias-memory").inputValue(), openMemory.answer);
  assert.equal(await target.locator("#broad-text").inputValue(), "");
  assert.equal(await panel.locator("#countSkip").textContent(), "不填 1");
  assert.equal(await panel.locator("#barActions #prepare").count(), 0);
  console.log("PASS UI rephrased prose memory stays unselected until checked, and filled answers leave the skip count");
  const broad = panel.locator(".question").filter({ has: panel.getByRole("textbox", { name: broadLabel + "的答案", exact: true }) });
  await broad.locator("[data-draft]").click(); await broad.locator("[data-draft-confirmation]").waitFor();
  assert.equal(broadDraftRequests, 0);
  await broad.locator("[data-draft-cancel]").click(); assert.equal(broadDraftRequests, 0);
  await broad.locator("[data-draft]").click(); await broad.locator("[data-draft-confirmation]").waitFor();
  await broad.locator("[data-draft-send]").click(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(broadDraftRequests, 1);
  assert.equal(await broad.locator("[data-answer]").inputValue(), "经确认资料整理的长文本草稿。");
  assert.equal(await target.locator("#broad-text").inputValue(), "");
  await completePanelAction("#fill"); assert.equal(await target.locator("#broad-text").inputValue(), "经确认资料整理的长文本草稿。");
  await writeStorage("local", { "applicationTracker.profile": { email: profile.email } });
  await target.setContent('<!doctype html><title>申请表</title><label>请说明你的解决问题思路<textarea id="no-draft-facts"></textarea></label>');
  await completePanelAction("#prepare"); await expandQuestions();
  assert.equal(await panel.locator("[data-draft]").count(), 1);
  assert.equal(await panel.locator("[data-draft]").isDisabled(), true);
  assert.match(await panel.locator("#questions").textContent(), /暂无可引用资料/);
  assert.equal(broadDraftRequests, 1);
  console.log("PASS UI an arbitrary long-text question sends only its confirmed fact batch and waits for fill confirmation");

  await writeStorage("local", { "applicationTracker.profile": profile, "applicationTracker.aiSettings": { enabled: false } });
  await target.setContent('<!doctype html><title>站点访问恢复</title><label>姓名<input id="permission-name"></label>');
  const permissionsBefore = permissionRequests.length;
  mainPermissionDenied = true;
  await completePanelAction("#prepare"); await panel.locator("#allowPageAccess").waitFor();
  assert.match(await panel.locator("#message").textContent(), /尚未获得.*读取权限/);
  assert.equal(await panel.locator("#targetTitle").textContent(), "站点访问恢复");
  assert.equal(permissionRequests.length, permissionsBefore, "Scanning must never request a permission");
  assert.equal(await panel.locator("#fill").isDisabled(), true, "An unsuccessful rescan invalidates the old preview");
  await panel.locator("#allowPageAccess").click();
  await panel.waitForFunction(() => !document.getElementById("allowPageAccess").disabled);
  assert.match(await panel.locator("#message").textContent(), /尚未允许/);
  assert.equal(await target.locator("#permission-name").inputValue(), "");
  assert.deepEqual(permissionRequests.at(-1).request, { origins: [origin + "/*"] });
  assert.equal(permissionRequests.at(-1).userGesture, true);
  allowMainPermission = true;
  await panel.locator("#allowPageAccess").click();
  await panel.waitForFunction(() => document.getElementById("allowPageAccess").hidden && !document.getElementById("prepare").disabled && !document.getElementById("fill").disabled);
  assert.equal(await target.locator("#permission-name").inputValue(), "", "A grant prepares a preview without filling");
  assert.equal(permissionRequests.length, permissionsBefore + 2);
  console.log("PASS UI requests only the failed main site after a user click, supports denial and retry, and previews without filling");

  mainScriptFault = true;
  await completePanelAction("#prepare");
  await panel.waitForFunction(() => document.getElementById("message").textContent.includes("PAGE_SCAN_FAILED"));
  assert.equal(await panel.locator("#allowPageAccess").isVisible(), false);
  assert.equal(await panel.locator("#fill").isDisabled(), true);
  assert.equal((await panel.locator("#message").textContent()).includes("private-token"), false);
  assert.equal(permissionRequests.length, permissionsBefore + 2);
  // A grant may succeed while the page's scan itself still fails. Report that
  // separate failure rather than leaving the panel stuck on 'scanning'.
  mainPermissionDenied = true;
  await completePanelAction("#prepare"); await panel.locator("#allowPageAccess").waitFor();
  await panel.locator("#allowPageAccess").click();
  await panel.waitForFunction(() => document.getElementById("message").textContent.includes("PAGE_SCAN_FAILED") && !document.getElementById("prepare").disabled);
  assert.equal(await panel.locator("#allowPageAccess").isVisible(), false);
  assert.equal(permissionRequests.length, permissionsBefore + 3);
  mainScriptFault = false;
  console.log("PASS UI keeps script failures separate from access requests and disables the old preview");

  mainPermissionDenied = true;
  await completePanelAction("#prepare"); await panel.locator("#allowPageAccess").waitFor();
  let releasePermission;
  const permissionEntered = new Promise((resolve) => { mainPermissionGate = { entered: resolve, wait: new Promise((release) => { releasePermission = release; }) }; });
  await panel.locator("#allowPageAccess").click(); await permissionEntered;
  const scansBeforeGrant = mainScanCalls;
  await panel.evaluate(() => chrome.tabs.onUpdated.emit(1, { status: "loading" }));
  assert.equal(await panel.locator("#allowPageAccess").isVisible(), false);
  releasePermission();
  await panel.waitForFunction(() => !document.getElementById("allowPageAccess").disabled);
  assert.equal(mainScanCalls, scansBeforeGrant, "A grant for an obsolete recovery cannot trigger a new scan");
  assert.equal(await target.locator("#permission-name").inputValue(), "");
  await panel.locator("#allowPageAccess").dispatchEvent("click");
  assert.equal(permissionRequests.length, permissionsBefore + 4);
  console.log("PASS UI clears access recovery on navigation and ignores a late grant or stale click");
  mainPermissionDenied = false;
  await completePanelAction("#prepare");
  changesBusy = true;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { onChangesBusy = null; reject(new Error("Busy poll was not observed")); }, 15000);
    onChangesBusy = () => { clearTimeout(timeout); resolve(); };
  });
  await panel.waitForFunction(() => !document.getElementById("fill").disabled);
  changesBusy = false; changesFault = true;
  await panel.waitForFunction(() => document.getElementById("message").textContent.includes("BRIDGE_EXCEPTION"));
  assert.match(await panel.locator("#message").textContent(), /字段描述.*TypeError.*非安全页面/);
  assert.equal((await panel.locator("#message").textContent()).includes("private-diagnostic-token"), false);
  assert.equal(await panel.locator("#fill").isDisabled(), true);
  assert.equal(await panel.locator("#allowPageAccess").isVisible(), false);
  assert.equal(await target.locator("#permission-name").inputValue(), "");
  changesFault = false;
  console.log("PASS UI keeps a busy poll retryable and displays sanitized read-only diagnostics when polling fails");
  assert.deepEqual(errors, []);
  console.log("UI integration cases passed: 49 (Chrome API adapter and local AI stub; not live-model validation)");
} finally { await browser.close(); await new Promise((r) => server.close(r)); }

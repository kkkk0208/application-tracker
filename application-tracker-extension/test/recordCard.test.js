import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createRecordCard } from "../src/sidepanel/recordCard.js";
import { buildRecordDraft } from "../src/assistant/recordDraft.js";
import { createMutationQueue, MUTATION_MESSAGE } from "../src/storageMutations.js";
import { STORAGE_KEY } from "../src/constants.js";

const settings = { enabled: true, apiKey: "fixture-only-key", model: "fixture-model" };
const signals = { jobPostings: [{ company: "示例公司", title: "分析师", base: "香港" }], hostname: "careers.example", pathname: "/jobs/1" };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function eventually(condition) { for (let index = 0; index < 100; index++) { if (condition()) return; await setImmediate(); } assert.ok(condition(), "asynchronous card operation did not finish"); }

function harness(t, { collect = async () => signals, records = [] } = {}) {
  const previous = globalThis.chrome, values = { [STORAGE_KEY]: structuredClone(records) }, temporary = {}, messages = [], notices = [];
  let busy = false, persisted = 0, targetUrl = "https://careers.example/jobs/1?token=temporary", targetDocument = "doc0", persistFailure = false;
  const listeners = new Map();
  const container = {
    hidden: true, innerHTML: "", origin: { textContent: "" },
    addEventListener(name, handler) { listeners.set(name, handler); },
    querySelector(selector) { return selector === "[data-record-origin]" ? this.origin : null; },
    querySelectorAll() { return []; },
    input(id, value) { listeners.get("input")({ target: { id, value } }); },
    change(id, value) { listeners.get("change")({ target: { id, value } }); },
    click(id) { listeners.get("click")({ target: { closest: () => ({ id }) } }); }
  };
  const area = (data) => ({
    async get(keys) { return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]]))); },
    async set(update) { Object.assign(data, structuredClone(update)); }
  });
  const local = area(values), sessionArea = area(temporary);
  const mutate = createMutationQueue(local);
  globalThis.chrome = {
    storage: { local, session: sessionArea },
    tabs: { async get() { return { url: targetUrl }; } },
    scripting: { async executeScript(request) {
      if (request.func.name === "pageBridge") {
        assert.equal(request.args[0].action, "ping");
        if (request.target.documentIds[0] !== targetDocument) throw new Error("Original document missing");
        return [{ documentId: targetDocument, result: { token: "token0", scanId: "scan0" } }];
      }
      assert.deepEqual(request.target.frameIds, [0]); assert.equal(request.func.name, "collectJobSignals");
      const result = await collect();
      return [{ documentId: targetDocument, result }];
    } },
    runtime: { async sendMessage(message) { messages.push(structuredClone(message)); assert.equal(message.type, MUTATION_MESSAGE); return { ok: true, value: await mutate(message.mutation) }; } }
  };
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
  let session = { tabId: 1, snapshot: { tabId: 1, url: targetUrl, title: "申请信息", frames: [{ frameId: 0, documentId: "doc0", token: "token0", scanId: "scan0" }] }, results: [{ status: "verified" }], stale: false };
  const card = createRecordCard({ container, getSession: () => session, persist: async () => { persisted++; if (persistFailure) throw new Error("Synthetic session quota"); }, isBusy: () => busy,
    setBusy: (value) => { busy = value; }, tell: (message) => notices.push(message) });
  return { card, container, values, temporary, messages, notices, get session() { return session; }, set session(value) { session = value; }, get busy() { return busy; }, get persisted() { return persisted; }, set targetUrl(value) { targetUrl = value; }, set targetDocument(value) { targetDocument = value; }, set persistFailure(value) { persistFailure = value; } };
}

test("record card prepares page information in session only and never saves automatically", async (t) => {
  const h = harness(t);
  await h.card.prepare(h.session.snapshot, { enabled: false });
  await h.card.render();
  assert.deepEqual([h.session.recordDraft.company, h.session.recordDraft.role], ["示例公司", "分析师"]);
  assert.equal(h.session.recordDraft.portalLink, h.session.snapshot.url);
  assert.equal(h.session.recentJobs[0].url, "https://careers.example/jobs/1");
  assert.equal(h.container.hidden, false);
  assert.match(h.container.innerHTML, /提交后记一笔|结构化数据|id="saveRecord"/);
  assert.equal(h.messages.length, 0);
  assert.deepEqual(h.values[STORAGE_KEY], []);
  h.session.results = [];
  await h.card.render();
  assert.equal(h.container.hidden, true);
});

test("a stale page or replaced session discards delayed extraction and keeps the current draft", async (t) => {
  const gate = deferred(), h = harness(t, { collect: () => gate.promise });
  const first = h.session, pending = h.card.prepare(first.snapshot, { enabled: false });
  await eventually(() => !!first.recordDraft);
  first.stale = true;
  h.session = { tabId: 2, snapshot: { url: "https://careers.example/jobs/2", title: "新岗位" }, results: [], recordDraft: { company: "保留" } };
  gate.resolve(signals); await pending;
  assert.equal(first.recordDraft.company, "");
  assert.equal(h.session.recordDraft.company, "保留");
  assert.deepEqual(h.temporary, {});
});

test("a different document collected at the same URL is rejected before navigation events arrive", async (t) => {
  const gate = deferred(), h = harness(t, { collect: () => gate.promise });
  const pending = h.card.prepare(h.session.snapshot, { enabled: false });
  await eventually(() => !!h.session.recordDraft);
  await setImmediate();
  h.targetDocument = "doc-after-reload";
  gate.resolve(signals); await pending;
  assert.equal(h.session.stale, false);
  assert.equal(h.session.recordDraft.company, "");
  assert.equal(h.session.recordDraft.role, "");
  assert.deepEqual(h.temporary, {});
});

test("manual edits and deliberate clearing prevent late AI supplementation", async (t) => {
  const gate = deferred(); let requested = false;
  const h = harness(t, { collect: async () => ({ documentTitle: "申请信息", hostname: "careers.example", pathname: "/jobs/1" }) });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requested = true;
    assert.doesNotMatch(init.body, /fixture-only-key|recordDraft|profile/);
    return { ok: true, json: async () => { await gate.promise; return { status: "completed", output_text: JSON.stringify({ company: "AI 公司", role: "AI 岗位", base: "香港", confidence: "medium" }) }; } };
  });
  const pending = h.card.prepare(h.session.snapshot, settings);
  await eventually(() => requested);
  h.container.input("recordCompany", "手动公司");
  h.container.input("recordRole", "");
  gate.resolve(); await pending;
  assert.equal(h.session.recordDraft.company, "手动公司");
  assert.equal(h.session.recordDraft.role, "");
  assert.equal(h.session.recordDraft.base, "香港");
  assert.equal(h.session.recordDraft.origin.company, "手动填写");
  assert.equal(h.messages.length, 0);
});

test("low AI confidence cannot fill draft fields and extraction failure remains manual", async (t) => {
  const h = harness(t, { collect: async () => ({}) });
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ status: "completed", output_text: JSON.stringify({ company: "弱公司", role: "弱岗位", base: "香港", confidence: "low" }) }) }));
  await h.card.prepare(h.session.snapshot, settings);
  assert.equal(h.session.recordDraft.company, "");
  assert.equal(h.session.recordDraft.role, "");
  assert.equal(h.session.recordDraft.base, "");
  globalThis.chrome.scripting.executeScript = async () => { throw new Error("not permitted"); };
  await h.card.prepare(h.session.snapshot, settings);
  h.container.input("recordCompany", "手动公司");
  h.container.input("recordRole", "手动岗位");
  assert.deepEqual([h.session.recordDraft.company, h.session.recordDraft.role], ["手动公司", "手动岗位"]);
});

test("weak page guesses cannot silently populate a record draft", async (t) => {
  const h = harness(t, { collect: async () => ({ classCandidates: { company: ["猜测公司"], role: ["分析师"], base: ["香港"] } }) });
  await h.card.prepare(h.session.snapshot, { enabled: false });
  assert.equal(h.session.recordInfo.confidence.role, "low");
  assert.equal(h.session.recordDraft.company, "");
  assert.equal(h.session.recordDraft.role, "");
  assert.equal(h.session.recordDraft.base, "");
});

test("a late AI reply cannot update a target that navigated before the session became stale", async (t) => {
  const gate = deferred(); let requested = false;
  const h = harness(t, { collect: async () => ({}) });
  t.mock.method(globalThis, "fetch", async () => {
    requested = true;
    return { ok: true, json: async () => { await gate.promise; return { status: "completed", output_text: JSON.stringify({ company: "AI 公司", role: "AI 岗位", base: "香港", confidence: "medium" }) }; } };
  });
  const pending = h.card.prepare(h.session.snapshot, settings);
  await eventually(() => requested);
  h.targetUrl = "https://careers.example/jobs/2";
  gate.resolve(); await pending;
  assert.equal(h.session.stale, false);
  assert.equal(h.session.recordDraft.company, "");
  assert.equal(h.session.recordDraft.role, "");
});

test("cancel aborts metadata requests and a late transport response cannot supplement the draft", async (t) => {
  const gate = deferred(); let requestSignal;
  const h = harness(t, { collect: async () => ({}) });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requestSignal = init.signal;
    return { ok: true, json: async () => { await gate.promise; return { status: "completed", output_text: JSON.stringify({ company: "晚到公司", role: "晚到岗位", base: "香港", confidence: "high" }) }; } };
  });
  const pending = h.card.prepare(h.session.snapshot, settings);
  await eventually(() => !!requestSignal);
  h.card.cancel();
  assert.equal(requestSignal.aborted, true);
  gate.resolve(); await pending;
  assert.equal(h.session.recordDraft.company, "");
  assert.equal(h.session.recordDraft.role, "");
  assert.equal(h.messages.length, 0);
});

test("cancelling metadata never cancels an already authorized durable record save", async (t) => {
  const h = harness(t);
  await h.card.prepare(h.session.snapshot, { enabled: false });
  const original = globalThis.chrome.runtime.sendMessage, gate = deferred();
  globalThis.chrome.runtime.sendMessage = async (message) => { await gate.promise; return original(message); };
  h.container.click("saveRecord");
  await eventually(() => h.busy);
  h.card.cancel();
  gate.resolve();
  await eventually(() => !!h.session.recordSaved && !h.busy);
  assert.equal(h.values[STORAGE_KEY].length, 1);
});

test("recent candidates require explicit selection and never overwrite an existing company", async (t) => {
  const h = harness(t, { collect: async () => ({}) });
  h.temporary["applicationTracker.recentJobs"] = [{ company: "过去公司", role: "过去岗位", base: "香港", url: "https://careers.example/jobs/old", host: "careers.example", capturedAt: 100 }];
  await h.card.prepare(h.session.snapshot, { enabled: false });
  await h.card.render();
  assert.equal(h.session.recordDraft.role, "");
  assert.match(h.container.innerHTML, /id="recordRecent"/);
  h.container.input("recordCompany", "手动公司");
  h.container.change("recordRecent", "0");
  assert.equal(h.session.recordDraft.company, "手动公司");
  assert.equal(h.session.recordDraft.role, "过去岗位");
  assert.equal(h.session.recordDraft.origin.role, "最近岗位");
});

test("record card safely renders hostile page text", async (t) => {
  const h = harness(t, { collect: async () => ({ jobPostings: [{ company: '<img src=x onerror="bad()">公司', title: '<script>bad()</script>分析师' }] }) });
  await h.card.prepare(h.session.snapshot, { enabled: false });
  await h.card.render();
  assert.doesNotMatch(h.container.innerHTML, /<img src=x|<script>bad/);
  assert.match(h.container.innerHTML, /&lt;img|&lt;script/);
});

test("record save validates inline, freezes input and routes one explicit save through the mutation queue", async (t) => {
  const h = harness(t, { collect: async () => ({}) });
  await h.card.prepare(h.session.snapshot, { enabled: false });
  h.container.click("saveRecord");
  await eventually(() => !!h.session.recordError);
  assert.match(h.session.recordError, /请填写公司|请填写岗位/);
  assert.equal(h.messages.length, 0);
  h.container.input("recordCompany", " 手动公司 ");
  h.container.input("recordRole", " 手动岗位 ");
  const original = globalThis.chrome.runtime.sendMessage, gate = deferred();
  globalThis.chrome.runtime.sendMessage = async (message) => { await gate.promise; return original(message); };
  h.container.click("saveRecord");
  h.container.click("saveRecord");
  h.container.input("recordRole", "意外改动");
  assert.equal(h.busy, true);
  gate.resolve();
  await eventually(() => !!h.session.recordSaved && !h.busy);
  await h.card.render();
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].mutation.operation, "record.create");
  assert.equal(h.values[STORAGE_KEY].length, 1);
  assert.deepEqual([h.values[STORAGE_KEY][0].company, h.values[STORAGE_KEY][0].role], ["手动公司", "手动岗位"]);
  assert.equal(h.session.recordSaved.id, h.values[STORAGE_KEY][0].id);
  assert.match(h.container.innerHTML, /已记录 ✓/);
  assert.doesNotMatch(h.container.innerHTML, /id="saveRecord/);
});

test("fresh duplicate detection requires a separate explicit still-record click", async (t) => {
  const h = harness(t);
  await h.card.prepare(h.session.snapshot, { enabled: false });
  const existing = { ...buildRecordDraft({ url: h.session.snapshot.url, jobInfo: { company: "示例公司", role: "分析师" } }), id: "already-saved", status: "offer" };
  h.values[STORAGE_KEY].push(existing);
  h.container.click("saveRecord");
  await eventually(() => !!h.session.recordError && !h.busy);
  assert.equal(h.messages.length, 0);
  await h.card.render();
  assert.match(h.container.innerHTML, /已记录过|id="saveRecordAnyway"/);
  h.container.click("saveRecordAnyway");
  await eventually(() => !!h.session.recordSaved && !h.busy);
  assert.equal(h.values[STORAGE_KEY].length, 2);
  assert.equal(h.messages.length, 1);
});

test("editing the company invalidates a previous still-record confirmation for both name and URL duplicates", async (t) => {
  const h = harness(t);
  await h.card.prepare(h.session.snapshot, { enabled: false });
  const draft = h.session.recordDraft;
  h.values[STORAGE_KEY].push(
    { ...buildRecordDraft({ url: "https://careers.example/jobs/a", jobInfo: { company: "甲公司", role: "分析师" } }), id: "company-a" },
    { ...buildRecordDraft({ url: "https://careers.example/jobs/b", jobInfo: { company: "乙公司", role: "分析师" } }), id: "company-b" }
  );
  draft.company = "甲公司";
  await h.card.render();
  assert.match(h.container.innerHTML, /已记录过：甲公司/);
  h.container.input("recordCompany", "乙公司");
  h.container.click("saveRecordAnyway"); // A queued click from the old notice.
  await eventually(() => !!h.session.recordError && !h.busy);
  assert.equal(h.messages.length, 0);
  await h.card.render();
  assert.match(h.container.innerHTML, /已记录过：乙公司/);
  h.container.click("saveRecordAnyway");
  await eventually(() => !!h.session.recordSaved && !h.busy);
  assert.equal(h.messages.length, 1);
  assert.equal(h.values[STORAGE_KEY].at(-1).company, "乙公司");

  // The duplicate ID may stay the same for a URL match; changed draft text
  // must still require a new confirmation rather than reuse that ID alone.
  delete h.session.recordSaved;
  delete h.session.recordError;
  draft.company = "甲公司";
  await h.card.render();
  h.container.input("recordCompany", "丙公司");
  h.container.click("saveRecordAnyway");
  await eventually(() => !!h.session.recordError && !h.busy);
  assert.equal(h.messages.length, 1);
  await h.card.render();
  h.container.click("saveRecordAnyway");
  await eventually(() => !!h.session.recordSaved && !h.busy);
  assert.equal(h.messages.length, 2);
  assert.equal(h.values[STORAGE_KEY].at(-1).company, "丙公司");
});

test("navigation during duplicate lookup stops saving and reports the stale page", async (t) => {
  const h = harness(t);
  await h.card.prepare(h.session.snapshot, { enabled: false });
  const gate = deferred(), get = globalThis.chrome.storage.local.get;
  globalThis.chrome.storage.local.get = async (keys) => { await gate.promise; return get(keys); };
  h.container.click("saveRecord");
  h.session.stale = true;
  gate.resolve();
  await eventually(() => !h.busy);
  assert.equal(h.messages.length, 0);
  assert.match(h.session.recordError, /页面已变化/);
});

test("saving checks the actual tab URL even if the stale event has not arrived", async (t) => {
  const h = harness(t);
  await h.card.prepare(h.session.snapshot, { enabled: false });
  h.targetUrl = "https://careers.example/jobs/another";
  h.container.click("saveRecord");
  await eventually(() => !!h.session.recordError && !h.busy);
  assert.equal(h.messages.length, 0);
  assert.match(h.session.recordError, /跳转|重新识别/);
});

test("a committed record remains marked saved when the page becomes stale before its response returns", async (t) => {
  const h = harness(t);
  await h.card.prepare(h.session.snapshot, { enabled: false });
  const original = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = async (message) => {
    const response = await original(message);
    h.session.stale = true;
    return response;
  };
  h.container.click("saveRecord");
  await eventually(() => !!h.session.recordSaved && !h.busy);
  await h.card.render();
  assert.equal(h.values[STORAGE_KEY].length, 1);
  assert.equal(h.session.recordSaved.id, h.values[STORAGE_KEY][0].id);
  assert.match(h.session.recordError, /已记录.*页面已变化/);
  assert.ok(h.notices.some((notice) => /投递已记录.*页面已变化/.test(notice)));
  assert.match(h.container.innerHTML, /已记录 ✓/);
  assert.doesNotMatch(h.container.innerHTML, /id="saveRecord/);
  h.container.click("saveRecord");
  await setImmediate();
  assert.equal(h.messages.length, 1);
});

test("successful save survives a failed session write and never invites a second persistent save", async (t) => {
  const h = harness(t);
  await h.card.prepare(h.session.snapshot, { enabled: false });
  h.persistFailure = true;
  h.container.click("saveRecord");
  await eventually(() => !!h.session.recordSaved && !h.busy);
  await h.card.render();
  assert.equal(h.messages.length, 1);
  assert.equal(h.values[STORAGE_KEY].length, 1);
  assert.equal(h.session.recordError, "已记录，恢复状态暂存失败");
  assert.ok(h.notices.includes("已记录，恢复状态暂存失败"));
  assert.match(h.container.innerHTML, /已记录 ✓|恢复状态暂存失败/);
  h.container.click("saveRecord");
  await setImmediate();
  assert.equal(h.messages.length, 1);
});

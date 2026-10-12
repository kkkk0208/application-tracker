import test from "node:test";
import assert from "node:assert/strict";
import { buildJobInfoPayload, requestJobInfo, shouldRequestJobInfo } from "../src/jobInfo/aiJobInfo.js";

const settings = { enabled: true, apiKey: "fixture-only-key", model: "selected-model" };
const answer = { company: "某某集团", role: "财务实习生", base: "深圳", confidence: "medium" };
const response = (value = answer, extra = {}) => async () => ({ ok: true, json: async () => ({ status: "completed", output_text: JSON.stringify(value), ...extra }) });

test("job AI sends only allowed public signals and the complete user JSON stays under 2000 characters", () => {
  const signals = {
    documentTitle: "财务实习生 · 某某集团", meta: { "og:title": "岗位标题", "og:site_name": "某某集团", "twitter:title": "推送标题", "application-name": "招聘", description: "PRIVATE meta" },
    headings: ["财务实习生", { text: "岗位介绍", value: "PRIVATE heading" }], labels: { company: ["某某集团"], role: ["财务实习生"], base: ["深圳"], name: ["PRIVATE applicant"] },
    breadcrumbs: ["首页 / 职位"], hostname: "jobs.example.com", pathname: "/apply/123?token=PRIVATE query#PRIVATE hash",
    jobPostings: [{ description: "PRIVATE posting" }], classCandidates: { role: ["PRIVATE class"] }, siteCandidates: { role: ["PRIVATE site"] }, logoAlts: ["PRIVATE logo"],
    inputs: { name: "PRIVATE input" }, formText: "PRIVATE form", profile: "PRIVATE profile"
  };
  const payload = buildJobInfoPayload(settings.model, signals);
  assert.equal(payload.model, settings.model);
  assert.equal(payload.store, false);
  assert.equal(payload.text.format.type, "json_schema");
  assert.equal(payload.text.format.strict, true);
  assert.equal(payload.text.format.schema.additionalProperties, false);
  assert.deepEqual(payload.text.format.schema.required, ["company", "role", "base", "confidence"]);
  assert.deepEqual(payload.text.format.schema.properties.company.type, ["string", "null"]);
  assert.ok(!JSON.stringify(payload).includes("PRIVATE"));
  assert.ok(!JSON.stringify(payload).includes(settings.apiKey));
  const sent = JSON.parse(payload.input[1].content);
  assert.deepEqual(Object.keys(sent), ["documentTitle", "meta", "headings", "labels", "breadcrumbs", "hostname", "pathname"]);
  assert.equal(sent.pathname, "/apply/123");
  assert.deepEqual(sent.headings, ["财务实习生", "岗位介绍"]);
  const enormous = '"\\招聘'.repeat(3000);
  const large = buildJobInfoPayload("model", {
    documentTitle: enormous, meta: Object.fromEntries(Object.keys(sent.meta).map((key) => [key, enormous])),
    headings: Array(50).fill(enormous), labels: { company: Array(50).fill(enormous), role: Array(50).fill(enormous), base: Array(50).fill(enormous) },
    breadcrumbs: Array(50).fill(enormous), hostname: enormous, pathname: enormous
  });
  assert.ok(large.input[1].content.length <= 2000);
  assert.doesNotThrow(() => JSON.parse(large.input[1].content));
});

test("disabled AI, blank keys and already reliable company and role avoid a request", async () => {
  const noFetch = () => { throw new Error("should not fetch"); };
  for (const change of [{ enabled: false }, { apiKey: "" }, { apiKey: "  " }]) {
    assert.equal(await requestJobInfo({ ...settings, ...change }, {}, undefined, noFetch), null);
  }
  assert.equal(shouldRequestJobInfo(settings, { company: "某某集团", role: "财务实习生", confidence: { company: "medium", role: "high" } }), false);
  assert.equal(shouldRequestJobInfo(settings, { company: "某某集团", role: "财务实习生", confidence: { company: "low", role: "high" } }), true);
  assert.equal(shouldRequestJobInfo(settings, { company: "某某集团", role: "", confidence: { company: "high", role: "high" } }), true);
  assert.equal(await requestJobInfo(settings, { labels: { company: ["某某集团"], role: ["财务实习生"], base: [] } }, undefined, noFetch), null);
});

test("job AI uses Responses API, the configured model, a 20 second timeout and accepts nullable output", async (t) => {
  const timeoutController = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds) => { assert.equal(milliseconds, 20000); return timeoutController.signal; });
  let request;
  const result = await requestJobInfo(settings, {}, undefined, async (url, init) => {
    request = { url, init };
    return response()();
  });
  assert.deepEqual(result, answer);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.Authorization, `Bearer ${settings.apiKey}`);
  assert.equal(request.init.signal, timeoutController.signal);
  assert.equal(JSON.parse(request.init.body).model, settings.model);
  const empty = { company: null, role: null, base: null, confidence: "low" };
  assert.deepEqual(await requestJobInfo(settings, {}, undefined, response(empty)), empty);
  assert.deepEqual(await requestJobInfo(settings, {}, undefined, response(null, { output_text: undefined, output: [{ content: [{ type: "output_text", text: JSON.stringify(answer) }] }] })), answer);
});

test("job AI rejects invalid schemas and does not coerce missing or non-string fields", async () => {
  for (const invalid of [null, [], {}, { ...answer, confidence: "certain" }, { ...answer, role: 12 }, { ...answer, company: {} }, { ...answer, selector: "input" }, { ...answer, base: undefined }, { ...answer, role: "长".repeat(161) }]) {
    await assert.rejects(requestJobInfo(settings, {}, undefined, response(invalid)), /格式无效/);
  }
});

test("platform names and application page names cannot become AI companies or roles", async () => {
  for (const fake of ["填写简历", "简历填写", "个人中心", "职位详情", "申请职位", "招聘官网", "校园招聘", "JobsDB", "LinkedIn", "Careers", "Application form", "填写简历 - 某某集团"]) {
    const actual = await requestJobInfo(settings, {}, undefined, response({ ...answer, company: fake, role: fake }));
    assert.equal(actual.company, null, fake);
    assert.equal(actual.role, null, fake);
  }
});

test("incomplete, refused, malformed and HTTP error responses leave local results untouched", async () => {
  for (const extra of [{ status: "incomplete" }, { status: "queued" }, { output_text: "not JSON" }, { output: [{ content: [{ type: "refusal" }] }] }]) {
    await assert.rejects(requestJobInfo(settings, {}, undefined, response(answer, extra)), /AI/);
  }
  await assert.rejects(requestJobInfo(settings, {}, undefined, async () => ({ ok: false, status: 429 })), /受限/);
  await assert.rejects(requestJobInfo(settings, {}, undefined, async () => ({ ok: false, status: 401 })), /401/);
  await assert.rejects(requestJobInfo(settings, {}, undefined, async () => ({ ok: true, json: async () => { throw new Error("invalid response"); } })), /格式无效/);
});

test("user cancellation and timeout discard responses even when the transport completes late", async (t) => {
  const already = new AbortController();
  already.abort();
  await assert.rejects(requestJobInfo(settings, {}, already.signal, () => { throw new Error("should not fetch"); }), { name: "AbortError" });
  const user = new AbortController();
  await assert.rejects(requestJobInfo(settings, {}, user.signal, async (_url, init) => {
    user.abort();
    assert.equal(init.signal.aborted, true);
    return response()();
  }), { name: "AbortError" });
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => timeout.signal);
  await assert.rejects(requestJobInfo(settings, {}, undefined, async () => {
    timeout.abort(new DOMException("Timed out", "TimeoutError"));
    return response()();
  }), { name: "TimeoutError" });
});

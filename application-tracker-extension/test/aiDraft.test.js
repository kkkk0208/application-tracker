import test from "node:test";
import assert from "node:assert/strict";
import { buildDraftBatch, requestDraft } from "../src/assistant/ai.js";
import { factsFromProfile, preparePlan } from "../src/assistant/planner.js";
import { acceptPairs } from "../src/assistant/aiPairing.js";

const profile = { fullNameZh: "SENTINEL_NAME", email: "SENTINEL_EMAIL", masterUniversityZh: "示例大学", commonAnswers: { selfIntroduction: { zh: "已确认介绍资料" }, expectedSalary: { zh: "SENTINEL_SALARY" } }, internships: [{ companyZh: "示例实习公司", roleZh: "分析实习生", descriptionZh: "分析虚构项目数据" }, { companyZh: "SENTINEL_OTHER_COMPANY", descriptionZh: "SENTINEL_OTHER_DESCRIPTION" }] };
const facts = factsFromProfile(profile, "zh");
const snapshot = { title: "示例岗位", url: "https://example.com/apply?token=SENTINEL_URL", jobText: "公开岗位说明", fields: [] };
const field = (label, extra = {}) => ({ fieldId: label, groupId: "group", label, labelSource: "label", kind: "textarea", type: "textarea", supported: true, value: "", options: [], constraints: {}, section: "基本信息", group: "", ...extra });
const planFor = (sourceField) => preparePlan({ ...snapshot, fields: [sourceField] }, facts, [], "zh")[0];
const settings = { enabled: true, apiKey: "fixture", model: "configured-model" };
const proposal = (item, extra = {}) => ({ fieldId: item.fieldId, entityId: item.entityId, kind: "draft", factIds: ["common_answer.selfIntroduction.zh"], text: "本轮示例草稿", optionId: null, ...extra });
const response = (items, data = {}) => ({ ok: true, json: async () => ({ status: "completed", output_text: JSON.stringify({ items }), ...data }) });
const draftFor = (item) => buildDraftBatch(item, facts, snapshot, "zh");

test("draft builder is pure and produces one question with only related facts and public job context", () => {
  const item = planFor(field("工作内容", { section: "实习经历" }));
  Object.assign(item, { entityId: "experience.internship.0", intent: "experience.internship.0.description", narrative: true, needsSemanticReview: false, answer: "SENTINEL_PREVIEW_ANSWER" });
  const before = JSON.stringify({ item, facts, profile, snapshot });
  const batch = draftFor(item);
  assert.equal(batch.fields.length, 1); assert.equal(batch.fields[0].fieldId, item.fieldId);
  assert.deepEqual(batch.facts.map((fact) => fact.id), ["experience.internship.0.company.zh", "experience.internship.0.role.zh", "experience.internship.0.description.zh"]);
  assert.equal(batch.facts.find((fact) => fact.id.endsWith("description.zh")).value, "分析虚构项目数据"); assert.equal(batch.jobContext, "公开岗位说明");
  const sent = JSON.stringify(batch);
  for (const excluded of ["SENTINEL_NAME", "SENTINEL_EMAIL", "SENTINEL_SALARY", "SENTINEL_URL", "SENTINEL_OTHER_COMPANY", "SENTINEL_OTHER_DESCRIPTION", "SENTINEL_PREVIEW_ANSWER"]) assert.ok(!sent.includes(excluded), excluded);
  assert.equal(JSON.stringify({ item, facts, profile, snapshot }), before);
});

test("local, confirmed-memory and edited preview answers allow an explicit draft but are not sent", () => {
  for (const change of [{ answer: "SENTINEL_LOCAL" }, { answer: "SENTINEL_MEMORY", memoryId: "m1", source: "已确认问答记忆" }, { answer: "SENTINEL_EDITED", edited: true }]) {
    const item = { ...planFor(field("自我介绍")), ...change };
    const batch = draftFor(item);
    assert.equal(batch.fields.length, 1);
    assert.ok(!JSON.stringify(batch).includes(change.answer));
  }
});

test("unsupported, filled, non-prose and incompatible subject fields have no draft batch", () => {
  const intro = planFor(field("自我介绍"));
  for (const change of [{ supported: false }, { value: "SENTINEL_WEB_VALUE" }, { kind: "text", narrative: false }, { entityId: "family.father" }]) assert.equal(draftFor({ ...intro, ...change }), null);
  assert.equal(buildDraftBatch(intro, [], snapshot, "zh"), null);
});

test("draft metadata excludes filled-value properties from options, evidence and constraints", () => {
  const item = planFor(field("自我介绍", { constraints: { maxLength: 400, value: "SENTINEL_CONSTRAINT_VALUE" }, contextEvidence: [{ source: "label", text: "自我介绍", value: "SENTINEL_EVIDENCE_VALUE" }], options: [{ id: "a", text: "普通选项", value: "SENTINEL_OPTION_VALUE" }] }));
  const encoded = JSON.stringify(draftFor(item));
  for (const excluded of ["SENTINEL_CONSTRAINT_VALUE", "SENTINEL_EVIDENCE_VALUE", "SENTINEL_OPTION_VALUE"]) assert.ok(!encoded.includes(excluded));
});

test("draft builder performs no network call; only requestDraft sends the confirmed single batch", async () => {
  const item = planFor(field("自我介绍"));
  const before = JSON.stringify({ item, profile });
  let calls = 0;
  const batch = draftFor(item);
  assert.equal(calls, 0);
  const result = await requestDraft(settings, batch, item, facts, undefined, async (endpoint, options) => {
    calls++;
    assert.equal(endpoint, "https://api.openai.com/v1/responses");
    const sent = JSON.parse(options.body);
    assert.equal(sent.store, false); assert.equal(sent.model, settings.model); assert.equal(sent.text.format.strict, true);
    assert.deepEqual(sent.text.format.schema.properties.items.items.properties.kind.enum, ["draft"]);
    const user = JSON.parse(sent.input[1].content);
    assert.equal(user.fields.length, 1); assert.equal(user.fields[0].fieldId, item.fieldId);
    assert.deepEqual(user.facts, batch.facts);
    return response([proposal(item)]);
  });
  assert.equal(calls, 1); assert.equal(result.errors.length, 0); assert.equal(result.accepted[0].answer, "本轮示例草稿");
  assert.equal(result.accepted[0].status, "review"); assert.equal(result.accepted[0].selected, false);
  assert.equal(JSON.stringify({ item, profile }), before);
});

test("an explicitly requested draft can replace an edited preview through a returned update", async () => {
  const item = { ...planFor(field("自我介绍")), answer: "人工旧答案", edited: true, memoryId: "m1" };
  const result = await requestDraft(settings, draftFor(item), item, facts, undefined, async () => response([proposal(item)]));
  assert.equal(result.errors.length, 0); assert.equal(result.accepted[0].answer, "本轮示例草稿");
  assert.equal(item.answer, "人工旧答案"); assert.equal(item.edited, true);
});

test("responses cannot return facts, options, different fields or a different subject", async () => {
  const item = planFor(field("自我介绍"));
  for (const change of [{ kind: "fact" }, { kind: "option", optionId: "a" }, { fieldId: "other" }, { entityId: "education.master" }, { selector: "#submit" }, { optionId: "a" }, { text: null }]) {
    const result = await requestDraft(settings, draftFor(item), item, facts, undefined, async () => response([proposal(item, change)]));
    assert.equal(result.accepted.length, 0); assert.equal(result.errors.length, 1);
  }
});

test("duplicate responses and citations outside the sent fact subset are rejected", async () => {
  const item = planFor(field("自我介绍"));
  for (const items of [[proposal(item), proposal(item)], [proposal(item, { factIds: ["contact.email"] })], [proposal(item, { factIds: [] })], [proposal(item, { factIds: ["unknown"] })]]) {
    const result = await requestDraft(settings, draftFor(item), item, facts, undefined, async () => response(items));
    assert.equal(result.accepted.length, 0); assert.ok(result.errors.length);
  }
});

test("caller-supplied batches cannot expand fields or facts beyond the confirmation", async () => {
  const item = planFor(field("自我介绍"));
  const batch = draftFor(item);
  for (const modified of [{ ...batch, fields: [...batch.fields, { ...batch.fields[0], fieldId: "extra" }] }, { ...batch, facts: [...batch.facts, facts.find((fact) => fact.id === "contact.email")] }, { ...batch, facts: batch.facts.map((fact) => ({ ...fact, value: "different" })) }]) {
    await assert.rejects(requestDraft(settings, modified, item, facts, undefined, () => assert.fail("must not request")), /仅能使用已确认/);
  }
});

test("late results preserve edits and newly filled webpage content", async () => {
  for (const change of [{ answer: "新的人工答案", edited: true }, { value: "网站新答案" }, { supported: false }, { entityId: "family.father" }]) {
    const item = planFor(field("自我介绍"));
    const batch = draftFor(item);
    const result = await requestDraft(settings, batch, item, facts, undefined, async () => {
      const reply = response([proposal(item)]);
      Object.assign(item, change);
      return reply;
    });
    assert.equal(result.accepted.length, 0); assert.match(result.errors[0].reason, /已保留当前内容/);
    for (const [key, value] of Object.entries(change)) assert.equal(item[key], value);
  }
});

test("draft results are rejected if the question or cited facts change while awaiting the response", async () => {
  for (const modify of [(item) => { item.label = "不同的问题"; }, (item) => { item.constraints.maxLength = 3; }, (item, source) => { source.find((fact) => fact.id === "common_answer.selfIntroduction.zh").value = "更新后的资料"; }]) {
    const item = planFor(field("自我介绍"));
    const source = structuredClone(facts);
    const batch = buildDraftBatch(item, source, snapshot, "zh");
    const result = await requestDraft(settings, batch, item, source, undefined, async () => {
      const reply = response([proposal(item)]);
      modify(item, source);
      return reply;
    });
    assert.equal(result.accepted.length, 0); assert.match(result.errors[0].reason, /已保留当前内容/);
  }
});

test("draft failures preserve the preview and profile, with completed status required", async () => {
  const item = { ...planFor(field("自我介绍")), answer: "现有预览", edited: true };
  const before = JSON.stringify({ item, profile, facts });
  const failures = [
    { ok: false, status: 429, json: async () => ({}) },
    response([], { status: "incomplete" }), response([], { status: undefined }),
    { ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "refusal" }] }] }) },
    { ok: true, json: async () => ({ status: "completed", output_text: "not json" }) },
    { ok: true, json: async () => ({ status: "completed", output_text: '{}' }) }
  ];
  for (const failure of failures) {
    await assert.rejects(requestDraft(settings, draftFor(item), item, facts, undefined, async () => failure), /AI/);
    assert.equal(JSON.stringify({ item, profile, facts }), before);
  }
});

test("empty related facts and disabled settings stop before sending", async () => {
  const item = planFor(field("自我介绍"));
  await assert.rejects(requestDraft(settings, null, item, [], undefined, () => assert.fail("must not request")), /仅能使用已确认/);
  await assert.rejects(requestDraft({ enabled: false, apiKey: "fixture" }, draftFor(item), item, facts, undefined, () => assert.fail("must not request")), /请先/);
  await assert.rejects(requestDraft({ enabled: true, apiKey: "" }, draftFor(item), item, facts, undefined, () => assert.fail("must not request")), /请先/);
});

test("a high-confidence narrative without a stored answer can draft from related education and experience facts", () => {
  const source = factsFromProfile({ masterUniversityZh: "示例大学", internships: [{ companyZh: "示例公司" }], fullNameZh: "SENTINEL_NAME", email: "SENTINEL_EMAIL" }, "zh");
  const item = preparePlan({ ...snapshot, fields: [field("自我介绍")] }, source, [], "zh")[0];
  assert.equal(item.answer, ""); assert.equal(item.ruleConfidence, "high");
  const batch = buildDraftBatch(item, source, snapshot, "zh");
  assert.deepEqual(batch.facts.map((fact) => fact.id), ["education.master.university.zh", "experience.internship.0.company.zh"]);
  assert.ok(!JSON.stringify(batch).includes("SENTINEL_NAME")); assert.ok(!JSON.stringify(batch).includes("SENTINEL_EMAIL"));
});

test("none pairing leaves high-confidence narrative drafting available without restoring the plan's intent", async () => {
  const source = factsFromProfile({ masterUniversityZh: "示例大学", internships: [{ companyZh: "示例公司" }] }, "zh");
  const item = preparePlan({ ...snapshot, fields: [field("自我介绍")] }, source, [], "zh")[0];
  const result = acceptPairs({ pairs: [{ fieldId: item.fieldId, source: "none", factId: null, memoryId: null, transform: "none" }] }, [item], source, [], { url: snapshot.url, language: "zh", batchIds: new Set([item.fieldId]) });
  Object.assign(item, result.accepted[0]);
  assert.equal(item.intent, ""); assert.equal(item.answer, "");
  const before = JSON.stringify(item);
  const batch = buildDraftBatch(item, source, snapshot, "zh");
  assert.equal(batch.fields[0].intent, "common_answer.selfIntroduction");
  const drafted = await requestDraft(settings, batch, item, source, undefined, async () => response([proposal(item, { factIds: ["education.master.university.zh"] })]));
  assert.equal(drafted.accepted[0].answer, "本轮示例草稿");
  assert.equal(JSON.stringify(item), before);
});

test("draft intent recovery still rejects unknown subjects and non-prose inputs", () => {
  const cleared = { ...planFor(field("自我介绍")), answer: "", intent: "", ruleConfidence: "none", needsSemanticReview: false };
  for (const change of [{ entityId: "education.unknown" }, { entityId: "family.father" }, { label: "邮箱", kind: "text", narrative: false }, { label: "自我介绍", kind: "text", narrative: false }]) assert.equal(draftFor({ ...cleared, ...change }), null);
});

test("an explicitly requested factual textarea uses only its canonical fact and cannot borrow missing facts", () => {
  for (const [label, id] of [["期望薪资", "common_answer.expectedSalary.zh"], ["邮箱", "contact.email"], ["姓名", "identity.full_name.zh"]]) {
    const item = planFor(field(label));
    assert.deepEqual(draftFor(item).facts.map((fact) => fact.id), [id]);
  }
  assert.equal(draftFor(planFor(field("学历"))), null, "Missing degree data cannot borrow unrelated education or experience facts");
});

test("an arbitrary long-text question can draft from education, experience and common answers after explicit sending", async () => {
  const item = planFor(field("请分享一个你克服困难的事例"));
  assert.equal(item.intent, "");
  const batch = draftFor(item);
  assert.ok(batch.facts.some((fact) => fact.id.startsWith("education.")));
  assert.ok(batch.facts.some((fact) => fact.id.startsWith("experience.")));
  assert.ok(batch.facts.some((fact) => fact.id.startsWith("common_answer.")));
  for (const secret of ["SENTINEL_NAME", "SENTINEL_EMAIL", "SENTINEL_SALARY", "SENTINEL_URL"]) assert.ok(!JSON.stringify(batch).includes(secret), secret);
  let calls = 0;
  const result = await requestDraft(settings, batch, item, facts, undefined, async (_url, options) => {
    calls++; assert.deepEqual(JSON.parse(JSON.parse(options.body).input[1].content).facts, batch.facts);
    return response([proposal(item)]);
  });
  assert.equal(calls, 1); assert.equal(result.accepted[0].status, "review");
});

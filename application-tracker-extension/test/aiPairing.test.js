import test from "node:test";
import assert from "node:assert/strict";
import { acceptPairs, BLOCKED_LABEL, buildCatalog, buildPairingPayload, PAIRING_FORMAT, pairingCandidates, requestPairing, splitName } from "../src/assistant/aiPairing.js";
import { factsFromProfile, MEMORY_SCOPE_VERSION, preparePlan, scopeFor } from "../src/assistant/planner.js";

// The eight former recognition tests from assistant.test.js are migrated here:
// labels/canonical names and no values -> metadata privacy test;
// options/context without answers -> low-confidence payload test;
// tentative vs exact facts -> candidate exclusion test;
// explicitly clearing an uncertain rule -> none clearing test;
// fact answer still needs review -> local-content/review test;
// school-location and subject -> mismatch and subject tests;
// late edits/filled fields -> late pairing test;
// confirmed memories not erased -> reliable-fact/memory none test.

const profile = { fullNameZh: "林示例", fullName: "Shili Lin", email: "sentinel@example.com", phone: "13900007731", masterUniversityZh: "SENTINEL_UNIVERSITY_7731", masterDegreeZh: "硕士", masterStartDate: "2020-09", bachelorUniversityZh: "SENTINEL_BACHELOR_7731", commonAnswers: { selfIntroduction: { zh: "SENTINEL_INTRODUCTION_7731" } } };
const facts = factsFromProfile(profile, "zh");
const url = "https://example.com/apply?job=one&token=SENTINEL_URL_TOKEN";
const field = (label, extra = {}) => ({ fieldId: label, groupId: "group", label, labelSource: "label", kind: "text", type: "text", supported: true, value: "", options: [], constraints: {}, section: "基本信息", group: "", ...extra });
const planFor = (fields, source = facts, memories = [], language = "zh") => preparePlan({ fields, url, title: "示例申请页", jobText: "SENTINEL_JOB_DESCRIPTION" }, source, memories, language);
const pair = (item, factId, extra = {}) => ({ fieldId: item.fieldId, source: "fact", factId, memoryId: null, transform: "none", ...extra });
const none = (item) => pair(item, null, { source: "none" });
const accept = (pairs, plan, source = facts, memories = [], options = {}) => acceptPairs({ pairs }, plan, source, memories, { url, language: "zh", batchIds: new Set(plan.map((item) => item.fieldId)), ...options });
const memory = (extra = {}) => ({ id: "m1", question: "其他技能", answer: "SENTINEL_MEMORY_ANSWER", confirmed: true, language: "zh", entityId: "self", scope: "global", updatedAt: "2026-10-13T00:00:00Z", ...extra });

test("pairing requests contain only questions and catalog metadata, never local facts or memory answers", () => {
  const privateFacts = factsFromProfile({ ...profile, fullNameZh: "SENTINEL_NAME_7731" }, "zh");
  const [item] = planFor([field("请填写您的学校名称", { help: "官方名称", nearbyText: "已显示的提示", contextEvidence: [{ source: "section", text: "教育经历", value: "SENTINEL_CONTEXT_VALUE" }], options: [{ text: "甲", value: "SENTINEL_OPTION_VALUE" }], constraints: { required: true, maxLength: 100, value: "SENTINEL_CONSTRAINT_VALUE" } })], privateFacts);
  item.answer = "SENTINEL_LOCAL_DRAFT";
  item.url = url; item.jobText = "SENTINEL_JOB_DESCRIPTION";
  const catalog = buildCatalog(privateFacts, [memory()], url, "zh");
  catalog.facts[0].value = "SENTINEL_UNSAFE_CATALOG_VALUE";
  catalog.memories[0].answer = "SENTINEL_UNSAFE_CATALOG_ANSWER";
  const payload = buildPairingPayload("configured-model", [item, field("已填", { value: "SENTINEL_WEB_VALUE" })], catalog, "zh");
  const encoded = JSON.stringify(payload);
  for (const sentinel of ["SENTINEL_NAME_7731", profile.email, profile.phone, profile.masterUniversityZh, profile.bachelorUniversityZh, profile.commonAnswers.selfIntroduction.zh, "SENTINEL_MEMORY_ANSWER", "SENTINEL_LOCAL_DRAFT", "SENTINEL_WEB_VALUE", "SENTINEL_JOB_DESCRIPTION", "SENTINEL_URL_TOKEN", "SENTINEL_OPTION_VALUE", "SENTINEL_CONTEXT_VALUE", "SENTINEL_CONSTRAINT_VALUE", "SENTINEL_UNSAFE_CATALOG_VALUE", "SENTINEL_UNSAFE_CATALOG_ANSWER"]) assert.ok(!encoded.includes(sentinel), sentinel);
  const sent = JSON.parse(payload.input[1].content);
  assert.equal(payload.model, "configured-model");
  assert.equal(sent.fields.length, 1);
  assert.deepEqual(sent.fields[0].options, ["甲"]);
  assert.deepEqual(sent.fields[0].contextEvidence, [{ source: "section", text: "教育经历" }]);
  assert.deepEqual(sent.fields[0].constraints, { required: true, maxLength: 100 });
  assert.equal(sent.fields[0].help, "官方名称");
  assert.equal("nearbyText" in sent.fields[0], false);
});

test("catalog kind and names use metadata without even reading value or answer getters", () => {
  const ids = ["contact.email", "contact.phone", "contact.linkedin", "contact.github", "contact.website", "education.master.start_date", "education.master.graduation_date", "experience.internship.0.period", "experience.internship.0.description.zh", "common_answer.selfIntroduction.zh", "identity.full_name.zh"];
  const source = ids.map((id) => ({ id, label: `目录 ${id}`, entityId: "self", get value() { throw new Error("must not read facts"); } }));
  const remembered = { ...memory(), get answer() { throw new Error("must not read answers"); } };
  const catalog = buildCatalog(source, [remembered], url, "zh");
  assert.deepEqual(catalog.facts.map((entry) => entry.kind), ["email", "phone", "url", "url", "url", "date", "date", "period", "long_text", "long_text", "text"]);
  assert.deepEqual(catalog.facts.map((entry) => entry.label), source.map((entry) => entry.label));
  assert.equal(catalog.memories[0].question, remembered.question);
});

test("catalog includes only confirmed memories in the current language and versioned page scope", () => {
  const good = memory({ scope: scopeFor(url), scopeVersion: MEMORY_SCOPE_VERSION });
  const catalog = buildCatalog(facts, [good, memory({ id: "unconfirmed", confirmed: false }), memory({ id: "english", language: "en" }), memory({ id: "other-page", scope: "https://example.com/other", scopeVersion: MEMORY_SCOPE_VERSION }), memory({ id: "legacy-scope", scope: scopeFor(url) })], url, "zh");
  assert.deepEqual(catalog.memories, [{ id: "m1", question: "其他技能", entityId: "self" }]);
});

test("pairing excludes high-confidence local answers, filled and edited fields, and existing memories", () => {
  const plan = planFor([field("姓名"), field("邮箱"), field("请填写您的学校名称"), field("已填", { value: "网页值" }), field("已编辑", { edited: true }), field("其他技能")], facts, [memory()]);
  assert.deepEqual(pairingCandidates(plan).map((item) => item.fieldId), ["请填写您的学校名称"]);
  assert.equal(plan[0].selected, true); assert.equal(plan[1].selected, true); assert.equal(plan.at(-1).memoryId, "m1");
});

test("low-confidence candidates include full options and context but never an existing answer", () => {
  const [item] = planFor([field("请填写您的学校名称", { labelSource: "placeholder", nearbyText: "n".repeat(200), section: "硕士教育", group: "学校资料", help: "官方名称", options: [{ text: "大学甲", value: "secret" }], constraints: { required: true }, visualEvidence: "截图V1：学校名称 / 硕士教育" })]);
  item.answer = "LOCAL DRAFT VALUE";
  const payload = buildPairingPayload("fixture", [item], buildCatalog(facts, [], url, "zh"), "zh");
  const [sent] = JSON.parse(payload.input[1].content).fields;
  assert.equal(sent.nearbyText.length, 160);
  assert.equal(sent.section, item.section); assert.equal(sent.group, item.group); assert.equal(sent.visualEvidence, item.visualEvidence);
  assert.ok(!JSON.stringify(payload).includes("LOCAL DRAFT VALUE"));
});

test("pairing payload is capped at thirty fields", () => {
  const fields = Array.from({ length: 65 }, (_, index) => field("未知", { fieldId: String(index) }));
  assert.equal(JSON.parse(buildPairingPayload("fixture", fields, { facts: [], memories: [] }, "zh").input[1].content).fields.length, 30);
});

test("none explicitly clears a tentative rule answer and selection", () => {
  const [item] = planFor([field("请填写您的学校名称")]);
  Object.assign(item, { answer: "旧猜测", selected: true, factIds: ["education.master.university.zh"], source: "旧规则" });
  const result = accept([none(item)], [item]);
  assert.equal(result.errors.length, 0);
  Object.assign(item, result.accepted[0]);
  assert.equal(item.answer, ""); assert.equal(item.intent, ""); assert.equal(item.selected, false); assert.equal(item.status, "missing");
  assert.equal(item.reason, "资料里没有对应内容"); assert.equal(item.semanticReviewed, true); assert.deepEqual(item.factIds, []);
});

test("none cannot clear reliable facts or an already used confirmed memory", () => {
  const plan = planFor([field("姓名"), field("其他技能")], facts, [memory()]);
  const result = accept(plan.map(none), plan, facts, [memory()]);
  assert.equal(result.accepted.length, 0); assert.equal(result.errors.length, 2);
  assert.equal(plan[0].answer, profile.fullNameZh); assert.equal(plan[1].answer, "SENTINEL_MEMORY_ANSWER");
});

test("none clears unresolved visual guesses while retaining the partial-group safety explanation", () => {
  const source = factsFromProfile({ bachelorUniversityZh: "本科大学", masterMajorZh: "硕士专业" }, "zh");
  const fields = [field("学校名称", { section: "本科教育", visualEvidence: "截图V1：学校名称 / 本科教育" }), field("专业", { section: "教育经历" })];
  const item = planFor(fields, source)[1];
  assert.equal(item.visualGroupUnresolved, true); assert.equal(item.entityId, "education.unknown");
  const reason = item.reason;
  Object.assign(item, { answer: "旧的专业猜测", selected: true, factIds: ["education.master.major.zh"], source: "旧规则", ruleConfidence: "low" });
  const result = accept([none(item)], [item], source);
  assert.equal(result.errors.length, 0);
  assert.equal(result.accepted[0].reason, reason); assert.match(result.accepted[0].reason, /截图仅确认/);
  assert.equal(result.accepted[0].answer, ""); assert.equal(result.accepted[0].selected, false);
  assert.equal(result.accepted[0].intent, ""); assert.deepEqual(result.accepted[0].factIds, []);
  assert.equal(item.entityId, "education.unknown");
});

test("fact pairing resolves local content and requires review without selecting itself", () => {
  const [item] = planFor([field("请填写您的学校名称")]);
  const result = accept([pair(item, "education.master.university.zh")], [item]);
  assert.equal(result.errors.length, 0); assert.equal(result.accepted[0].answer, profile.masterUniversityZh);
  assert.equal(result.accepted[0].status, "review"); assert.equal(result.accepted[0].selected, false);
  assert.equal(result.accepted[0].needsSemanticReview, false); assert.equal(result.accepted[0].semanticReviewed, true);
  assert.equal(result.accepted[0].ruleConfidence, "none");
});

test("unknown, duplicated and out-of-batch fields or facts are rejected", () => {
  const [item] = planFor([field("请填写您的学校名称")]);
  const good = pair(item, "education.master.university.zh");
  for (const pairs of [[{ ...good, fieldId: "unknown" }], [{ ...good, factId: "unknown" }], [good, good]]) assert.equal(accept(pairs, [item]).accepted.length, 0);
  assert.equal(accept([good], [item], facts, [], { batchIds: new Set() }).accepted.length, 0);
  assert.equal(accept([good], [item], [...facts, facts.find((fact) => fact.id === good.factId)]).accepted.length, 0);
});

test("fact subject and language cannot be changed by AI", () => {
  const [item] = planFor([field("请填写您的学校名称", { section: "本科教育" })]);
  assert.equal(accept([pair(item, "education.master.university.zh")], [item]).accepted.length, 0);
  const englishFacts = factsFromProfile({ masterUniversity: "English University" }, "en");
  const [master] = planFor([field("请填写您的学校名称", { section: "硕士教育" })]);
  assert.equal(accept([pair(master, "education.master.university.en")], [master], englishFacts).accepted.length, 0);
  const [family] = planFor([field("父亲在哪家公司任职")]);
  const company = { id: "experience.internship.0.company.zh", entityId: "experience.internship.0", value: "公司甲", label: "实习1公司" };
  assert.equal(accept([pair(family, company.id)], [family], [company]).accepted.length, 0);
});

test("school-location, ranking and grade mismatches cannot become profile facts", () => {
  const source = factsFromProfile({ masterUniversityZh: "大学甲", masterMajorZh: "专业甲", masterDegreeZh: "硕士" }, "zh");
  for (const [label, factId] of [["学校所在地", "education.master.university.zh"], ["专业排名", "education.master.major.zh"], ["学位成绩", "education.master.degree.zh"]]) {
    const [item] = planFor([field(label, { section: "硕士教育" })], source);
    assert.equal(accept([pair(item, factId)], [item], source).accepted.length, 0);
  }
});

test("blocked questions stay manual even if AI chooses an existing fact", () => {
  for (const label of ["奖惩情况", "证件号码", "民族", "研究论文", "出生日期", "certificate number", "first name"]) {
    assert.equal(BLOCKED_LABEL.test(label), true);
    const [item] = planFor([field(label)]);
    assert.equal(accept([pair(item, "identity.full_name.zh")], [item]).accepted.length, 0);
  }
});

test("late pairing cannot overwrite a user's edit, filled field or changed candidate status", async () => {
  for (const change of [{ edited: true, answer: "人工答案" }, { value: "网页答案" }, { answer: "可靠本地答案", ruleConfidence: "high" }]) {
    const [item] = planFor([field("请填写您的学校名称")]);
    const raw = await requestPairing({ enabled: true, apiKey: "fixture", model: "fixture" }, [item], buildCatalog(facts, [], url, "zh"), "zh", undefined, async () => {
      Object.assign(item, change);
      return { ok: true, json: async () => ({ status: "completed", output_text: JSON.stringify({ pairs: [pair(item, "education.master.university.zh")] }) }) };
    });
    assert.equal(acceptPairs(raw, [item], facts, [], { url, language: "zh", batchIds: new Set([item.fieldId]) }).accepted.length, 0);
  }
});

test("fact option pairing maps degree synonyms locally", () => {
  const [item] = planFor([field("请填写您的学历", { section: "硕士教育", kind: "select", type: "select-one", options: [{ id: "master", text: "Master's degree", disabled: false }] })]);
  const result = accept([pair(item, "education.master.degree.zh")], [item]);
  assert.equal(result.errors.length, 0); assert.equal(result.accepted[0].answer, "Master's degree");
});

test("unmatched, duplicate, disabled and unread options yield explicit missing without a guess", () => {
  for (const options of [[], [{ text: "本科" }], [{ text: "硕士", disabled: true }], [{ text: "硕士" }, { text: "硕士" }]]) {
    const [item] = planFor([field("请填写您的学历", { section: "硕士教育", kind: "select", type: "select-one", options })]);
    item.answer = "旧答案";
    const result = accept([pair(item, "education.master.degree.zh")], [item]);
    assert.equal(result.errors.length, 1); assert.equal(result.accepted[0].status, "missing");
    assert.equal(result.accepted[0].answer, ""); assert.equal(result.accepted[0].selected, false);
    assert.match(result.accepted[0].reason, /资料里是「硕士」.*没有对应项/);
  }
});

test("a valid option exceeding the length constraint is rejected without claiming a missing option", () => {
  const [item] = planFor([field("请填写您的学历", { section: "硕士教育", kind: "select", options: [{ text: "硕士" }], constraints: { maxLength: 1 } })]);
  const result = accept([pair(item, "education.master.degree.zh")], [item]);
  assert.equal(result.accepted.length, 0); assert.match(result.errors[0].reason, /字数限制/);
});

test("month-only dates preserve precision and use the page's date format", () => {
  const [item] = planFor([field("请填写入学年月", { section: "硕士教育", kind: "date", type: "text", dateFormat: "YYYY.MM" })]);
  const result = accept([pair(item, "education.master.start_date")], [item]);
  assert.equal(result.accepted[0].answer, "2020.09");
  const requiringDay = { ...item, dateFormat: "YYYY-MM-DD" };
  assert.equal(accept([pair(requiringDay, "education.master.start_date")], [requiringDay]).accepted.length, 0);
});

test("splitName handles single and compound Chinese surnames and multi-part English names", () => {
  for (const [name, surname, given] of [["林示例", "林", "示例"], ["欧阳示例", "欧阳", "示例"], ["𠮷示例", "𠮷", "示例"], ["Shili Lin", "Lin", "Shili"], ["Shili Example Lin", "Lin", "Shili Example"]]) {
    assert.equal(splitName(name, "surname"), surname); assert.equal(splitName(name, "given_name"), given);
  }
  for (const name of ["", "林", "Lin"]) { assert.equal(splitName(name, "surname"), ""); assert.equal(splitName(name, "given_name"), ""); }
  assert.equal(splitName("林示例", "unknown"), "");
});

test("name transforms work only on the corresponding name-part questions", () => {
  for (const [label, transform, answer] of [["姓", "surname", "林"], ["名", "given_name", "示例"], ["surname", "surname", "林"], ["first name", "given_name", "示例"]]) {
    const [item] = planFor([field(label)]);
    assert.equal(accept([pair(item, "identity.full_name.zh", { transform })], [item]).accepted[0].answer, answer);
  }
  for (const [label, transform] of [["名", "surname"], ["姓", "given_name"], ["别的题", "surname"], ["last name", "given_name"], ["姓名", "surname"], ["first name (national id)", "given_name"]]) {
    const [item] = planFor([field(label)]);
    assert.equal(accept([pair(item, "identity.full_name.zh", { transform })], [item]).accepted.length, 0);
  }
  const [item] = planFor([field("姓")]);
  assert.equal(accept([pair(item, "contact.email", { transform: "surname" })], [item]).accepted.length, 0);
  for (const label of ["姓氏", "名字", "family name"]) {
    const [part] = planFor([field(label)]);
    assert.equal(accept([pair(part, "identity.full_name.zh")], [part]).accepted.length, 0);
  }
});

test("empty facts and invalid local values are rejected", () => {
  const [item] = planFor([field("请填写您的学校名称")]);
  for (const value of ["", null, "   "]) {
    const source = facts.map((fact) => fact.id === "education.master.university.zh" ? { ...fact, value } : fact);
    assert.equal(accept([pair(item, "education.master.university.zh")], [item], source).accepted.length, 0);
  }
  const [email] = planFor([field("请填邮箱", { type: "email" })]);
  assert.equal(accept([pair(email, "contact.email")], [email], [{ ...facts.find((fact) => fact.id === "contact.email"), value: "invalid" }]).accepted.length, 0);
});

test("memory pairing uses the locally stored answer and stays under review", () => {
  const [item] = planFor([field("其他技能")]);
  const remembered = memory();
  const result = accept([pair(item, null, { source: "memory", memoryId: remembered.id })], [item], facts, [remembered]);
  assert.equal(result.errors.length, 0); assert.equal(result.accepted[0].answer, remembered.answer);
  assert.equal(result.accepted[0].memoryVersion, remembered.updatedAt); assert.equal(result.accepted[0].status, "review"); assert.equal(result.accepted[0].selected, false);
});

test("memory confirmation, language, subject, scope and full question meaning are rechecked locally", () => {
  const [item] = planFor([field("其他技能")]);
  const proposal = pair(item, null, { source: "memory", memoryId: "m1" });
  for (const change of [{ confirmed: false }, { language: "en" }, { entityId: "family.father" }, { scope: "https://example.com/other", scopeVersion: MEMORY_SCOPE_VERSION }, { scope: scopeFor(url) }, { question: "期望薪资" }, { answer: "" }]) {
    assert.equal(accept([proposal], [item], facts, [memory(change)]).accepted.length, 0);
  }
  assert.equal(accept([proposal], [item], facts, []).accepted.length, 0);
});

test("memory pairing can reuse a high-confidence local equivalent but rejects low-confidence and school-location aliases", () => {
  const [item] = planFor([field("学校名称", { section: "硕士教育" })], []);
  const remembered = memory({ question: "University", entityId: "education.master", answer: "大学乙" });
  const proposal = pair(item, null, { source: "memory", memoryId: remembered.id });
  assert.equal(accept([proposal], [item], facts, [remembered]).accepted[0].answer, "大学乙");
  const low = { ...item, label: "请填写您的学校名称", ruleConfidence: "low" };
  assert.equal(accept([proposal], [low], facts, [remembered]).accepted.length, 0);
  const wrong = { ...item, label: "学校所在地" };
  assert.equal(accept([{ ...proposal, fieldId: wrong.fieldId }], [wrong], facts, [remembered]).accepted.length, 0);
});

test("memory option answers map locally and cannot invent a missing selection", () => {
  const [item] = planFor([field("其他技能", { kind: "select", options: [{ text: "Yes" }, { text: "No" }] })]);
  const proposal = pair(item, null, { source: "memory", memoryId: "m1" });
  assert.equal(accept([proposal], [item], facts, [memory({ answer: "是" })]).accepted[0].answer, "Yes");
  const result = accept([proposal], [item], facts, [memory({ answer: "未知" })]);
  assert.equal(result.errors.length, 1); assert.equal(result.accepted[0].status, "missing");
});

test("multiple memory choices require a unique match for every requested option", () => {
  const [item] = planFor([field("其他技能", { kind: "checkboxes", constraints: { multiple: true }, options: [{ text: "Yes" }, { text: "No" }] })]);
  const proposal = pair(item, null, { source: "memory", memoryId: "m1" });
  assert.equal(accept([proposal], [item], facts, [memory({ answer: '["是","否"]' })]).accepted[0].answer, '["Yes","No"]');
  for (const answer of ['["是","Yes"]', '["是","未知"]', "是"]) {
    const result = accept([proposal], [item], facts, [memory({ answer })]);
    assert.equal(result.errors.length, 1); assert.equal(result.accepted[0].status, "missing");
  }
});

test("malformed sources, mixed references and transformations are rejected", () => {
  const [item] = planFor([field("请填写您的学校名称")]);
  const good = pair(item, "education.master.university.zh");
  for (const change of [{ source: "invented" }, { transform: "invented" }, { memoryId: "m1" }, { source: "none" }, { source: "memory", memoryId: "m1" }, { transform: undefined }]) assert.equal(accept([{ ...good, ...change }], [item], facts, [memory()]).accepted.length, 0);
  assert.equal(accept([null], [item]).accepted.length, 0);
});

test("pairing request uses strict schema, configured model, no storage and a cancellable timeout", async () => {
  const [item] = planFor([field("请填写您的学校名称")]);
  const controller = new AbortController();
  let sent;
  const result = await requestPairing({ enabled: true, apiKey: "fixture", model: "configured-model" }, [item], buildCatalog(facts, [], url, "zh"), "zh", controller.signal, async (endpoint, options) => {
    assert.equal(endpoint, "https://api.openai.com/v1/responses"); assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer fixture"); assert.ok(options.signal instanceof AbortSignal);
    controller.abort(); assert.equal(options.signal.aborted, true);
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "output_text", text: '{"pairs":[]}' }] }] }) };
  });
  assert.equal(sent.model, "configured-model"); assert.equal(sent.store, false); assert.equal(sent.max_output_tokens, 2500);
  assert.equal(sent.text.format.name, PAIRING_FORMAT); assert.equal(sent.text.format.strict, true);
  assert.deepEqual(sent.text.format.schema.properties.pairs.items.required, ["fieldId", "source", "factId", "memoryId", "transform"]);
  assert.deepEqual(result, { pairs: [] });
});

test("HTTP, incomplete, refusal, malformed JSON and missing lists surface Chinese errors", async () => {
  const [item] = planFor([field("请填写您的学校名称")]);
  const invoke = (response) => requestPairing({ enabled: true, apiKey: "fixture", model: "fixture" }, [item], buildCatalog(facts, [], url, "zh"), "zh", undefined, async () => response);
  await assert.rejects(invoke({ ok: false, status: 429, json: async () => ({}) }), /请求受限/);
  await assert.rejects(invoke({ ok: false, status: 401, json: async () => ({}) }), /请求失败（401）/);
  for (const data of [{ status: "incomplete" }, { status: "failed" }, {}, null]) await assert.rejects(invoke({ ok: true, json: async () => data }), /未完成本批配对/);
  await assert.rejects(invoke({ ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "refusal" }] }] }) }), /未提供本批配对/);
  await assert.rejects(invoke({ ok: true, json: async () => ({ status: "completed", output_text: "not json" }) }), /无法校验/);
  await assert.rejects(invoke({ ok: true, json: async () => ({ status: "completed", output_text: '{"items":[]}' }) }), /缺少配对列表/);
  await assert.rejects(invoke({ ok: true, json: async () => { throw new Error("bad JSON"); } }), /无法校验/);
});

test("disabled settings fail and an empty candidate list performs no request", async () => {
  const [item] = planFor([field("请填写您的学校名称")]);
  const catalog = buildCatalog(facts, [], url, "zh");
  for (const settings of [{ enabled: false, apiKey: "fixture" }, { enabled: true, apiKey: "" }]) await assert.rejects(requestPairing(settings, [item], catalog, "zh", undefined, () => assert.fail("must not request")), /请先/);
  const result = await requestPairing({ enabled: true, apiKey: "fixture" }, planFor([field("姓名")]), catalog, "zh", undefined, () => assert.fail("must not request"));
  assert.deepEqual(result, { pairs: [] });
});

test("high-confidence empty email and salary questions cannot be paired to a phone fact", () => {
  const phoneFacts = factsFromProfile({ phone: "13900007731" }, "zh");
  for (const label of ["邮箱", "期望薪资"]) {
    const [item] = planFor([field(label)], phoneFacts);
    assert.equal(item.answer, ""); assert.equal(item.ruleConfidence, "high");
    assert.equal(pairingCandidates([item]).length, 1);
    const result = accept([pair(item, "contact.phone")], [item], phoneFacts);
    assert.equal(result.accepted.length, 0); assert.match(result.errors[0].reason, /明确的题意/);
    if (label === "期望薪资") assert.equal(item.sensitive, true);
  }
});

test("pairing preserves an existing sensitive designation even when its fact intent is ordinary", () => {
  const [item] = planFor([field("请填写您的学校名称")]);
  item.sensitive = true;
  const result = accept([pair(item, "education.master.university.zh")], [item]);
  assert.equal(result.accepted[0].sensitive, true);
});

test("unknown repeated experience subjects cannot be supplied by a global alias memory", () => {
  const source = factsFromProfile({ internships: [{ companyZh: "公司甲" }, { companyZh: "公司乙" }] }, "zh");
  const items = planFor([field("公司", { fieldId: "company1", groupId: "internship1", section: "实习经历" }), field("公司", { fieldId: "company2", groupId: "internship2", section: "实习经历" })], source);
  const remembered = memory({ question: "公司名称", entityId: "experience.unknown", answer: "公司甲" });
  const result = accept(items.map((item) => pair(item, null, { source: "memory", memoryId: "m1" })), items, source, [remembered]);
  assert.equal(result.accepted.length, 0); assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every((entry) => /尚未确定/.test(entry.reason)));
  assert.equal(buildCatalog(source, [remembered], url, "zh").memories.length, 0);
  assert.equal(accept(items.map(none), items, source, [remembered]).accepted.length, 2);
});

test("a current-salary question cannot borrow an expected-salary memory through a loose rule", () => {
  const [item] = planFor([field("Current salary")], []);
  const remembered = memory({ question: "Expected salary", answer: "面议" });
  const result = accept([pair(item, null, { source: "memory", memoryId: "m1" })], [item], [], [remembered]);
  assert.equal(item.ruleConfidence, "low"); assert.equal(result.accepted.length, 0);
});

test("splitting date parts validates the whole source date and cannot invent a missing day", () => {
  for (const [value, datePart] of [["2020-02-31", "year"], ["2020-13", "month"], ["2020-02", "day"]]) {
    const source = [{ id: "education.master.start_date", label: "硕士入学日期", entityId: "education.master", value }];
    const [item] = planFor([field("请填写入学日期", { section: "硕士教育", kind: "select", type: "select-one", datePart, options: [{ text: "2020" }, { text: "13" }, { text: "1" }] })], source);
    const result = accept([pair(item, source[0].id)], [item], source);
    assert.equal(result.accepted.length, 0); assert.match(result.errors[0].reason, /日期资料无效|缺少已确认的日/);
  }
  const source = [{ id: "education.master.start_date", label: "硕士入学日期", entityId: "education.master", value: "2020-02-29" }];
  const [item] = planFor([field("请填写入学日期", { section: "硕士教育", kind: "select", type: "select-one", datePart: "day", options: [{ text: "29" }] })], source);
  assert.equal(accept([pair(item, source[0].id)], [item], source).accepted[0].answer, "29");
});

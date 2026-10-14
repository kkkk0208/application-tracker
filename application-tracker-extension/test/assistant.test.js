import test from "node:test";
import assert from "node:assert/strict";
import { factsFromProfile, preparePlan, acceptAiItems, validateValue, interpretField, scopeFor, eligibleFacts, versionOf, MEMORY_SCOPE_VERSION } from "../src/assistant/planner.js";
import { buildAiBatches, buildPayload, requestBatch } from "../src/assistant/ai.js";
const profile = { fullName: "Example Person", fullNameZh: "示例姓名", email: "test@example.com", masterUniversity: "Example University", masterUniversityZh: "示例大学", bachelorUniversityZh: "本科大学", commonAnswers: { expectedSalary: { zh: "面议" }, visaSponsorship: { zh: "是" }, selfIntroduction: { zh: "这是自我介绍" } }, internships: [{ companyZh: "公司甲", roleZh: "分析实习生" }, { companyZh: "公司乙", roleZh: "研究实习生" }] };
const field = (label, extra = {}) => ({ fieldId: label, groupId: "group", label, kind: "text", type: "text", supported: true, value: "", options: [], constraints: {}, section: "基本信息", group: "", ...extra });
const snapshot = (fields) => ({ fields, url: "https://example.com/jobs/one?token=secret", title: "Application" });
const facts = factsFromProfile(profile, "zh");

test("new assistant reads existing profile without mutating it or mixing languages", () => {
  const before = JSON.stringify(profile);
  assert.equal(facts.find((f) => f.id === "identity.full_name.zh").value, "示例姓名");
  assert.equal(facts.some((f) => f.id.endsWith(".en")), false);
  assert.equal(JSON.stringify(profile), before);
});
test("ordinary facts are selected, sensitive answers and narratives require review", () => {
  const plan = preparePlan(snapshot([field("姓名"), field("期望薪资"), field("自我介绍", { kind: "textarea" })]), facts);
  assert.deepEqual(plan.map((p) => p.selected), [true, false, false]);
  assert.equal(plan[1].status, "review");
});
test("family name never receives the applicant's name", () => {
  const [item] = preparePlan(snapshot([field("姓名", { section: "家庭关系", group: "父亲" })]), facts);
  assert.equal(item.entityId, "family.father"); assert.equal(item.answer, "");
});
test("explicit degree labels and default single group choose correct education", () => {
  const [item] = preparePlan(snapshot([field("学校名称")]), facts);
  assert.equal(item.answer, "示例大学");
  const [bachelor] = preparePlan(snapshot([field("学校名称", { section: "本科教育" })]), facts);
  assert.equal(bachelor.answer, "本科大学");
});
test("clean native degree label pairs master's degree locally in education section", () => {
  const degreeFacts = factsFromProfile({ masterDegreeZh: "硕士" }, "zh");
  const [item] = preparePlan(snapshot([field("学历", { section: "教育经历", kind: "select", type: "select-one", options: [{ id: "placeholder", text: "请选择", value: "", disabled: true }, { id: "bachelor", text: "本科", value: "本科", disabled: false }, { id: "master", text: "硕士", value: "硕士", disabled: false }] })]), degreeFacts);
  assert.equal(item.answer, "硕士"); assert.equal(item.status, "ready");
  assert.match(item.source, /^个人信息/); assert.equal(item.selected, true);
});
test("ambiguous repeated groups do not receive the same degree or internship", () => {
  const fields = [field("学校名称", { groupId: "a" }), field("学校名称", { fieldId: "second", groupId: "b" }), field("职位", { section: "实习经历" })];
  assert.ok(preparePlan(snapshot(fields), facts).every((p) => !p.answer));
  const result = preparePlan(snapshot(fields), facts, [], "zh", { a: "education.master", b: "education.bachelor", group: "experience.internship.1" });
  assert.deepEqual(result.map((p) => p.answer), ["示例大学", "本科大学", "研究实习生"]);
});
test("partial visual degree evidence cannot mix bachelor school with default master's major", () => {
  const degreeFacts = factsFromProfile({ ...profile, bachelorMajorZh: "本科专业", masterMajorZh: "硕士专业" }, "zh");
  const fields = [field("学校名称", { section: "本科教育", visualEvidence: "截图V1：学校名称 / 本科教育" }), field("专业", { section: "教育经历" }), field("邮箱")];
  const plan = preparePlan(snapshot(fields), degreeFacts);
  assert.equal(plan[0].answer, "本科大学");
  assert.equal(plan[1].entityId, "education.unknown");
  assert.equal(plan[1].answer, "");
  assert.equal(plan[1].selected, false);
  assert.match(plan[1].reason, /截图仅确认/);
  assert.deepEqual(eligibleFacts(plan[1], degreeFacts), []);
  assert.equal(plan[2].answer, profile.email);
  assert.ok(!buildAiBatches(plan, degreeFacts, snapshot(fields), "zh").some((batch) => batch.fields.some((item) => item.fieldId === "专业")));
  const bound = preparePlan(snapshot(fields), degreeFacts, [], "zh", { group: "education.bachelor" });
  assert.equal(bound[1].answer, "本科专业");
  assert.equal(bound[1].bindingExplicit, true);
});
test("explicit degree labels remain authoritative alongside visual evidence", () => {
  const degreeFacts = factsFromProfile({ ...profile, masterMajorZh: "硕士专业" }, "zh");
  const fields = [field("学校名称", { section: "本科教育", visualEvidence: "截图V1：学校名称 / 本科教育" }), field("专业", { section: "硕士教育" })];
  const plan = preparePlan(snapshot(fields), degreeFacts);
  assert.equal(plan[1].answer, "硕士专业");
  assert.equal(plan[1].visualGroupUnresolved, false);
});
test("award and ethnicity labels override noisy internship context", () => {
  const plan = preparePlan(snapshot([field("奖惩情况", { section: "实习经历" }), field("民族", { section: "姓名" })]), facts);
  assert.ok(plan.every((p) => !p.answer));
});
test("filled and unsupported fields stay unselected", () => {
  const plan = preparePlan(snapshot([field("姓名", { value: "User entered" }), field("邮箱", { supported: false })]), facts);
  assert.deepEqual(plan.map((p) => p.status), ["filled", "unsupported"]);
});
test("memory needs confirmation, exact subject, language and scope", () => {
  const f = field("其他技能");
  const base = { question: f.label, answer: "SQL", entityId: "self", language: "zh", scope: "https://example.com/jobs/one", scopeVersion: MEMORY_SCOPE_VERSION, confirmed: true };
  const get = (m) => preparePlan(snapshot([f]), facts, [m])[0].answer;
  assert.equal(get(base), "SQL");
  for (const patch of [{ confirmed: false }, { language: "en" }, { entityId: "family.father" }, { scope: "https://example.com/jobs/two" }]) assert.equal(get({ ...base, ...patch }), "");
});
test("conflicting memories remain unresolved", () => {
  const base = { question: "其他技能", entityId: "self", language: "zh", scope: "global", confirmed: true };
  assert.equal(preparePlan(snapshot([field("其他技能")]), facts, [{ ...base, answer: "a" }, { ...base, answer: "b" }])[0].answer, "");
});
test("option validation uses unique exact text and rejects negative substrings", () => {
  const f = field("是否", { options: [{ id: "a", text: "不是", disabled: false }, { id: "b", text: "请选择", disabled: true }] });
  assert.ok(validateValue(f, "是")); assert.ok(validateValue(f, "请选择")); assert.equal(validateValue(f, "不是"), "");
});
test("invalid dates, precision, length and numeric range are rejected", () => {
  assert.ok(validateValue(field("生日", { type: "date" }), "2026-02-30"));
  assert.ok(validateValue(field("生日", { type: "date" }), "2026-02"));
  assert.equal(validateValue(field("生日", { type: "date" }), "2024-02-29"), "");
  assert.ok(validateValue(field("text", { constraints: { maxLength: 3 } }), "abcd"));
  assert.ok(validateValue(field("number", { type: "number", constraints: { min: "3" } }), "2"));
});
test("AI cannot use salary or eligibility facts interchangeably", () => {
  const [item] = preparePlan(snapshot([field("期望薪资")]), facts);
  assert.deepEqual(eligibleFacts(item, facts).map((f) => f.id), ["common_answer.expectedSalary.zh"]);
  const result = acceptAiItems({ items: [{ fieldId: item.fieldId, entityId: "self", kind: "fact", factIds: ["common_answer.visaSponsorship.zh"] }] }, [item], facts);
  assert.equal(result.accepted.length, 0);
});
test("AI duplicate, invented, stale source and wrong entity suggestions are rejected", () => {
  const plan = preparePlan(snapshot([field("姓名")]), facts);
  const base = { fieldId: "姓名", entityId: "self", kind: "fact", factIds: ["identity.full_name.zh"] };
  for (const items of [[base, base], [{ ...base, fieldId: "unknown" }], [{ ...base, factIds: ["madeup"] }], [{ ...base, entityId: "father" }]]) assert.equal(acceptAiItems({ items }, plan, facts).accepted.length, 0);
});
test("AI fact text is derived locally and AI never selects its own suggestions", () => {
  const plan = preparePlan(snapshot([field("姓名")]), facts);
  const result = acceptAiItems({ items: [{ fieldId: "姓名", entityId: "self", kind: "fact", factIds: ["identity.full_name.zh"], text: "Invented" }] }, plan, facts);
  assert.equal(result.accepted[0].answer, "示例姓名"); assert.equal(result.accepted[0].selected, false);
});
test("AI cannot rewrite edited answers or generate factual free text", () => {
  const plan = preparePlan(snapshot([field("姓名")]), facts);
  const item = { fieldId: "姓名", entityId: "self", kind: "draft", factIds: ["identity.full_name.zh"], text: "Fake" };
  assert.equal(acceptAiItems({ items: [item] }, plan, facts).accepted.length, 0);
  plan[0].edited = true;
  assert.equal(acceptAiItems({ items: [{ ...item, kind: "fact" }] }, plan, facts).accepted.length, 0);
});
test("AI batching covers more than 120 fields without sending existing answers or URL tokens", () => {
  const s = snapshot(Array.from({ length: 125 }, (_, i) => field("自我介绍", { fieldId: String(i), kind: "textarea" })));
  const plan = preparePlan(s, facts);
  const batches = buildAiBatches(plan, facts, s, "zh");
  assert.equal(batches.reduce((n, b) => n + b.fields.length, 0), 125);
  const text = JSON.stringify(batches);
  assert.ok(!text.includes("token=secret")); assert.ok(!text.includes("test@example.com"));
});
test("API request uses strict schema, preserves selected model and disables response storage", () => {
  const body = buildPayload("user-configured-model", {});
  assert.equal(body.store, false); assert.equal(body.model, "user-configured-model"); assert.equal(body.text.format.strict, true);
});
test("truncated, malformed and refused API responses surface failures", async () => {
  const settings = { enabled: true, apiKey: "fixture", model: "fixture" };
  for (const data of [{ status: "incomplete" }, { output_text: "not json" }, { output: [{ content: [{ type: "refusal" }] }] }]) {
    await assert.rejects(requestBatch(settings, { fields: [] }, [], [], undefined, async () => ({ ok: true, json: async () => data })));
  }
});
test("scope strips tokens and versions change with personal information", () => {
  assert.equal(scopeFor("https://example.com/apply?token=abc#secret"), "https://example.com/apply");
  assert.notEqual(versionOf(profile), versionOf({ ...profile, phone: "123" }));
});

test("school location, major ranking and degree grade never become selected facts", () => {
  const source = factsFromProfile({ masterUniversityZh: "示例大学", masterMajorZh: "统计学", masterDegreeZh: "硕士" }, "zh");
  const questions = ["学校所在地", "毕业院校所在城市", "专业排名", "学位成绩", "University address", "Major GPA", "Degree grade"];
  const plan = preparePlan(snapshot(questions.map((label) => field(label, { section: "教育经历" }))), source);
  assert.ok(plan.every((p) => !p.answer && !p.selected && !p.intent && p.needsSemanticReview));
  assert.equal(buildAiBatches(plan, source, snapshot([]), "zh").length, 0);
});









test("confirmed narrative memory is reused without another AI drafting request", () => {
  const source = factsFromProfile({ masterUniversityZh: "示例大学" }, "zh");
  const memory = { id: "intro-memory", question: "自我介绍", answer: "已确认的介绍", confirmed: true, language: "zh", entityId: "self", scope: "global" };
  const s = snapshot([field("自我介绍", { kind: "textarea" })]);
  const plan = preparePlan(s, source, [memory]);
  assert.equal(plan[0].answer, memory.answer);
  assert.ok(eligibleFacts(plan[0], source).length);
  assert.deepEqual(buildAiBatches(plan, source, s, "zh"), []);
});

test("real custom-select options allow semantic mapping but never automatic selection", () => {
  const degreeFacts = factsFromProfile({ masterDegreeZh: "硕士" }, "zh");
  const [item] = preparePlan(snapshot([field("学历", { kind: "custom-select", options: [{ id: "master", text: "硕士研究生", disabled: false }, { id: "bachelor", text: "本科", disabled: false }] })]), degreeFacts);
  const batches = buildAiBatches([item], degreeFacts, snapshot([]), "zh");
  assert.deepEqual(batches[0].fields[0].options, item.options);
  const proposal = { fieldId: item.fieldId, entityId: item.entityId, kind: "option", optionId: "master", factIds: ["education.master.degree.zh"] };
  const result = acceptAiItems({ items: [proposal] }, [item], degreeFacts);
  assert.equal(result.accepted[0].answer, "硕士研究生");
  assert.equal(result.accepted[0].selected, false);
  assert.equal(result.accepted[0].status, "review");
  assert.equal(acceptAiItems({ items: [{ ...proposal, optionId: "invented" }] }, [item], degreeFacts).accepted.length, 0);
  assert.equal(acceptAiItems({ items: [proposal] }, [item], []).accepted.length, 0);
});

test("application scopes preserve business query and SPA routes, removing only private and tracking parameters", () => {
  assert.equal(scopeFor("https://example.com/apply?token=secret&jobId=A&utm_source=site&company=One"), "https://example.com/apply?company=One&jobId=A");
  assert.notEqual(scopeFor("https://example.com/apply?jobId=A"), scopeFor("https://example.com/apply?jobId=B"));
  assert.notEqual(scopeFor("https://example.com/#/job/A"), scopeFor("https://example.com/#/job/B"));
  assert.equal(scopeFor("https://example.com/#/apply?jobId=A&access_token=secret"), "https://example.com/#/apply?jobId=A");
  assert.equal(scopeFor("https://example.com/#jobId=A&token=secret"), "https://example.com/#jobId=A");
  assert.equal(scopeFor("javascript:alert(1)"), "");
});

test("memory from another job or a legacy path-only scope requires fresh confirmation", () => {
  const item = field("为什么申请这个岗位");
  const memory = { question: item.label, answer: "只适用于 A 岗位", entityId: "self", language: "zh", confirmed: true, scope: scopeFor("https://example.com/apply?jobId=A"), scopeVersion: MEMORY_SCOPE_VERSION };
  const forJob = (url, entry = memory) => preparePlan({ ...snapshot([item]), url }, [], [entry])[0].answer;
  assert.equal(forJob("https://example.com/apply?jobId=A&token=secret"), memory.answer);
  assert.equal(forJob("https://example.com/apply?jobId=B"), "");
  assert.equal(forJob("https://example.com/apply", { ...memory, scope: "https://example.com/apply", scopeVersion: undefined }), "");
  assert.equal(forJob("https://example.com/apply?jobId=B", { ...memory, scope: "global", scopeVersion: undefined }), memory.answer);
});


test("versions ignore storage object key ordering but preserve meaningful changes", () => {
  assert.equal(versionOf([{ id: "m", metadata: { b: 2, a: 1 }, answer: "A" }]), versionOf([{ answer: "A", metadata: { a: 1, b: 2 }, id: "m" }]));
  assert.notEqual(versionOf([{ id: "m", answer: "A" }]), versionOf([{ id: "m", answer: "B" }]));
});

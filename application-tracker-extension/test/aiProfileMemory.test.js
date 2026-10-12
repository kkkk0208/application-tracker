import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLocalProfileMemory,
  buildProfileMemoryPayload,
  extractProfileMemory,
  mergeProfileMemoryWithQuestionMemories,
  normalizeProfileMemory
} from "../src/aiProfileMemory.js";

const profile = {
  fullNameZh: "罗凯文",
  englishName: "Kaiwen Luo",
  phone: "+86 18825202614",
  email: "luogaotommy@gmail.com",
  masterUniversity: "University of Hong Kong",
  masterUniversityZh: "香港大学",
  masterDegree: "Master",
  masterMajor: "Master of Accounting",
  internships: [
    {
      company: "ABC",
      companyZh: "ABC 公司",
      role: "Finance Intern",
      roleZh: "财务实习生",
      period: "2025.06 - 2025.08",
      description: "Built weekly reporting dashboards.",
      descriptionZh: "搭建周度报表。"
    }
  ],
  commonAnswers: {
    languageAbility: { zh: "普通话、英语、粤语", en: "Mandarin, English, Cantonese" }
  }
};

test("buildProfileMemoryPayload includes profile fields and learned memories", () => {
  const payload = buildProfileMemoryPayload({
    model: "gpt-5_5",
    profile,
    questionMemories: [{ question: "Why this role?", answer: "I like analytical finance work.", language: "en" }]
  });

  assert.equal(payload.model, "gpt-5_5");
  assert.equal(payload.max_output_tokens, 5000);
  assert.match(payload.input[0].content, /structured personal knowledge library/i);
  assert.match(payload.input[1].content, /罗凯文/);
  assert.match(payload.input[1].content, /University of Hong Kong/);
  assert.match(payload.input[1].content, /Why this role/);
});

test("extractProfileMemory parses fenced JSON into normalized entries", () => {
  const memory = extractProfileMemory({
    output_text: "```json\n{\"summary\":\"Profile memory generated.\",\"entries\":[{\"key\":\"identity.full_name.zh\",\"label\":\"中文姓名\",\"value\":\"罗凯文\",\"language\":\"zh\",\"category\":\"identity\",\"aliases\":[\"姓名\",\"中文名\"],\"sourceFields\":[\"fullNameZh\"]}]}\n```"
  });

  assert.equal(memory.summary, "Profile memory generated.");
  assert.deepEqual(memory.entries, [{
    key: "identity.full_name.zh",
    label: "中文姓名",
    value: "罗凯文",
    language: "zh",
    category: "identity",
    aliases: ["姓名", "中文名"],
    sourceFields: ["fullNameZh"]
  }]);
  assert.ok(memory.updatedAt);
});

test("extractProfileMemory keeps a raw preview when AI returns non-JSON text", () => {
  const memory = extractProfileMemory({
    output_text: "I can summarize the applicant, but I did not return the requested entries array."
  });

  assert.equal(memory.entries.length, 0);
  assert.equal(memory.debug.parseStatus, "no-json-object");
  assert.match(memory.debug.rawTextPreview, /did not return the requested entries array/);
});

test("extractProfileMemory salvages entries from a truncated JSON response", () => {
  const memory = extractProfileMemory({
    output_text: "{\"summary\":\"Profile memory\",\"entries\":[{\"key\":\"identity.full_name.zh\",\"label\":\"中文姓名\",\"value\":\"罗凯文\",\"language\":\"zh\",\"category\":\"identity\",\"aliases\":[\"姓名\"],\"sourceFields\":[\"fullNameZh\"]},{\"key\":\"contact.email\",\"label\":\"邮箱\",\"value\":\"kai@example.com\",\"language\":\"\",\"category\":\"contact\",\"aliases\":[\"Email\"],\"sourceFields\":[\"email\"]}"
  });

  assert.equal(memory.summary, "Profile memory");
  assert.deepEqual(memory.entries.map((entry) => [entry.key, entry.value]), [
    ["identity.full_name.zh", "罗凯文"],
    ["contact.email", "kai@example.com"]
  ]);
  assert.equal(memory.debug.parseStatus, "salvaged-partial-json");
});

test("normalizeProfileMemory drops blank and malformed entries", () => {
  const memory = normalizeProfileMemory({
    summary: " ok ",
    entries: [
      { key: " identity.email ", label: "Email", value: " test@example.com ", aliases: [" 邮箱 ", ""], sourceFields: ["email"] },
      { key: "", label: "Bad", value: "x" },
      { key: "empty", label: "Empty", value: "" }
    ]
  }, "2026-06-04T12:00:00.000Z");

  assert.deepEqual(memory, {
    summary: "ok",
    entries: [{
      key: "identity.email",
      label: "Email",
      value: "test@example.com",
      language: "",
      category: "",
      aliases: ["邮箱"],
      sourceFields: ["email"]
    }],
    updatedAt: "2026-06-04T12:00:00.000Z"
  });
});

test("buildLocalProfileMemory creates fallback entries from profile and learned answers", () => {
  const memory = buildLocalProfileMemory({
    profile,
    questionMemories: [{
      question: "家庭关系 > 父亲 > 职位*",
      displayQuestion: "家庭关系 > 父亲 > 职位*",
      answer: "区域总监",
      language: "zh",
      category: "general"
    }]
  }, "2026-06-04T12:00:00.000Z");

  assert.ok(memory.entries.length >= 8);
  assert.equal(memory.entries.find((entry) => entry.key === "identity.full_name.zh")?.value, "罗凯文");
  assert.equal(memory.entries.find((entry) => entry.key === "contact.email")?.value, "luogaotommy@gmail.com");
  assert.equal(memory.entries.find((entry) => entry.key === "education.master.university.en")?.value, "University of Hong Kong");
  assert.equal(memory.entries.find((entry) => entry.key === "learned_answer.0")?.value, "区域总监");
});

test("mergeProfileMemoryWithQuestionMemories refreshes learned answers for AI form analysis", () => {
  const memory = mergeProfileMemoryWithQuestionMemories({
    summary: "Existing structured memory.",
    entries: [
      {
        key: "contact.email",
        label: "邮箱",
        value: "kai@example.com",
        category: "contact",
        aliases: ["邮箱"]
      },
      {
        key: "learned_answer.0",
        label: "旧学校名称",
        value: "旧答案",
        category: "learned_answer",
        aliases: ["旧学校名称"]
      }
    ]
  }, [
    {
      question: "学校名称",
      displayQuestion: "教育背景 > 学校名称",
      contextPath: "教育背景 > 学校名称",
      answer: "香港大学",
      language: "zh"
    },
    {
      question: "专业名称",
      displayQuestion: "教育背景 > 专业名称",
      contextPath: "教育背景 > 专业名称",
      answer: "金融学",
      language: "zh"
    }
  ]);

  assert.equal(memory.summary, "Existing structured memory.");
  assert.equal(memory.entries.find((entry) => entry.key === "contact.email")?.value, "kai@example.com");
  assert.equal(memory.entries.some((entry) => entry.value === "旧答案"), false);
  assert.deepEqual(
    memory.entries
      .filter((entry) => entry.category === "learned_answer")
      .map((entry) => [entry.label, entry.value]),
    [
      ["教育背景 > 学校名称", "香港大学"],
      ["教育背景 > 专业名称", "金融学"]
    ]
  );
});

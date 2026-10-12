import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQuestionMemoryEntry,
  extractFilledQuestionAnswers,
  mergeQuestionMemories
} from "../src/questionMemory.js";

test("buildQuestionMemoryEntry normalizes a user-filled answer", () => {
  const entry = buildQuestionMemoryEntry({
    question: " Do you require visa sponsorship? ",
    answer: " No ",
    pageUrl: "https://example.com/apply"
  }, "2026-06-03T10:00:00.000Z");

  assert.equal(entry.question, "Do you require visa sponsorship?");
  assert.equal(entry.answer, "No");
  assert.equal(entry.language, "en");
  assert.equal(entry.category, "work_authorization");
  assert.equal(entry.source, "user_filled");
  assert.equal(entry.createdAt, "2026-06-03T10:00:00.000Z");
  assert.equal(entry.updatedAt, "2026-06-03T10:00:00.000Z");
  assert.ok(entry.id.length > 8);
});

test("extractFilledQuestionAnswers skips blank and unsafe fields", () => {
  const pairs = extractFilledQuestionAnswers([
    { label: "Full name", name: "name", value: "Kai Li", type: "text" },
    { label: "Password", name: "password", value: "secret", type: "password" },
    { label: "Cover letter", name: "cover", value: "", type: "textarea" },
    { label: "Need sponsorship?", name: "sponsorship", value: "No", type: "select-one" }
  ]);

  assert.deepEqual(pairs, [
    { question: "Full name", answer: "Kai Li" },
    { question: "Need sponsorship?", answer: "No" }
  ]);
});

test("extractFilledQuestionAnswers keeps section and group context", () => {
  const pairs = extractFilledQuestionAnswers([
    {
      label: "职位*",
      section: "家庭关系",
      group: "父亲",
      contextPath: "家庭关系 > 父亲 > 职位*",
      value: "区域总监",
      type: "text"
    }
  ]);

  assert.deepEqual(pairs, [{
    question: "职位*",
    answer: "区域总监",
    section: "家庭关系",
    group: "父亲",
    contextPath: "家庭关系 > 父亲 > 职位*"
  }]);
});

test("buildQuestionMemoryEntry stores contextual question path", () => {
  const entry = buildQuestionMemoryEntry({
    question: "职位*",
    answer: "区域总监",
    section: "家庭关系",
    group: "父亲",
    contextPath: "家庭关系 > 父亲 > 职位*"
  }, "2026-06-04T10:00:00.000Z");

  assert.equal(entry.section, "家庭关系");
  assert.equal(entry.group, "父亲");
  assert.equal(entry.contextPath, "家庭关系 > 父亲 > 职位*");
  assert.equal(entry.displayQuestion, "家庭关系 > 父亲 > 职位*");
});

test("mergeQuestionMemories updates similar existing question instead of duplicating", () => {
  const existing = buildQuestionMemoryEntry({
    question: "Do you need visa sponsorship?",
    answer: "No"
  }, "2026-06-02T10:00:00.000Z");
  const incoming = buildQuestionMemoryEntry({
    question: "Do you require visa sponsorship?",
    answer: "No"
  }, "2026-06-03T10:00:00.000Z");

  const merged = mergeQuestionMemories([existing], [incoming], "2026-06-03T10:00:00.000Z");

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, existing.id);
  assert.equal(merged[0].question, "Do you require visa sponsorship?");
  assert.equal(merged[0].updatedAt, "2026-06-03T10:00:00.000Z");
});

test("mergeQuestionMemories keeps contextual entries separate", () => {
  const father = buildQuestionMemoryEntry({
    question: "职位*",
    answer: "区域总监",
    contextPath: "家庭关系 > 父亲 > 职位*"
  }, "2026-06-03T10:00:00.000Z");
  const mother = buildQuestionMemoryEntry({
    question: "职位*",
    answer: "客户总监",
    contextPath: "家庭关系 > 母亲 > 职位*"
  }, "2026-06-04T10:00:00.000Z");

  const merged = mergeQuestionMemories([father], [mother], "2026-06-04T10:00:00.000Z");

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((item) => item.contextPath), [
    "家庭关系 > 父亲 > 职位*",
    "家庭关系 > 母亲 > 职位*"
  ]);
});

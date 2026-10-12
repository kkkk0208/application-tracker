import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePlan } from "../src/assistant/reconcile.js";

const field = { documentId: "doc1", fieldId: "doc1:f1", label: "学校名称", groupId: "doc1:g1", section: "硕士教育", kind: "text", type: "text", entityId: "education.master", intent: "education.master.university", constraints: {}, options: [], supported: true, value: "", answer: "示例大学", selected: true, status: "ready" };
test("refresh preserves edited draft but requires a fresh selection", () => {
  const [item] = reconcilePlan([{ ...field, answer: "人工修改大学", edited: true }], [field]);
  assert.equal(item.answer, "人工修改大学");
  assert.equal(item.edited, true);
  assert.equal(item.selected, false);
});
test("refresh never copies drafts across changed options, questions or documents", () => {
  for (const change of [{ label: "学校所在地", answer: "" }, { documentId: "doc2", fieldId: "doc2:f1", answer: "" }, { options: [{ text: "另一个选项" }], answer: "" }]) {
    const [item] = reconcilePlan([field], [{ ...field, ...change }]);
    assert.equal(item.answer, ""); assert.equal(item.selected, false);
  }
});
test("new fields and manual webpage input are never implicitly approved", () => {
  const items = reconcilePlan([field], [{ ...field, value: "网页手填" }, { ...field, fieldId: "doc1:new" }]);
  assert.equal(items[0].value, "网页手填");
  assert.ok(items.every((item) => !item.selected));
});

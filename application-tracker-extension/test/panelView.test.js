import test from "node:test";
import assert from "node:assert/strict";
import { groupOf, buildPanelView, detectPageLanguage } from "../src/assistant/panelView.js";
const item = (extra = {}) => ({ fieldId: "f", supported: true, value: "", answer: "", entityId: "self", kind: "text", type: "text", labelSource: "label", status: "missing", constraints: {}, ...extra });
test("panel grouping preserves existing website contents before other rules", () => assert.equal(groupOf(item({ value: "saved", supported: false })), "filled"));
test("panel grouping directs unsupported controls to the website", () => assert.equal(groupOf(item({ supported: false })), "web"));
test("panel grouping brings an unsuccessful operation to attention until undone", () => {
  assert.equal(groupOf(item(), { status: "failed" }), "attention");
  assert.equal(groupOf(item(), { status: "failed", undone: true }), "optional");
});
test("panel grouping brings reviews, uncertain labels, invalid answers and unknown subjects to attention", () => {
  for (const extra of [{ status: "review" }, { labelSource: "none" }, { entityId: "education.unknown" }, { type: "email" }]) assert.equal(groupOf(item({ answer: "test", status: "ready", ...extra })), "attention");
});
test("panel grouping collapses reliable fillable answers", () => assert.equal(groupOf(item({ answer: "answer", status: "ready" })), "ready"));
test("panel grouping surfaces required gaps and ambiguous experience matches", () => {
  assert.equal(groupOf(item({ constraints: { required: true } })), "attention");
  assert.equal(groupOf(item({ entityId: "education.unknown" }), null, [{ entityId: "education.master" }]), "attention");
  assert.equal(groupOf(item({ entityId: "education.unknown" }), null, [{ entityId: "experience.internship" }]), "optional");
});
test("panel grouping keeps unrequired unanswered fields optional", () => assert.equal(groupOf(item()), "optional"));
test("panel counters and section summaries preserve page order and latest operation", () => {
  const plan = [item({ fieldId: "1", answer: "a", status: "ready", section: "教育", selected: true }), item({ fieldId: "2", answer: "b", status: "ready", section: "基本", selected: false }), item({ fieldId: "3", answer: "c", status: "ready", section: "教育", selected: true }), item({ fieldId: "4" }), item({ fieldId: "5", supported: false }), item({ fieldId: "6", value: "saved" }), item({ fieldId: "7", constraints: { required: true } })];
  const view = buildPanelView(plan, [{ fieldId: "2", status: "failed" }, { fieldId: "2", status: "verified" }]);
  assert.deepEqual(view.counts, { fill: 2, attention: 1, skip: 3 });
  assert.deepEqual(view.readySections, [{ name: "教育", count: 2 }, { name: "基本", count: 1 }]);
});
test("panel language detection uses labels and page title with a Chinese default", () => {
  assert.equal(detectPageLanguage({ title: "申请表", fields: [{ label: "姓名" }] }), "zh");
  assert.equal(detectPageLanguage({ title: "Apply", fields: [{ label: "Name" }] }), "en");
  assert.equal(detectPageLanguage({ title: "中文ABC" }), "zh");
  assert.equal(detectPageLanguage({ title: "中ABCDEFG" }), "en");
  assert.equal(detectPageLanguage(), "zh");
});

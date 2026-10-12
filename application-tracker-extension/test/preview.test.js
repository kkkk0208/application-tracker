import test from "node:test";
import assert from "node:assert/strict";
import { isFillable, finalizePreview, previewStats } from "../src/assistant/preview.js";

const field = (patch = {}) => ({
  documentId: "doc", fieldId: "doc:f1", groupId: "doc:g1", label: "姓名", section: "基本信息", group: "",
  kind: "text", type: "text", entityId: "self", intent: "identity.full_name", supported: true,
  value: "", answer: "示例姓名", options: [], constraints: {}, source: "个人信息", factIds: ["identity.full_name.zh"],
  status: "ready", selected: false, ...patch
});

test("one confirmation batch defaults to all valid local, AI, memory, sensitive and narrative answers", () => {
  const plan = [
    field(),
    field({ fieldId: "doc:ai", label: "申请动机", intent: "common_answer.whyRole", answer: "经核对的申请动机草稿", source: "AI 草稿", status: "review", narrative: true, kind: "textarea" }),
    field({ fieldId: "doc:memory", answer: "已确认的历史回答", source: "已确认问答记忆", memoryId: "m1", status: "review" }),
    field({ fieldId: "doc:visa", label: "签证担保", intent: "common_answer.visaSponsorship", answer: "需要", sensitive: true, status: "review" }),
    field({ fieldId: "doc:manual", answer: "本次手动回答", edited: true, source: "本次手动编辑", status: "review" })
  ];
  const before = structuredClone(plan);
  const preview = finalizePreview(plan);
  assert.ok(preview.every((item) => item.selected));
  assert.deepEqual(plan, before, "building the preview does not mutate or generate answers");
  assert.deepEqual(preview.map(({ answer, source, factIds }) => ({ answer, source, factIds })), plan.map(({ answer, source, factIds }) => ({ answer, source, factIds })));
  assert.deepEqual(previewStats(preview), { eligible: 5, selected: 5, review: 4, missing: 0, filled: 0 });
});

test("invalid answers, missing data, unsafe or unsupported controls and existing page values stay out", () => {
  const plan = [
    field({ fieldId: "blank", answer: " \n " }),
    field({ fieldId: "email", type: "email", answer: "invalid" }),
    field({ fieldId: "date", type: "date", answer: "2026-02-30" }),
    field({ fieldId: "length", constraints: { maxLength: 2 }, answer: "太长的答案" }),
    field({ fieldId: "password", type: "password", supported: false }),
    field({ fieldId: "consent", label: "同意声明", supported: false }),
    field({ fieldId: "file", type: "file", supported: false }),
    field({ fieldId: "filled", value: "网页已经填写", selected: true })
  ];
  const preview = finalizePreview(plan);
  assert.ok(preview.every((item) => !item.selected && !isFillable(item)));
  assert.deepEqual(previewStats(preview), { eligible: 0, selected: 0, review: 0, missing: 7, filled: 1 });
});

test("custom dropdowns require successfully read real options and a uniquely matching answer", () => {
  const custom = field({ kind: "custom-select", answer: "硕士研究生", status: "review" });
  const options = [{ id: "op-master", text: "硕士研究生", disabled: false }, { id: "op-bachelor", text: "本科", disabled: false }];
  assert.equal(isFillable(custom), false);
  assert.equal(isFillable({ ...custom, options, optionError: "菜单未恢复" }), false);
  assert.equal(isFillable({ ...custom, options: [{ text: "硕士研究生", disabled: false }] }), false);
  assert.equal(isFillable({ ...custom, options: [{ ...options[0], disabled: true }] }), false);
  assert.equal(isFillable({ ...custom, options, answer: "网页没有的选项" }), false);
  assert.equal(isFillable({ ...custom, options: [...options, { ...options[0], id: "duplicate" }] }), false);
  const [preview] = finalizePreview([{ ...custom, options, optionError: "" }]);
  assert.equal(preview.selected, true);
  assert.equal(preview.status, "review");
});

test("same-question explicit opt-outs survive refreshed default answers", () => {
  const previous = [field({ selected: false, selectionExplicit: true, answer: "较早的答案" })];
  const [preview] = finalizePreview([field({ answer: "重新准备的答案" })], previous);
  assert.equal(preview.selected, false);
  assert.equal(preview.selectionExplicit, true);
  assert.equal(preview.answer, "重新准备的答案");
  assert.deepEqual(previewStats([preview]), { eligible: 1, selected: 0, review: 0, missing: 0, filled: 0 });
});

test("explicit opt-outs are not inherited across changed questions, documents, subjects or options", () => {
  const previous = [field({ selected: false, selectionExplicit: true })];
  for (const change of [
    { label: "学校名称" },
    { documentId: "new-document" },
    { entityId: "family.father" },
    { groupId: "another-group" },
    { constraints: { maxLength: 100 } },
    { options: [{ id: "op1", text: "示例姓名", disabled: false }] }
  ]) {
    const [preview] = finalizePreview([field(change)], previous);
    assert.equal(preview.selected, true, JSON.stringify(change));
    assert.equal(preview.selectionExplicit, false, JSON.stringify(change));
  }
});

test("current explicit choices take precedence over the previous preview", () => {
  const previous = [field({ selected: false, selectionExplicit: true })];
  const [selected] = finalizePreview([field({ selected: true, selectionExplicit: true })], previous);
  assert.equal(selected.selected, true);
  const [cleared] = finalizePreview([field({ selected: false, selectionExplicit: false })], previous);
  assert.equal(cleared.selected, true);
  const [excluded] = finalizePreview([field({ selected: false, selectionExplicit: true })], [field({ selected: true })]);
  assert.equal(excluded.selected, false);
});

test("correcting an invalid manual answer selects it once the UI clears the explicit choice marker", () => {
  const [invalid] = finalizePreview([field({ type: "email", answer: "invalid", edited: true, selectionExplicit: false })]);
  assert.equal(invalid.selected, false);
  const [corrected] = finalizePreview([{ ...invalid, answer: "fixed@example.com", selectionExplicit: false }], [invalid]);
  assert.equal(corrected.selected, true);
  assert.equal(corrected.edited, true);
});

test("statistics ignore stale selections on invalid fields and count review only within the selected batch", () => {
  const plan = [
    field({ selected: true }),
    field({ fieldId: "review", selected: true, status: "review" }),
    field({ fieldId: "unchecked", selected: false, status: "review" }),
    field({ fieldId: "invalid", selected: true, answer: "" }),
    field({ fieldId: "filled", selected: true, value: "已有答案" })
  ];
  assert.deepEqual(previewStats(plan), { eligible: 3, selected: 2, review: 1, missing: 1, filled: 1 });
  assert.deepEqual(previewStats([]), { eligible: 0, selected: 0, review: 0, missing: 0, filled: 0 });
});

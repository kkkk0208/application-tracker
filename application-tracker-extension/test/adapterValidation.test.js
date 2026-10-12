import test from "node:test";
import assert from "node:assert/strict";
import { answerForFact, validateValue } from "../src/assistant/planner.js";
import { isFillable } from "../src/assistant/preview.js";

const field = (extra) => ({ supported: true, value: "", kind: "text", type: "text", constraints: {}, options: [], ...extra });
test("new date adapters validate formats and impossible dates before confirmation", () => {
  const date = field({ kind: "date", adapter: "my97-date", dateFormat: "yyyy-MM" });
  assert.equal(answerForFact(date, "2022/09"), "2022-09");
  assert.equal(validateValue(date, "2022-09"), "");
  assert.ok(validateValue(date, "2022-13"));
  const range = field({ kind: "date", dateRange: true, dateFormat: "YYYY-MM-DD" });
  assert.equal(isFillable({ ...range, answer: '["2022-09-01","2023-06-30"]' }), true);
  assert.equal(isFillable({ ...range, answer: '["2022-09-01","2023-06-31"]' }), false);
});
test("cascaders require an explicit ordered path", () => {
  const cascader = field({ kind: "cascader", options: [{ text: "广东省", id: "a" }] });
  assert.equal(validateValue(cascader, '["广东省","深圳市"]'), "");
  for (const value of ["深圳市", "[]", '["广东省",null]']) assert.ok(validateValue(cascader, value));
});
test("local choice answers use the unique real synonym and reject ambiguous alternatives", () => {
  const select = field({ kind: "custom-select", options: [{ text: "硕士", id: "master" }, { text: "本科", id: "bachelor" }] });
  assert.equal(answerForFact(select, "硕士研究生"), "硕士");
  assert.equal(isFillable({ ...select, answer: "硕士研究生" }), true);
  assert.equal(isFillable({ ...select, options: [...select.options, { text: "Master", id: "second" }], answer: "硕士研究生" }), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeDateFormat, parseDateValue, formatDateValue, validateDateValue } from "../src/assistant/dateValue.js";
import { answerForFact } from "../src/assistant/planner.js";

test("date hints keep only their date tokens", () => {
  for (const [hint, expected] of [
    ["YYYY-MM", "YYYY-MM"], ["yyyy-MM-dd", "YYYY-MM-DD"], ["yyyy.MM", "YYYY.MM"], ["yyyy-mm-dd", "YYYY-MM-DD"],
    ["入学时间(YYYY-MM)", "YYYY-MM"], ["Start Date (YYYY-MM)", "YYYY-MM"], ["YYYY年MM月", "YYYY年MM月"],
    ["DD/MM/YYYY", "DD/MM/YYYY"], ["yyyy-MM-dd HH:mm", "YYYY-MM-DD"], ["My YYYY.MM field", "YYYY.MM"], ["Start Date", ""], ["请选择日期", ""]
  ]) assert.equal(normalizeDateFormat(hint), expected, hint);
});

test("date parsing and output retain precision across site hints", () => {
  assert.equal(formatDateValue("2020-09", "My yyyy.mm field"), "2020.09");
  assert.equal(formatDateValue("2020-09", "Start Date"), "2020-09");
  assert.equal(formatDateValue("15/09/2020", "Start Date (dd/mm/yyyy)"), "15/09/2020");
  assert.equal(parseDateValue("1900-02-29"), null);
  assert.deepEqual(parseDateValue("0004-02-29"), { year: 4, month: 2, day: 29 });
});

test("serialized page date helpers stay identical to the planner helpers", async () => {
  const source = await readFile(new URL("../src/assistant/pageBridge.js", import.meta.url), "utf8");
  for (const helper of [normalizeDateFormat, parseDateValue, formatDateValue]) assert.ok(source.includes(helper.toString()), helper.name);
});

test("month facts follow the site format instead of copying placeholder text", () => {
  const field = (dateFormat) => ({ kind: "date", type: "text", supported: true, dateFormat, dateRange: false, constraints: {}, options: [] });
  assert.equal(answerForFact(field("入学时间(YYYY-MM)"), "2020-09"), "2020-09");
  assert.equal(answerForFact(field("Start Date (YYYY-MM)"), "2020.09"), "2020-09");
  assert.equal(answerForFact(field("yyyy.MM"), "2020-09"), "2020.09");
  assert.equal(validateDateValue(field("入学时间(YYYY-MM)"), "2020-09"), "");
});

import test from "node:test";
import assert from "node:assert/strict";
import { parseDateValue, formatDateValue, validateDateValue } from "../src/assistant/dateValue.js";

test("dates validate calendar days and preserve month precision", () => {
  for (const value of ["2022-09", "2022/09", "2022年09月"]) assert.deepEqual(parseDateValue(value), { year: 2022, month: 9, day: null });
  assert.equal(formatDateValue("2022-09", "yyyy-MM"), "2022-09");
  assert.equal(formatDateValue("2022-09", "YYYY年MM月"), "2022年09月");
  assert.equal(formatDateValue("2022-09", "YYYY/MM"), "2022/09");
  assert.equal(formatDateValue("2022-09", "YYYY-MM-DD"), "");
  assert.equal(formatDateValue("2022-09", "YYYY-MM-DD", { allowDefaultDay: true }), "2022-09-01");
  for (const invalid of ["2023-02-29", "2024-02-30", "2026-04-31", "2026-13", "2026-00", "2026-09-00", "invalid"]) assert.equal(parseDateValue(invalid), null, invalid);
  assert.equal(formatDateValue("2024-02-29", "DD/MM/YYYY"), "29/02/2024");
  assert.equal(validateDateValue({ dateFormat: "DD/MM/YYYY" }, "29/02/2024"), "");
});

test("range validation checks both ends, format and chronological order", () => {
  const field = { dateRange: true, dateFormat: "YYYY-MM" };
  assert.equal(validateDateValue(field, '["2022-09","2023-06"]'), "");
  for (const value of ['["2023-06","2022-09"]', '["2022-09"]', '["2022-09","2023-13"]', '["2022/09","2023/06"]', '2022-09']) assert.ok(validateDateValue(field, value), value);
  assert.ok(validateDateValue({ type: "date" }, "2022-09"));
});

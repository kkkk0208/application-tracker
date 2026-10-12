import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { classifyNextActionDate, toDateInputValue } from "../src/dateUtils.js";

test("classifyNextActionDate ignores empty dates", () => {
  assert.equal(classifyNextActionDate("", "2026-06-02"), "none");
});

test("classifyNextActionDate detects overdue dates", () => {
  assert.equal(classifyNextActionDate("2026-06-01", "2026-06-02"), "overdue");
});

test("classifyNextActionDate detects today and next three days", () => {
  assert.equal(classifyNextActionDate("2026-06-02", "2026-06-02"), "upcoming");
  assert.equal(classifyNextActionDate("2026-06-05", "2026-06-02"), "upcoming");
});

test("classifyNextActionDate ignores dates beyond three days", () => {
  assert.equal(classifyNextActionDate("2026-06-06", "2026-06-02"), "none");
});

test("toDateInputValue returns YYYY-MM-DD", () => {
  assert.equal(toDateInputValue(new Date(2026, 5, 2, 23, 10)), "2026-06-02");
});

test("Shanghai midnight uses the local day for drafts and overdue classification", () => {
  const dates = new URL("../src/dateUtils.js", import.meta.url).href;
  const model = new URL("../src/model.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { toDateInputValue, classifyNextActionDate } from ${JSON.stringify(dates)};
    import { todayString } from ${JSON.stringify(model)};
    const now = new Date("2026-09-20T16:05:00Z");
    assert.equal(now.getHours(), 0);
    assert.equal(toDateInputValue(now), "2026-09-21");
    assert.equal(todayString(now), "2026-09-21");
    assert.equal(classifyNextActionDate("2026-09-20", toDateInputValue(now)), "overdue");
  `], { encoding: "utf8", env: { ...process.env, TZ: "Asia/Shanghai" } });
  assert.equal(result.status, 0, result.stderr);
});

test("invalid calendar dates do not produce misleading follow-up highlights", () => {
  assert.equal(classifyNextActionDate("2026-02-30", "2026-03-01"), "none");
});

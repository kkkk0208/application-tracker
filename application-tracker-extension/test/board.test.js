import test from "node:test";
import assert from "node:assert/strict";
import { BOARD_COLUMNS, groupRecordsForBoard } from "../src/board.js";

test("BOARD_COLUMNS keeps the intended kanban order", () => {
  assert.deepEqual(BOARD_COLUMNS.map((column) => column.key), [
    "applied",
    "assessment",
    "interview",
    "offer",
    "rejected",
    "on_hold"
  ]);
});

test("groupRecordsForBoard groups records by job progress stage", () => {
  const grouped = groupRecordsForBoard([
    { id: "1", status: "applied" },
    { id: "2", status: "oa" },
    { id: "3", status: "first_interview" },
    { id: "4", status: "second_interview" },
    { id: "5", status: "final_interview" },
    { id: "6", status: "offer" },
    { id: "7", status: "rejected" },
    { id: "8", status: "withdrawn" },
    { id: "9", status: "on_hold" }
  ]);

  assert.deepEqual(grouped.applied.map((record) => record.id), ["1"]);
  assert.deepEqual(grouped.assessment.map((record) => record.id), ["2"]);
  assert.deepEqual(grouped.interview.map((record) => record.id), ["3", "4", "5"]);
  assert.deepEqual(grouped.offer.map((record) => record.id), ["6"]);
  assert.deepEqual(grouped.rejected.map((record) => record.id), ["7", "8"]);
  assert.deepEqual(grouped.on_hold.map((record) => record.id), ["9"]);
});

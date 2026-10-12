import test from "node:test";
import assert from "node:assert/strict";
import {
  getCompanyInitial,
  getStatusTone,
  summarizeRecords
} from "../src/presentation.js";

test("getStatusTone maps statuses to visual tones", () => {
  assert.equal(getStatusTone("applied"), "neutral");
  assert.equal(getStatusTone("oa"), "active");
  assert.equal(getStatusTone("first_interview"), "active");
  assert.equal(getStatusTone("second_interview"), "active");
  assert.equal(getStatusTone("offer"), "success");
  assert.equal(getStatusTone("rejected"), "danger");
  assert.equal(getStatusTone("on_hold"), "warning");
});

test("summarizeRecords counts total, active, offers, and rejected", () => {
  const summary = summarizeRecords([
    { status: "applied" },
    { status: "oa" },
    { status: "offer" },
    { status: "rejected" },
    { status: "withdrawn" },
    { status: "on_hold" }
  ]);

  assert.deepEqual(summary, {
    total: 6,
    active: 3,
    offers: 1,
    rejected: 2
  });
});

test("getCompanyInitial uses first visible character with fallback", () => {
  assert.equal(getCompanyInitial("OpenAI"), "O");
  assert.equal(getCompanyInitial(" 字节跳动 "), "字");
  assert.equal(getCompanyInitial(""), "?");
});

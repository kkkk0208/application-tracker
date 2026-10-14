import test from "node:test";
import assert from "node:assert/strict";
import {
  createRecord,
  updateRecord,
  validateRecordForSave,
  normalizeImportedRecord,
  getPortalUrl
} from "../src/model.js";

test("createRecord fills system fields and initial status history", () => {
  const record = createRecord({
    company: "Acme",
    role: "Analyst",
    base: "",
    portalLink: "https://example.com/job",
    pageTitle: "Analyst - Acme",
    source: "company_portal",
    appliedDate: "2026-06-02",
    status: "applied",
    nextActionDate: "",
    jdText: "",
    notes: ""
  }, "2026-06-02T10:00:00.000Z");

  assert.equal(record.company, "Acme");
  assert.equal(record.status, "applied");
  assert.equal(record.statusHistory.length, 1);
  assert.equal(record.statusHistory[0].status, "applied");
  assert.equal(record.statusHistory[0].date, "2026-06-02T10:00:00.000Z");
  assert.ok(record.id.length > 8);
  assert.equal(record.createdAt, "2026-06-02T10:00:00.000Z");
  assert.equal(record.updatedAt, "2026-06-02T10:00:00.000Z");
});

test("updateRecord appends status history only when status changes", () => {
  const original = createRecord({
    company: "Acme",
    role: "Analyst",
    base: "",
    portalLink: "https://example.com/job",
    pageTitle: "Analyst - Acme",
    source: "company_portal",
    appliedDate: "2026-06-02",
    status: "applied",
    nextActionDate: "",
    jdText: "",
    notes: ""
  }, "2026-06-02T10:00:00.000Z");

  const unchanged = updateRecord(original, { notes: "first note" }, "2026-06-03T10:00:00.000Z");
  assert.equal(unchanged.statusHistory.length, 1);
  assert.equal(unchanged.updatedAt, "2026-06-03T10:00:00.000Z");

  const changed = updateRecord(unchanged, { status: "oa" }, "2026-06-04T10:00:00.000Z");
  assert.equal(changed.status, "oa");
  assert.equal(changed.statusHistory.length, 2);
  assert.deepEqual(changed.statusHistory[1], {
    status: "oa",
    date: "2026-06-04T10:00:00.000Z"
  });
});

test("validateRecordForSave requires only MVP required-to-save fields", () => {
  const errors = validateRecordForSave({
    company: "",
    role: "",
    portalLink: "",
    source: "",
    appliedDate: "",
    status: ""
  });

  assert.deepEqual(errors, {
    company: "请填写公司",
    role: "请填写岗位",
    portalLink: "请填写 candidate portal link",
    source: "请选择投递来源",
    appliedDate: "请选择投递日期",
    status: "请选择当前进度"
  });
});

test("normalizeImportedRecord rejects invalid enum values", () => {
  assert.throws(() => normalizeImportedRecord({
    id: "id-1",
    company: "Acme",
    role: "Analyst",
    base: "",
    portalLink: "https://example.com/job",
    pageTitle: "",
    source: "unknown",
    appliedDate: "2026-06-02",
    status: "applied",
    statusHistory: "[]",
    nextActionDate: "",
    jdText: "",
    notes: "",
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z"
  }), /Invalid source/);
});

test("createRecord accepts CTgoodjobs source", () => {
  const record = createRecord({
    company: "Acme",
    role: "Analyst",
    base: "Hong Kong",
    portalLink: "https://www.ctgoodjobs.hk/job/123",
    pageTitle: "Analyst - Acme",
    source: "ctgoodjobs",
    appliedDate: "2026-06-03",
    status: "applied",
    nextActionDate: "",
    jdText: "",
    notes: ""
  }, "2026-06-03T10:00:00.000Z");

  assert.equal(record.source, "ctgoodjobs");
});

test("portal references retain plain text and reject executable URL protocols", () => {
  const draft = { company: "示例公司", role: "分析师", portalLink: "微信内推", source: "referral", appliedDate: "2026-10-13", status: "applied" };
  assert.deepEqual(validateRecordForSave(draft), {});
  assert.equal(createRecord(draft).portalLink, "微信内推");
  assert.equal(getPortalUrl("微信内推"), "");
  assert.equal(getPortalUrl("https://example.com/apply"), "https://example.com/apply");
  for (const link of ["javascript:alert(1)", "data:text/html,example", "file:///tmp/example", "https://"]) {
    assert.match(validateRecordForSave({ ...draft, portalLink: link }).portalLink, /http/);
    assert.throws(() => createRecord({ ...draft, portalLink: link }), /http/);
    assert.equal(getPortalUrl(link), "");
  }
});

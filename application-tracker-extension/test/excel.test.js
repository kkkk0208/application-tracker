import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPreImportBackupFilename,
  buildWorkbookSheets,
  EXPORT_COLUMNS,
  recordsToDisplayRows,
  recordsToExportRows,
  rowsToImportedRecords
} from "../src/excel.js";

test("recordsToExportRows includes all required export columns", () => {
  const rows = recordsToExportRows([{
    id: "id-1",
    company: "Acme",
    role: "Analyst",
    base: "London",
    portalLink: "https://example.com/job",
    pageTitle: "Analyst - Acme",
    source: "company_portal",
    appliedDate: "2026-06-02",
    status: "applied",
    statusHistory: [{ status: "applied", date: "2026-06-02T10:00:00.000Z" }],
    nextActionDate: "2026-06-05",
    jdText: "JD",
    notes: "Notes",
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z"
  }]);

  assert.deepEqual(Object.keys(rows[0]), EXPORT_COLUMNS);
  assert.equal(rows[0].statusHistory, "[{\"status\":\"applied\",\"date\":\"2026-06-02T10:00:00.000Z\"}]");
});

test("recordsToDisplayRows uses readable Chinese headers and labels", () => {
  const rows = recordsToDisplayRows([{
    id: "id-1",
    company: "Acme",
    role: "Analyst",
    base: "London",
    portalLink: "https://example.com/job",
    pageTitle: "Analyst - Acme",
    source: "company_portal",
    appliedDate: "2026-06-02",
    status: "oa",
    statusHistory: [{ status: "applied", date: "2026-06-02T10:00:00.000Z" }],
    nextActionDate: "2026-06-05",
    jdText: "JD",
    notes: "Notes",
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z"
  }]);

  assert.deepEqual(Object.keys(rows[0]), [
    "公司",
    "岗位",
    "Base 地",
    "当前进度",
    "投递日期",
    "下次跟进",
    "投递来源",
    "Portal 链接",
    "网页标题",
    "JD 原文或要点",
    "备注",
    "进度时间线",
    "创建时间",
    "更新时间"
  ]);
  assert.equal(rows[0]["当前进度"], "OA / 笔试 / Online Assessment");
  assert.equal(rows[0]["投递来源"], "公司官网 / Portal");
});

test("rowsToImportedRecords validates required columns", () => {
  assert.throws(() => rowsToImportedRecords([{ company: "Acme" }]), /Missing required column: id/);
});

test("rowsToImportedRecords normalizes exported rows", () => {
  const [record] = rowsToImportedRecords([{
    id: "id-1",
    company: "Acme",
    role: "Analyst",
    base: "London",
    portalLink: "https://example.com/job",
    pageTitle: "Analyst - Acme",
    source: "company_portal",
    appliedDate: "2026-06-02",
    status: "applied",
    statusHistory: "[{\"status\":\"applied\",\"date\":\"2026-06-02T10:00:00.000Z\"}]",
    nextActionDate: "",
    jdText: "",
    notes: "",
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z"
  }]);

  assert.equal(record.id, "id-1");
  assert.equal(record.statusHistory.length, 1);
  assert.equal(record.source, "company_portal");
});

test("buildPreImportBackupFilename creates dated xlsx backup filename", () => {
  assert.equal(
    buildPreImportBackupFilename("2026-06-02"),
    "application-records-backup-before-import-2026-06-02.xlsx"
  );
});

test("buildWorkbookSheets places readable sheet before restore data sheet", () => {
  const sheets = buildWorkbookSheets([{
    id: "id-1",
    company: "Acme",
    role: "Analyst",
    base: "London",
    portalLink: "https://example.com/job",
    pageTitle: "Analyst - Acme",
    source: "company_portal",
    appliedDate: "2026-06-02",
    status: "applied",
    statusHistory: [{ status: "applied", date: "2026-06-02T10:00:00.000Z" }],
    nextActionDate: "",
    jdText: "",
    notes: "",
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z"
  }]);

  assert.equal(sheets[0].name, "投递记录");
  assert.equal(sheets[0].hidden, 0);
  assert.equal(sheets[0].rows[0]["公司"], "Acme");
  assert.equal(sheets[1].name, "_restore_data");
  assert.equal(sheets[1].hidden, 2);
  assert.equal(sheets[1].rows[0].company, "Acme");
});

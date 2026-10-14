import test from "node:test";
import assert from "node:assert/strict";
import { createRecord } from "../src/model.js";
import {
  buildPreImportBackupFilename,
  buildWorkbookSheets,
  EXPORT_COLUMNS,
  recordsToDisplayRows,
  recordsToExportRows,
  rowsToImportedRecords,
  workbookToImportedRecords
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
    "更新时间",
    "记录 ID"
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

const excelNow = "2026-10-13T08:00:00.000Z";
const excelRecord = (id, now = excelNow) => ({ ...createRecord({ company: `示例公司 ${id}`, role: "分析师", portalLink: "微信内推", source: "referral", appliedDate: "2026-10-13", status: "applied", notes: "原备注" }, now), id });
function importSheets(sheets, now = "2026-10-14T08:00:00.000Z") {
  const workbook = { SheetNames: sheets.map((sheet) => sheet.name), Sheets: Object.fromEntries(sheets.map((sheet) => [sheet.name, sheet.rows])), Workbook: { Sheets: sheets.map((sheet) => ({ Hidden: sheet.hidden })) } };
  return workbookToImportedRecords(workbook, (rows) => rows, now);
}

test("visible Excel edits take precedence and stable IDs retain metadata after sorting", () => {
  const first = excelRecord("first"), second = excelRecord("second");
  const sheets = buildWorkbookSheets([first, second]);
  sheets[0].rows.reverse();
  sheets[0].rows[1]["备注"] = "Excel 修改后的备注";
  sheets[0].rows[1]["当前进度"] = "Offer";
  const [unchanged, changed] = importSheets(sheets);
  assert.deepEqual(unchanged, second);
  assert.equal(changed.id, first.id);
  assert.equal(changed.notes, "Excel 修改后的备注");
  assert.equal(changed.status, "offer");
  assert.equal(changed.createdAt, first.createdAt);
  assert.equal(changed.updatedAt, "2026-10-14T08:00:00.000Z");
  assert.deepEqual(changed.statusHistory[0], first.statusHistory[0]);
  assert.equal(changed.statusHistory[1].status, "offer");
});

test("visible-only Excel imports readable labels, history and date cells", () => {
  const sheets = buildWorkbookSheets([excelRecord("first")]).slice(0, 1);
  sheets[0].rows[0]["投递日期"] = new Date("2026-10-13T00:00:00Z");
  sheets[0].rows[0]["投递来源"] = "内推";
  const [record] = importSheets(sheets);
  assert.equal(record.source, "referral");
  assert.equal(record.appliedDate, "2026-10-13");
  assert.equal(record.statusHistory[0].status, "applied");
  assert.equal(record.portalLink, "微信内推");
});

test("new visible rows receive their own IDs without taking another row's history", () => {
  const first = excelRecord("first");
  const sheets = buildWorkbookSheets([first]);
  sheets[0].rows.push({ ...sheets[0].rows[0], "公司": "新增示例公司", "记录 ID": "", "创建时间": "", "更新时间": "", "进度时间线": "" });
  const imported = importSheets(sheets);
  assert.equal(imported.length, 2);
  assert.notEqual(imported[1].id, first.id);
  assert.equal(imported[1].createdAt, "2026-10-14T08:00:00.000Z");
});

test("old Excel metadata remains compatible when association is unambiguous", () => {
  const first = excelRecord("first");
  const sheets = buildWorkbookSheets([first]);
  delete sheets[0].rows[0]["记录 ID"];
  sheets[0].rows[0]["备注"] = "旧版可见表的编辑";
  const [record] = importSheets(sheets);
  assert.equal(record.id, first.id);
  assert.equal(record.notes, "旧版可见表的编辑");
  assert.deepEqual(record.statusHistory, first.statusHistory);
  assert.deepEqual(importSheets([sheets[1]])[0], first);
});

test("ambiguous old Excel rows and changed system metadata fail clearly instead of ignoring edits", () => {
  const first = excelRecord("first"), second = excelRecord("second");
  const sheets = buildWorkbookSheets([first, second]);
  delete sheets[0].rows[0]["记录 ID"];
  sheets[0].rows[0]["备注"] = "无法按创建时间唯一关联的编辑";
  assert.throws(() => importSheets(sheets), /无法唯一关联/);
  const changedId = buildWorkbookSheets([first]); changedId[0].rows[0]["记录 ID"] = "unrecognized";
  assert.throws(() => importSheets(changedId), /记录 ID/);
  const changedTime = buildWorkbookSheets([first]); changedTime[0].rows[0]["创建时间"] = "2025-01-01T00:00:00Z";
  assert.throws(() => importSheets(changedTime), /系统时间列/);
});

test("Excel import validates visible data and explicitly reads edited timelines", () => {
  const first = excelRecord("first");
  const sheets = buildWorkbookSheets([first]);
  sheets[0].rows[0]["进度时间线"] += " -> 2026-10-14T08:00:00Z Offer";
  assert.equal(importSheets(sheets)[0].statusHistory.length, 3);
  assert.equal(importSheets(sheets)[0].statusHistory.at(-1).status, "applied");
  sheets[0].rows[0]["投递日期"] = "2026-02-30";
  assert.throws(() => importSheets(sheets), /日期/);
  sheets[0].rows[0]["投递日期"] = "2026-10-13";
  sheets[0].rows[0]["Portal 链接"] = "javascript:alert(1)";
  assert.throws(() => importSheets(sheets), /http/);
});

test("visible-only status edits retain supplied history and append the current status", () => {
  const first = excelRecord("first");
  const sheets = buildWorkbookSheets([first]).slice(0, 1);
  sheets[0].rows[0]["当前进度"] = "Offer";
  const [record] = importSheets(sheets);
  assert.equal(record.id, first.id);
  assert.equal(record.status, "offer");
  assert.deepEqual(record.statusHistory[0], first.statusHistory[0]);
  assert.deepEqual(record.statusHistory[1], { status: "offer", date: "2026-10-14T08:00:00.000Z" });
  assert.equal(record.createdAt, first.createdAt);
  assert.equal(record.updatedAt, "2026-10-14T08:00:00.000Z");
});

test("explicit Excel history edits keep intermediate events and reconcile current status", () => {
  const first = excelRecord("first");
  const sheets = buildWorkbookSheets([first]);
  sheets[0].rows[0]["当前进度"] = "Offer";
  sheets[0].rows[0]["进度时间线"] += " -> 2026-10-13T12:00:00Z OA / 笔试 / Online Assessment";
  const [record] = importSheets(sheets);
  assert.deepEqual(record.statusHistory, [
    first.statusHistory[0],
    { status: "oa", date: "2026-10-13T12:00:00Z" },
    { status: "offer", date: "2026-10-14T08:00:00.000Z" }
  ]);
  assert.equal(record.updatedAt, "2026-10-14T08:00:00.000Z");
  sheets[0].rows[0]["进度时间线"] += " -> 2026-10-13T14:00:00Z Offer";
  const [alreadyConsistent] = importSheets(sheets);
  assert.equal(alreadyConsistent.statusHistory.length, 3);
  assert.deepEqual(alreadyConsistent.statusHistory.at(-1), { status: "offer", date: "2026-10-13T14:00:00Z" });
});

import { normalizeImportedRecord, updateRecord } from "./model.js";
import { validateRecords } from "./backup.js";
import { SOURCES, STATUSES } from "./constants.js";

export const EXPORT_COLUMNS = [
  "id",
  "company",
  "role",
  "base",
  "portalLink",
  "pageTitle",
  "source",
  "appliedDate",
  "status",
  "statusHistory",
  "nextActionDate",
  "jdText",
  "notes",
  "createdAt",
  "updatedAt"
];

export function recordsToExportRows(records) {
  return records.map((record) => {
    const row = {};
    for (const column of EXPORT_COLUMNS) {
      row[column] = column === "statusHistory"
        ? JSON.stringify(record.statusHistory || [])
        : record[column] ?? "";
    }
    return row;
  });
}

export function recordsToDisplayRows(records) {
  return records.map((record) => ({
    "公司": record.company ?? "",
    "岗位": record.role ?? "",
    "Base 地": record.base ?? "",
    "当前进度": labelFor(STATUSES, record.status),
    "投递日期": record.appliedDate ?? "",
    "下次跟进": record.nextActionDate ?? "",
    "投递来源": labelFor(SOURCES, record.source),
    "Portal 链接": record.portalLink ?? "",
    "网页标题": record.pageTitle ?? "",
    "JD 原文或要点": record.jdText ?? "",
    "备注": record.notes ?? "",
    "进度时间线": formatStatusHistory(record.statusHistory),
    "创建时间": record.createdAt ?? "",
    "更新时间": record.updatedAt ?? "",
    "记录 ID": record.id ?? ""
  }));
}

export function buildWorkbookSheets(records) {
  return [
    {
      name: "投递记录",
      hidden: 0,
      rows: recordsToDisplayRows(records),
      type: "display"
    },
    {
      name: "_restore_data",
      hidden: 2,
      rows: recordsToExportRows(records),
      type: "raw"
    }
  ];
}

export function buildPreImportBackupFilename(dateString) {
  return `application-records-backup-before-import-${dateString}.xlsx`;
}

export function rowsToImportedRecords(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("Imported sheet is empty or invalid");
  }

  for (const column of EXPORT_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(rows[0] || {}, column)) {
      throw new Error(`Missing required column: ${column}`);
    }
  }

  return validateRecords(rows.map((row) => normalizeImportedRecord(row)));
}

const displayFields = {
  company: "公司", role: "岗位", base: "Base 地", status: "当前进度",
  appliedDate: "投递日期", nextActionDate: "下次跟进", source: "投递来源",
  portalLink: "Portal 链接", pageTitle: "网页标题", jdText: "JD 原文或要点", notes: "备注"
};

// The visible table is authoritative. Hidden rows supply identity and history,
// never an older copy of editable cells. readRows keeps this module independent
// of the XLSX browser library and makes the import policy testable.
export function workbookToImportedRecords(workbook, readRows, now = new Date().toISOString()) {
  const rawName = ["_restore_data", "_data"].find((name) => workbook.SheetNames.includes(name));
  const visibleName = workbook.SheetNames.includes("投递记录") ? "投递记录"
    : workbook.SheetNames.find((name, index) => !["_restore_data", "_data"].includes(name) && !workbook.Workbook?.Sheets?.[index]?.Hidden);
  if (!visibleName) {
    if (!rawName) throw new Error("Excel 中没有可导入的投递记录表");
    return rowsToImportedRecords(readRows(workbook.Sheets[rawName]));
  }
  const rows = readRows(workbook.Sheets[visibleName]);
  if (!rows.length) throw new Error("可见投递记录表为空，请核对后再导入");
  if (!Object.hasOwn(rows[0], "公司")) return rowsToImportedRecords(rows);
  for (const label of Object.values(displayFields)) {
    if (!Object.hasOwn(rows[0], label)) throw new Error(`可见投递记录表缺少列：${label}`);
  }
  const rawRows = rawName ? readRows(workbook.Sheets[rawName]) : [];
  const metadata = rawRows.length ? rowsToImportedRecords(rawRows) : [];
  const byId = new Map(metadata.map((record) => [record.id, record]));
  const used = new Set();
  const imported = rows.map((row, index) => {
    const rowId = text(row["记录 ID"]);
    let previous = rowId ? byId.get(rowId) : undefined;
    if (rowId && metadata.length && !previous) throw new Error(`第 ${index + 2} 行的记录 ID 与隐藏元数据不一致，请勿修改记录 ID`);
    if (!rowId && metadata.length) {
      const createdAt = text(row["创建时间"]);
      let matches = createdAt ? metadata.filter((record) => record.createdAt === createdAt) : [];
      if (matches.length !== 1) {
        matches = metadata.filter((record) => {
          const original = recordsToDisplayRows([record])[0];
          return Object.values(displayFields).every((label) => text(row[label]) === text(original[label]));
        });
      }
      if (matches.length === 1) previous = matches[0];
      else if (createdAt || text(row["进度时间线"]) || text(row["更新时间"])) {
        throw new Error(`旧版 Excel 第 ${index + 2} 行无法唯一关联隐藏记录，已停止导入。请重新导出带记录 ID 的 Excel 后编辑`);
      }
    }
    if (previous && used.has(previous.id)) throw new Error(`第 ${index + 2} 行重复使用同一记录 ID`);
    if (previous) used.add(previous.id);
    const draft = Object.fromEntries(Object.entries(displayFields).map(([field, label]) => [field, text(row[label])]));
    draft.status = keyFor(STATUSES, draft.status, "当前进度");
    draft.source = keyFor(SOURCES, draft.source, "投递来源");
    draft.appliedDate = importedDate(row["投递日期"]);
    draft.nextActionDate = importedDate(row["下次跟进"]);
    const visibleHistory = text(row["进度时间线"]);
    const historyChanged = previous && Object.hasOwn(row, "进度时间线") && visibleHistory !== formatStatusHistory(previous.statusHistory);
    let record = previous ? updateRecord(previous, draft, now) : normalizeImportedRecord({ ...draft, id: rowId, createdAt: text(row["创建时间"]), updatedAt: text(row["更新时间"]) }, now);
    if (historyChanged || !previous && visibleHistory) record.statusHistory = parseDisplayHistory(visibleHistory);
    if (previous && !historyChanged && Object.entries(draft).every(([field, value]) => value === previous[field])) record = previous;
    // A visible-only workbook has no old status to compare with. Retain all
    // user-supplied history, then record the current status if it differs from
    // the final event. The same applies when both status and history are edited.
    if (record.statusHistory.at(-1)?.status !== record.status) {
      record = { ...record, statusHistory: [...record.statusHistory, { status: record.status, date: now }], updatedAt: now };
    }
    // Creation/update timestamps are system metadata; changing them is never
    // silently ignored when an existing hidden record is being retained.
    if (previous && ["创建时间", "更新时间"].some((label) => Object.hasOwn(row, label) && text(row[label]) !== previous[label === "创建时间" ? "createdAt" : "updatedAt"])) {
      throw new Error(`第 ${index + 2} 行修改了系统时间列，请保留创建时间和更新时间，由插件记录更新`);
    }
    return record;
  });
  return validateRecords(imported);
}

function text(value) { return value == null ? "" : String(value).trim(); }

function keyFor(options, value, label) {
  const option = options.find((item) => item.key === value || item.label === value || item.label.split(" / ").includes(value));
  if (!option) throw new Error(`${label}包含不支持的值：${value}`);
  return option.key;
}

function importedDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value)) return new Date((Math.floor(value) - 25569) * 86400000).toISOString().slice(0, 10);
  const formatted = text(value).match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  return formatted ? `${formatted[1]}-${formatted[2].padStart(2, "0")}-${formatted[3].padStart(2, "0")}` : text(value);
}

function parseDisplayHistory(value) {
  if (!value) return [];
  return value.split(" -> ").map((entry) => {
    const match = entry.match(/^(\S+)\s+(.+)$/);
    if (!match) throw new Error("进度时间线格式不正确，请使用导出时的日期和状态格式");
    return { date: match[1], status: keyFor(STATUSES, match[2], "进度时间线") };
  });
}

function formatStatusHistory(statusHistory) {
  if (!Array.isArray(statusHistory)) return "";
  return statusHistory
    .map((item) => `${item.date || ""} ${labelFor(STATUSES, item.status)}`)
    .join(" -> ");
}

function labelFor(options, key) {
  return options.find((option) => option.key === key)?.label || key || "";
}

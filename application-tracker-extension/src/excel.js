import { normalizeImportedRecord } from "./model.js";
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
    "更新时间": record.updatedAt ?? ""
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

  return rows.map((row) => normalizeImportedRecord(row));
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

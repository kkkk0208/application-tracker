import { DEFAULT_STATUS, SOURCE_KEYS, STATUS_KEYS } from "./constants.js";
import { toDateInputValue } from "./dateUtils.js";

export function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `record-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function emptyRecordDraft() {
  return {
    company: "",
    role: "",
    base: "",
    portalLink: "",
    pageTitle: "",
    source: "",
    appliedDate: todayString(),
    status: DEFAULT_STATUS,
    nextActionDate: "",
    jdText: "",
    notes: ""
  };
}

export function todayString(now = new Date()) {
  return toDateInputValue(now);
}

export function createRecord(draft, now = new Date().toISOString()) {
  const normalized = normalizeDraft(draft);
  return {
    id: createId(),
    ...normalized,
    statusHistory: [{ status: normalized.status, date: now }],
    createdAt: now,
    updatedAt: now
  };
}

export function updateRecord(existing, changes, now = new Date().toISOString()) {
  const next = {
    ...existing,
    ...normalizeDraft({ ...existing, ...changes }),
    updatedAt: now
  };

  if (changes.status && changes.status !== existing.status) {
    next.statusHistory = [
      ...(Array.isArray(existing.statusHistory) ? existing.statusHistory : []),
      { status: changes.status, date: now }
    ];
  } else {
    next.statusHistory = Array.isArray(existing.statusHistory) ? existing.statusHistory : [];
  }

  return next;
}

export function validateRecordForSave(record) {
  const errors = {};
  if (!record.company?.trim()) errors.company = "请填写公司";
  if (!record.role?.trim()) errors.role = "请填写岗位";
  if (!record.portalLink?.trim()) errors.portalLink = "请填写 candidate portal link";
  if (!record.source?.trim()) errors.source = "请选择投递来源";
  if (!record.appliedDate?.trim()) errors.appliedDate = "请选择投递日期";
  if (!record.status?.trim()) errors.status = "请选择当前进度";
  return errors;
}

export function normalizeDraft(draft) {
  const normalized = {
    company: stringValue(draft.company),
    role: stringValue(draft.role),
    base: stringValue(draft.base),
    portalLink: stringValue(draft.portalLink),
    pageTitle: stringValue(draft.pageTitle),
    source: stringValue(draft.source),
    appliedDate: stringValue(draft.appliedDate),
    status: stringValue(draft.status || DEFAULT_STATUS),
    nextActionDate: stringValue(draft.nextActionDate),
    jdText: stringValue(draft.jdText),
    notes: stringValue(draft.notes)
  };

  if (normalized.status && !STATUS_KEYS.has(normalized.status)) {
    throw new Error(`Invalid status: ${normalized.status}`);
  }
  if (normalized.source && !SOURCE_KEYS.has(normalized.source)) {
    throw new Error(`Invalid source: ${normalized.source}`);
  }

  return normalized;
}

export function normalizeImportedRecord(row, now = new Date().toISOString()) {
  const normalized = normalizeDraft(row);
  const history = parseStatusHistory(row.statusHistory, normalized.status, now);
  return {
    id: stringValue(row.id) || createId(),
    ...normalized,
    statusHistory: history,
    createdAt: stringValue(row.createdAt) || now,
    updatedAt: stringValue(row.updatedAt) || now
  };
}

function parseStatusHistory(value, fallbackStatus, now) {
  if (!value) {
    return [{ status: fallbackStatus, date: now }];
  }
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid statusHistory: expected array");
  }
  for (const item of parsed) {
    if (!STATUS_KEYS.has(item.status)) {
      throw new Error(`Invalid status: ${item.status}`);
    }
  }
  return parsed;
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}

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
  normalized.portalLink = cleanPortalUrl(normalized.portalLink);
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
  if (Object.hasOwn(changes, "portalLink")) next.portalLink = cleanPortalUrl(next.portalLink);

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
  else if (portalReferenceError(record.portalLink)) errors.portalLink = portalReferenceError(record.portalLink);
  if (!record.source?.trim()) errors.source = "请选择投递来源";
  if (!record.appliedDate?.trim()) errors.appliedDate = "请选择投递日期";
  if (!record.status?.trim()) errors.status = "请选择当前进度";
  return errors;
}

// A reference may be a web URL or plain text such as “微信内推”. Only web URLs
// are clickable; text references must survive export and recovery unchanged.
export function getPortalUrl(value) {
  const text = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(text)) return "";
  try {
    const url = new URL(text);
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch { return ""; }
}

// Only real web addresses and unsafe address schemes are checked. Text such as
// "Referral: Alice", "Email: hr@example.com" or "mailto:…" stays plain text.
function portalReferenceError(value) {
  const text = String(value ?? "").trim();
  const unsafe = /^(?:javascript|data|vbscript|file|blob)\s*:/i.test(text);
  const brokenWeb = /^https?:/i.test(text) && !getPortalUrl(text);
  return unsafe || brokenWeb ? "投递链接必须是有效的 http 或 https 地址；非链接来源请填写普通文字" : "";
}

// Application links often carry login tickets or tracking. Keep business
// parameters and hash routes, drop credentials before a record is stored.
const PRIVATE_LINK_PARAMETER = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth(?:orization)?|api[_-]?key|key|secret|password|session(?:id)?|session[_-]?id|sid|jsessionid|code|state|nonce|ticket|st|sign|signature|login(?:token|ticket|key))$|(?:^|[_-])(?:token|secret|password|ticket|signature)$/i;
const TRACKING_LINK_PARAMETER = /^(?:utm_.+|gclid|fbclid|msclkid|tracking)$/i;
export function cleanPortalUrl(value) {
  const href = getPortalUrl(value);
  if (!href) return String(value ?? "").trim();
  const url = new URL(href);
  for (const name of [...url.searchParams.keys()]) if (PRIVATE_LINK_PARAMETER.test(name) || TRACKING_LINK_PARAMETER.test(name)) url.searchParams.delete(name);
  url.username = ""; url.password = "";
  const hash = url.hash.slice(1);
  const cleanHashQuery = (query) => {
    const params = new URLSearchParams(query);
    for (const name of [...params.keys()]) if (PRIVATE_LINK_PARAMETER.test(name) || TRACKING_LINK_PARAMETER.test(name)) params.delete(name);
    return params.toString();
  };
  if (/^!?\//.test(hash)) {
    const at = hash.indexOf("?");
    const query = at < 0 ? "" : cleanHashQuery(hash.slice(at + 1));
    url.hash = (at < 0 ? hash : hash.slice(0, at)) + (query ? "?" + query : "");
  } else if (hash.includes("=")) url.hash = cleanHashQuery(hash.replace(/^\?/, ""));
  else url.hash = "";
  return url.href;
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

  const portalError = portalReferenceError(normalized.portalLink);
  if (portalError) throw new Error(portalError);

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

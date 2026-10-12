import { normalizeImportedRecord, validateRecordForSave } from "./model.js";
import { normalizeProfile, PROFILE_FIELDS, COMMON_ANSWER_FIELDS, profileHasUsableFields } from "./profile.js";
import { STATUS_KEYS } from "./constants.js";

export const BACKUP_FORMAT = "application-tracker-backup";
export const BACKUP_SCHEMA_VERSION = 3;
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const recordFields = ["id", "company", "role", "base", "portalLink", "pageTitle", "source", "appliedDate", "status", "statusHistory", "nextActionDate", "jdText", "notes", "createdAt", "updatedAt"];
const memoryFields = ["id", "question", "answer", "language", "entityId", "scope", "scopeVersion", "confirmed", "origin", "contextPath", "updatedAt", "createdAt", "history", "section", "group", "category", "source", "pageUrl", "displayQuestion", "lastUsedAt"];
const internshipFields = ["company", "companyZh", "role", "roleZh", "period", "description", "descriptionZh"];
const dataFields = ["records", "profile", "memories", "legacyMemories", "legacyMemoryBackup"];
const fail = (message) => { throw new Error(`备份校验失败：${message}`); };
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
function expectObject(value, name) { if (!object(value)) fail(`${name}应为对象`); }
function knownKeys(value, keys, name) { for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${name}包含未知字段 ${key}`); }
function string(value, name, required = false) { if (typeof value !== "string" || required && !value.trim()) fail(`${name}应为${required ? "非空" : ""}文本`); }
function optionalStrings(value, fields, name) { for (const key of fields) if (Object.hasOwn(value, key)) string(value[key], `${name}.${key}`); }
function array(value, name) { if (!Array.isArray(value) || value.length > 50000) fail(`${name}应为不超过 50000 项的列表`); }
function uniqueIds(items, name) { const seen = new Set(); for (const item of items) { if (seen.has(item.id)) fail(`${name}中存在重复 ID`); seen.add(item.id); } }
function validDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T12:00:00Z`); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value; }

function validateRecords(records) {
  array(records, "投递记录");
  const output = records.map((record) => {
    expectObject(record, "投递记录"); knownKeys(record, recordFields, "投递记录");
    string(record.id, "记录 ID", true);
    optionalStrings(record, recordFields.filter((key) => key !== "statusHistory"), "投递记录");
    if (Object.keys(validateRecordForSave(record)).length) fail("投递记录缺少公司、岗位、链接、来源、投递日期或状态");
    if (!validDate(record.appliedDate) || record.nextActionDate && !validDate(record.nextActionDate)) fail("投递日期格式不正确");
    let url; try { url = new URL(record.portalLink); } catch { fail("投递链接格式不正确"); }
    if (!/^https?:$/.test(url.protocol)) fail("投递链接必须使用 http 或 https");
    array(record.statusHistory, "进度时间线");
    for (const entry of record.statusHistory) {
      expectObject(entry, "时间线条目"); knownKeys(entry, ["status", "date"], "时间线条目");
      if (!STATUS_KEYS.has(entry.status)) fail("时间线包含未知状态");
      string(entry.date, "时间线日期", true);
    }
    return normalizeImportedRecord(record);
  });
  uniqueIds(output, "投递记录"); return output;
}
function validateProfile(profile) {
  expectObject(profile, "个人资料"); knownKeys(profile, [...PROFILE_FIELDS, "university", "degree", "major", "graduationDate"], "个人资料");
  optionalStrings(profile, [...PROFILE_FIELDS.filter((key) => !["internships", "commonAnswers"].includes(key)), "university", "degree", "major", "graduationDate"], "个人资料");
  if (profile.internships !== undefined) {
    array(profile.internships, "实习经历");
    for (const entry of profile.internships) { expectObject(entry, "实习经历"); knownKeys(entry, internshipFields, "实习经历"); optionalStrings(entry, internshipFields, "实习经历"); }
  }
  if (profile.commonAnswers !== undefined) {
    expectObject(profile.commonAnswers, "常见答案"); knownKeys(profile.commonAnswers, COMMON_ANSWER_FIELDS, "常见答案");
    for (const entry of Object.values(profile.commonAnswers)) { expectObject(entry, "双语答案"); knownKeys(entry, ["zh", "en"], "双语答案"); optionalStrings(entry, ["zh", "en"], "双语答案"); }
  }
  return normalizeProfile(profile);
}
function validateMemories(memories, name, legacy = false) {
  array(memories, name);
  const output = memories.map((entry) => {
    expectObject(entry, name); knownKeys(entry, memoryFields, name);
    string(entry.id, `${name} ID`, true); string(entry.question, `${name}问题`, true); string(entry.answer, `${name}答案`, true);
    optionalStrings(entry, memoryFields.filter((key) => !["scopeVersion", "confirmed", "history"].includes(key)), name);
    if (entry.language !== undefined && !["zh", "en"].includes(entry.language)) fail(`${name}语言应为中文或英文`);
    if (entry.confirmed !== undefined && typeof entry.confirmed !== "boolean") fail(`${name}确认状态不正确`);
    if (entry.scopeVersion !== undefined && (!Number.isInteger(entry.scopeVersion) || entry.scopeVersion < 1)) fail(`${name}范围版本不正确`);
    if (!legacy && entry.confirmed && (!entry.entityId || !entry.scope || !entry.language)) fail("已确认问答缺少主体、语言或适用范围");
    if (entry.scope && entry.scope !== "global") {
      let url; try { url = new URL(entry.scope); } catch { fail(`${name}适用范围不是有效链接`); }
      if (!/^https?:$/.test(url.protocol)) fail(`${name}适用范围必须使用 http 或 https`);
    }
    if (entry.history !== undefined) {
      array(entry.history, "记忆历史");
      for (const item of entry.history) { expectObject(item, "记忆历史"); knownKeys(item, ["answer", "scope", "updatedAt"], "记忆历史"); optionalStrings(item, ["answer", "scope", "updatedAt"], "记忆历史"); }
    }
    return structuredClone(entry);
  });
  uniqueIds(output, name); return output;
}

export function validateBackup(value) {
  expectObject(value, "文件内容");
  const old = value.schemaVersion === 2 && value.format === undefined;
  knownKeys(value, old ? ["schemaVersion", "exportedAt", "profile", "memories", "legacyMemories"] : ["format", "schemaVersion", "exportedAt", "data"], "备份");
  if (!old && (value.format !== BACKUP_FORMAT || value.schemaVersion !== BACKUP_SCHEMA_VERSION)) fail("不支持此文件或备份版本");
  string(value.exportedAt, "导出时间", true);
  if (Number.isNaN(Date.parse(value.exportedAt))) fail("导出时间不正确");
  const data = old ? { records: [], profile: value.profile, memories: value.memories, legacyMemories: value.legacyMemories, legacyMemoryBackup: [] } : value.data;
  expectObject(data, "备份数据"); knownKeys(data, dataFields, "备份数据");
  return {
    format: BACKUP_FORMAT, schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: value.exportedAt,
    data: { records: validateRecords(data.records), profile: validateProfile(data.profile), memories: validateMemories(data.memories, "问答记忆"), legacyMemories: validateMemories(data.legacyMemories, "旧问答记忆", true), legacyMemoryBackup: validateMemories(data.legacyMemoryBackup, "原始历史备份", true) },
    partial: old
  };
}

export function createBackup(data, now = new Date().toISOString()) {
  // Whitelist the export rather than dumping chrome.storage (which also contains credentials).
  const clean = {
    records: (data.records || []).map((record) => pick(record, recordFields)),
    profile: normalizeProfile(data.profile || {}),
    memories: (data.memories || []).map((entry) => pick(entry, memoryFields)),
    legacyMemories: (data.legacyMemories || []).map((entry) => pick(entry, memoryFields)),
    legacyMemoryBackup: (data.legacyMemoryBackup || []).map((entry) => pick(entry, memoryFields))
  };
  const checked = validateBackup({ format: BACKUP_FORMAT, schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: now, data: clean });
  const { partial, ...backup } = checked;
  return backup;
}

export function prepareRestore(current, input, mode = "merge") {
  if (!["merge", "replace"].includes(mode)) fail("请选择合并或替换");
  const backup = validateBackup(input);
  const incoming = backup.data;
  const normalizedCurrent = createBackup(current).data;
  const profileKept = mode === "merge" && profileHasUsableFields(normalizedCurrent.profile);
  const profileConflict = profileKept && JSON.stringify(normalizedCurrent.profile) !== JSON.stringify(incoming.profile);
  let conflictCount = 0;
  const merge = (existing, added) => {
    const ids = new Set(existing.map((item) => item.id));
    conflictCount += added.filter((item) => ids.has(item.id)).length;
    return [...existing, ...added.filter((item) => !ids.has(item.id))];
  };
  const data = mode === "replace" ? { ...incoming, records: backup.partial ? normalizedCurrent.records : incoming.records, legacyMemoryBackup: backup.partial ? normalizedCurrent.legacyMemoryBackup : incoming.legacyMemoryBackup } : {
    records: merge(normalizedCurrent.records, incoming.records),
    profile: profileKept ? normalizedCurrent.profile : incoming.profile,
    memories: merge(normalizedCurrent.memories, incoming.memories.map((entry) => profileConflict ? { ...entry, confirmed: false } : entry)),
    legacyMemories: merge(normalizedCurrent.legacyMemories, incoming.legacyMemories),
    legacyMemoryBackup: merge(normalizedCurrent.legacyMemoryBackup, incoming.legacyMemoryBackup)
  };
  return { data, summary: { mode, partial: backup.partial, incomingRecords: incoming.records.length, incomingMemories: incoming.memories.length, incomingLegacy: incoming.legacyMemories.length, resultRecords: data.records.length, resultMemories: data.memories.length, conflictCount, profileKept, profileConflict, exportedAt: backup.exportedAt } };
}

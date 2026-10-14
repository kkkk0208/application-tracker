import { AI_PROFILE_MEMORY_STORAGE_KEY, AI_SETTINGS_STORAGE_KEY, PROFILE_STORAGE_KEY, QUESTION_MEMORY_STORAGE_KEY, STORAGE_KEY } from "./constants.js";
import { createRecord, updateRecord, normalizeImportedRecord } from "./model.js";
import { normalizeProfile } from "./profile.js";
import { normalizeAiSettings } from "./aiSettings.js";
import { normalizeProfileMemory } from "./aiProfileMemory.js";
import { buildQuestionMemoryEntry, mergeQuestionMemories } from "./questionMemory.js";
import { scopeFor, MEMORY_SCOPE_VERSION, versionOf } from "./assistant/planner.js";
import { createBackup, prepareRestore, validateRecords } from "./backup.js";
import { MEMORY_KEY, LEGACY_MEMORY_BACKUP_KEY, RECOVERY_KEY } from "./storageKeys.js";
export { MUTATION_MESSAGE } from "./storageClient.js";

const backupKeys = [STORAGE_KEY, PROFILE_STORAGE_KEY, MEMORY_KEY, QUESTION_MEMORY_STORAGE_KEY, LEGACY_MEMORY_BACKUP_KEY];
const list = (value) => Array.isArray(value) ? value : [];
const id = () => crypto.randomUUID();
const legacyEntries = (data) => list(data[QUESTION_MEMORY_STORAGE_KEY]).map((entry) => buildQuestionMemoryEntry(entry, entry.updatedAt || entry.createdAt || ""));
function migratedMemories(data) { return legacyEntries(data).map((entry) => ({ ...entry, id: entry.id || id(), confirmed: false, entityId: "self", scope: scopeFor(entry.pageUrl), origin: "legacy", history: [] })); }
function backupData(data) {
  return { records: list(data[STORAGE_KEY]), profile: data[PROFILE_STORAGE_KEY] || {}, memories: Array.isArray(data[MEMORY_KEY]) ? data[MEMORY_KEY] : migratedMemories(data), legacyMemories: legacyEntries(data), legacyMemoryBackup: list(data[LEGACY_MEMORY_BACKUP_KEY]) };
}
function storageData(data) { return { [STORAGE_KEY]: data.records, [PROFILE_STORAGE_KEY]: data.profile, [MEMORY_KEY]: data.memories, [QUESTION_MEMORY_STORAGE_KEY]: data.legacyMemories, [LEGACY_MEMORY_BACKUP_KEY]: data.legacyMemoryBackup }; }
function conflict(expected, actual) {
  if (expected && Object.entries(expected).some(([key, value]) => JSON.stringify(actual[key]) !== JSON.stringify(value))) throw new Error("这条内容已在另一页面修改，请重新打开并核对后保存");
}

// One queue is instantiated in the background worker; every context submits to it.
// The next mutation re-reads storage only after the preceding write has finished.
export function createMutationQueue(storage) {
  let queue = Promise.resolve();
  return (mutation) => {
    const task = queue.catch(() => {}).then(() => applyMutation(storage, mutation));
    queue = task;
    return task;
  };
}

async function applyMutation(storage, mutation) {
  if (!mutation || typeof mutation.operation !== "string") throw new Error("无效的数据操作");
  const { operation } = mutation;
  if (operation === "records.replace") {
    const data = await storage.get(backupKeys);
    if (Object.hasOwn(mutation, "expectedRecords") && JSON.stringify(list(data[STORAGE_KEY])) !== JSON.stringify(mutation.expectedRecords)) {
      throw new Error("导入准备后本地记录发生变化，请重新导入并核对");
    }
    if (!Array.isArray(mutation.records)) throw new Error("投递记录格式不正确");
    const records = validateRecords(mutation.records.map((entry) => normalizeImportedRecord(entry)));
    const recovery = createBackup(backupData(data));
    // The worker queue snapshots the latest full state and commits it with the
    // replacement. A quota error leaves records and the old recovery untouched.
    await storage.set({ [STORAGE_KEY]: records, [RECOVERY_KEY]: recovery });
    return;
  }
  if (operation.startsWith("record.")) {
    const data = await storage.get(STORAGE_KEY);
    let records = list(data[STORAGE_KEY]);
    let result;
    if (operation === "record.create") { result = createRecord(mutation.draft); records = [...records, result]; }
    else if (operation === "record.patch") {
      const index = records.findIndex((entry) => entry.id === mutation.id);
      if (index < 0) throw new Error("此投递记录已删除，请刷新列表");
      conflict(mutation.expected, records[index]);
      result = updateRecord(records[index], mutation.changes); records[index] = result;
    } else if (operation === "record.delete") records = records.filter((entry) => entry.id !== mutation.id);
    else throw new Error("未知的记录操作");
    await storage.set({ [STORAGE_KEY]: records }); return result;
  }
  if (operation.startsWith("memory.")) {
    const data = await storage.get([MEMORY_KEY, QUESTION_MEMORY_STORAGE_KEY, LEGACY_MEMORY_BACKUP_KEY]);
    const migrated = !Array.isArray(data[MEMORY_KEY]);
    let memories = migrated ? migratedMemories(data) : data[MEMORY_KEY];
    let result;
    if (operation === "memory.ensure") result = memories;
    else if (operation === "memory.save") {
      const draft = mutation.draft;
      const index = draft.id ? memories.findIndex((entry) => entry.id === draft.id) : -1;
      if (draft.id && index < 0) throw new Error("这条问答已删除，请刷新列表");
      const previous = memories[index];
      conflict(mutation.expected, previous || {});
      const now = new Date().toISOString();
      const scope = draft.scope === "global" ? "global" : scopeFor(draft.scope);
      result = { ...draft, scope, scopeVersion: MEMORY_SCOPE_VERSION, id: previous?.id || id(), updatedAt: now, confirmed: true, history: previous ? [...(previous.history || []), { answer: previous.answer, scope: previous.scope, updatedAt: previous.updatedAt || "" }].slice(-10) : [] };
      if (!result.question?.trim() || !result.answer?.trim() || !result.scope || !result.entityId?.trim() || !["zh", "en"].includes(result.language)) throw new Error("请完整填写问题、答案、语言、主体和适用范围");
      if (index < 0) memories.push(result); else memories[index] = result;
    } else if (operation === "memory.delete") memories = memories.filter((entry) => entry.id !== mutation.id);
    else throw new Error("未知的记忆操作");
    if (migrated || operation !== "memory.ensure") await storage.set({ [MEMORY_KEY]: memories, ...(migrated && !data[LEGACY_MEMORY_BACKUP_KEY] ? { [LEGACY_MEMORY_BACKUP_KEY]: legacyEntries(data) } : {}) });
    return result;
  }
  if (operation.startsWith("legacy.")) {
    const data = await storage.get(QUESTION_MEMORY_STORAGE_KEY);
    const existing = legacyEntries(data);
    let entries;
    if (operation === "legacy.learn") entries = mergeQuestionMemories(existing, mutation.entries);
    else if (operation === "legacy.replace") entries = mutation.memories.map((entry) => buildQuestionMemoryEntry(entry, entry.updatedAt));
    else if (operation === "legacy.delete") entries = existing.filter((entry) => entry.id !== mutation.id);
    else throw new Error("未知的历史记忆操作");
    await storage.set({ [QUESTION_MEMORY_STORAGE_KEY]: entries }); return entries;
  }
  const setters = { "profile.save": [PROFILE_STORAGE_KEY, normalizeProfile], "aiSettings.save": [AI_SETTINGS_STORAGE_KEY, normalizeAiSettings], "aiProfile.save": [AI_PROFILE_MEMORY_STORAGE_KEY, normalizeProfileMemory] };
  if (Object.hasOwn(setters, operation)) {
    const [key, normalize] = setters[operation];
    const value = normalize(mutation.value); await storage.set({ [key]: value }); return value;
  }
  if (operation.startsWith("backup.")) {
    const data = await storage.get([...backupKeys, RECOVERY_KEY]);
    const current = backupData(data);
    const currentVersion = versionOf(Object.fromEntries(backupKeys.map((key) => [key, data[key] ?? null])));
    if (operation === "backup.export") return createBackup(current);
    if (operation === "backup.recovery") return data[RECOVERY_KEY] || null;
    if (operation === "backup.preview") {
      const restored = prepareRestore(current, mutation.backup, mutation.mode);
      return { ...restored.summary, currentVersion };
    }
    if (operation === "backup.import") {
      if (mutation.currentVersion !== currentVersion) throw new Error("预览后本地数据发生变化，请重新预览再恢复");
      const restored = prepareRestore(current, mutation.backup, mutation.mode);
      const recovery = createBackup(current);
      // Recovery point and imported data are committed together. Failure leaves both unchanged.
      await storage.set({ ...storageData(restored.data), [RECOVERY_KEY]: recovery });
      return restored.summary;
    }
  }
  throw new Error("未知的数据操作");
}

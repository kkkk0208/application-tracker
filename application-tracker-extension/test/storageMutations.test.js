import test from "node:test";
import assert from "node:assert/strict";
import { createMutationQueue } from "../src/storageMutations.js";
import { createBackup } from "../src/backup.js";
import { createRecord } from "../src/model.js";
import { MEMORY_SCOPE_VERSION } from "../src/assistant/planner.js";
import { STORAGE_KEY, PROFILE_STORAGE_KEY, QUESTION_MEMORY_STORAGE_KEY, AI_SETTINGS_STORAGE_KEY } from "../src/constants.js";
import { MEMORY_KEY, LEGACY_MEMORY_BACKUP_KEY, RECOVERY_KEY } from "../src/storageKeys.js";

const now = "2026-09-20T12:00:00Z";
const draft = (index = 0) => ({ company: `示例公司 ${index}`, role: "分析师", source: "company_portal", portalLink: `https://example.com/apply?id=${index}`, appliedDate: "2026-09-20", status: "applied", notes: "原备注" });
const memoryDraft = (index = 0) => ({ question: `问题 ${index}`, answer: `答案 ${index}`, language: "zh", entityId: "self", scope: `https://example.com/apply?jobId=${index}&token=private` });
function storageFixture(initial = {}) {
  let data = structuredClone(initial);
  let failWrite = false;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 1));
  const storage = {
    async get(keys) { await pause(); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => Object.hasOwn(data, key)).map((key) => [key, structuredClone(data[key])])); },
    async set(values) { await pause(); if (failWrite) throw new Error("QUOTA_BYTES exceeded"); data = { ...data, ...structuredClone(values) }; }
  };
  return { mutate: createMutationQueue(storage), snapshot: () => structuredClone(data), failNextWrites: (value) => { failWrite = value; } };
}

test("concurrent record additions from separate contexts cannot lose records", async () => {
  const fixture = storageFixture();
  await Promise.all(Array.from({ length: 20 }, (_, index) => fixture.mutate({ operation: "record.create", draft: draft(index) })));
  const records = fixture.snapshot()[STORAGE_KEY];
  assert.equal(records.length, 20);
  assert.equal(new Set(records.map((record) => record.id)).size, 20);
});

test("status patches preserve the latest notes and concurrent independent edits", async () => {
  const record = createRecord(draft(), now);
  const fixture = storageFixture({ [STORAGE_KEY]: [record] });
  await Promise.all([
    fixture.mutate({ operation: "record.patch", id: record.id, changes: { notes: "新的备注" } }),
    fixture.mutate({ operation: "record.patch", id: record.id, changes: { status: "oa" } })
  ]);
  const changed = fixture.snapshot()[STORAGE_KEY][0];
  assert.equal(changed.notes, "新的备注"); assert.equal(changed.status, "oa");
  assert.equal(changed.statusHistory.length, 2);
});

test("stale edit conflicts are reported and do not poison the mutation queue", async () => {
  const record = createRecord(draft(), now);
  const fixture = storageFixture({ [STORAGE_KEY]: [record] });
  await fixture.mutate({ operation: "record.patch", id: record.id, changes: { notes: "已修改" } });
  await assert.rejects(fixture.mutate({ operation: "record.patch", id: record.id, changes: { notes: "旧窗口" }, expected: { notes: "原备注" } }), /另一页面/);
  await fixture.mutate({ operation: "record.patch", id: record.id, changes: { status: "offer" } });
  assert.equal(fixture.snapshot()[STORAGE_KEY][0].notes, "已修改");
  assert.equal(fixture.snapshot()[STORAGE_KEY][0].status, "offer");
});

test("concurrent legacy migration and memory saves keep all answers and mark only confirmed scopes current", async () => {
  const fixture = storageFixture({ [QUESTION_MEMORY_STORAGE_KEY]: [{ id: "legacy", question: "原问题", answer: "原答案", language: "zh", pageUrl: "https://example.com/apply?jobId=1", updatedAt: now }] });
  await Promise.all([
    fixture.mutate({ operation: "memory.ensure" }),
    ...Array.from({ length: 10 }, (_, index) => fixture.mutate({ operation: "memory.save", draft: memoryDraft(index) }))
  ]);
  const data = fixture.snapshot();
  assert.equal(data[MEMORY_KEY].length, 11);
  assert.equal(data[MEMORY_KEY][0].confirmed, false);
  assert.equal(data[MEMORY_KEY][0].scopeVersion, undefined);
  assert.equal(data[LEGACY_MEMORY_BACKUP_KEY].length, 1);
  for (const memory of data[MEMORY_KEY].slice(1)) { assert.equal(memory.scopeVersion, MEMORY_SCOPE_VERSION); assert.match(memory.scope, /jobId=/); assert.equal(memory.scope.includes("private"), false); }
});

test("memory edits detect conflicts and cannot resurrect a deleted answer", async () => {
  const fixture = storageFixture();
  const memory = await fixture.mutate({ operation: "memory.save", draft: memoryDraft() });
  await fixture.mutate({ operation: "memory.save", draft: { ...memory, answer: "最新" } });
  await assert.rejects(fixture.mutate({ operation: "memory.save", draft: { ...memory, answer: "旧窗口" }, expected: { answer: memory.answer } }), /另一页面/);
  await fixture.mutate({ operation: "memory.delete", id: memory.id });
  await assert.rejects(fixture.mutate({ operation: "memory.save", draft: memory }), /已删除/);
  assert.deepEqual(fixture.snapshot()[MEMORY_KEY], []);
});

test("full restore creates an import recovery point atomically and never changes AI settings", async () => {
  const record = createRecord(draft(), now);
  const fixture = storageFixture({ [STORAGE_KEY]: [record], [PROFILE_STORAGE_KEY]: { fullNameZh: "当前资料" }, [MEMORY_KEY]: [], [AI_SETTINGS_STORAGE_KEY]: { enabled: true, apiKey: "PRIVATE_KEY" } });
  const backup = createBackup({ records: [], profile: { fullNameZh: "备份资料" }, memories: [], legacyMemories: [], legacyMemoryBackup: [] }, now);
  const preview = await fixture.mutate({ operation: "backup.preview", backup, mode: "replace" });
  await fixture.mutate({ operation: "backup.import", backup, mode: "replace", currentVersion: preview.currentVersion });
  const after = fixture.snapshot();
  assert.equal(after[PROFILE_STORAGE_KEY].fullNameZh, "备份资料");
  assert.deepEqual(after[STORAGE_KEY], []);
  assert.equal(after[AI_SETTINGS_STORAGE_KEY].apiKey, "PRIVATE_KEY");
  assert.equal(JSON.stringify(after[RECOVERY_KEY]).includes("PRIVATE_KEY"), false);
  assert.equal(after[RECOVERY_KEY].data.records[0].id, record.id);
  const recovery = await fixture.mutate({ operation: "backup.recovery" });
  const recoveryPreview = await fixture.mutate({ operation: "backup.preview", backup: recovery, mode: "replace" });
  await fixture.mutate({ operation: "backup.import", backup: recovery, mode: "replace", currentVersion: recoveryPreview.currentVersion });
  assert.equal(fixture.snapshot()[PROFILE_STORAGE_KEY].fullNameZh, "当前资料");
  assert.equal(fixture.snapshot()[STORAGE_KEY][0].id, record.id);
});

test("restore rejects a stale preview if another page writes before confirmation", async () => {
  const fixture = storageFixture();
  const backup = createBackup({ records: [], profile: {}, memories: [], legacyMemories: [], legacyMemoryBackup: [] }, now);
  const preview = await fixture.mutate({ operation: "backup.preview", backup, mode: "replace" });
  await fixture.mutate({ operation: "record.create", draft: draft() });
  await assert.rejects(fixture.mutate({ operation: "backup.import", backup, mode: "replace", currentVersion: preview.currentVersion }), /重新预览/);
  assert.equal(fixture.snapshot()[STORAGE_KEY].length, 1);
  assert.equal(fixture.snapshot()[RECOVERY_KEY], undefined);
});

test("storage quota failure leaves current data and previous recovery point intact", async () => {
  const fixture = storageFixture({ [PROFILE_STORAGE_KEY]: { fullNameZh: "当前资料" } });
  const backup = createBackup({ records: [], profile: { fullNameZh: "备份资料" }, memories: [], legacyMemories: [], legacyMemoryBackup: [] }, now);
  const preview = await fixture.mutate({ operation: "backup.preview", backup, mode: "replace" });
  const before = fixture.snapshot(); fixture.failNextWrites(true);
  await assert.rejects(fixture.mutate({ operation: "backup.import", backup, mode: "replace", currentVersion: preview.currentVersion }), /QUOTA/);
  assert.deepEqual(fixture.snapshot(), before);
});

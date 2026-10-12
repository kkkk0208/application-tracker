import test from "node:test";
import assert from "node:assert/strict";
import { createBackup, validateBackup, prepareRestore } from "../src/backup.js";
import { createRecord } from "../src/model.js";

const now = "2026-09-20T12:00:00Z";
const record = (id, notes = "") => ({ ...createRecord({ company: "示例公司", role: "分析师", source: "company_portal", portalLink: `https://example.com/apply?id=${id}`, appliedDate: "2026-09-20", status: "applied", notes }, now), id });
const memory = (id, answer = "示例答案") => ({ id, question: "其他技能", answer, language: "zh", entityId: "self", scope: "https://example.com/apply?id=1", scopeVersion: 2, confirmed: true, origin: "user_confirmed", updatedAt: now, history: [] });
const state = (overrides = {}) => ({ records: [], profile: {}, memories: [], legacyMemories: [], legacyMemoryBackup: [], ...overrides });

test("full backup round-trips records, profile, scopes and both legacy stores without credentials", () => {
  const original = state({ records: [record("one")], profile: { fullNameZh: "测试用户", internships: [{ companyZh: "示例公司" }], apiKey: "SECRET" }, memories: [memory("m1")], legacyMemories: [memory("old")], legacyMemoryBackup: [memory("original")], apiKey: "SECRET", settings: { apiKey: "SECRET" } });
  const backup = createBackup(original, now);
  assert.equal(JSON.stringify(backup).includes("SECRET"), false);
  const checked = validateBackup(JSON.parse(JSON.stringify(backup)));
  assert.deepEqual(checked.data.records, original.records);
  assert.equal(checked.data.profile.fullNameZh, "测试用户");
  assert.equal(checked.data.memories[0].scope, "https://example.com/apply?id=1");
  assert.equal(checked.data.memories[0].scopeVersion, 2);
  assert.equal(checked.data.legacyMemoryBackup[0].id, "original");
});

test("validation rejects unexpected settings, incompatible versions and broken records before restore", () => {
  const good = createBackup(state({ records: [record("one")] }), now);
  assert.throws(() => validateBackup({ ...good, settings: { apiKey: "SECRET" } }), /未知字段/);
  assert.throws(() => validateBackup({ ...good, schemaVersion: 999 }), /版本/);
  assert.throws(() => validateBackup({ ...good, data: { ...good.data, profile: { apiKey: "SECRET" } } }), /未知字段/);
  assert.throws(() => validateBackup({ ...good, data: { ...good.data, records: [{ ...good.data.records[0], appliedDate: "2026-02-30" }] } }), /日期/);
  assert.throws(() => validateBackup({ ...good, data: { ...good.data, records: [...good.data.records, ...good.data.records] } }), /重复 ID/);
  assert.throws(() => validateBackup({ ...good, data: { ...good.data, records: [{ ...good.data.records[0], portalLink: "javascript:alert(1)" }] } }), /http/);
});

test("malformed or incomplete confirmed memories cannot be imported", () => {
  const good = createBackup(state(), now);
  assert.throws(() => validateBackup({ ...good, data: { ...good.data, memories: [{ ...memory("m"), entityId: "" }] } }), /主体/);
  assert.throws(() => validateBackup({ ...good, data: { ...good.data, memories: [{ ...memory("m"), language: "other" }] } }), /语言/);
  assert.throws(() => validateBackup({ ...good, data: { ...good.data, profile: { internships: "unexpected" } } }), /实习经历/);
});

test("merge keeps current IDs and profile and leaves imported memories unconfirmed when profiles differ", () => {
  const current = state({ records: [record("one", "最新备注")], profile: { fullNameZh: "当前资料" }, memories: [memory("m1", "最新答案")] });
  const incoming = createBackup(state({ records: [record("one", "旧备注"), record("two")], profile: { fullNameZh: "备份资料" }, memories: [memory("m1", "旧答案"), memory("m2")] }), now);
  const restored = prepareRestore(current, incoming, "merge");
  assert.equal(restored.data.records.length, 2);
  assert.equal(restored.data.records[0].notes, "最新备注");
  assert.equal(restored.data.profile.fullNameZh, "当前资料");
  assert.equal(restored.data.memories[0].answer, "最新答案");
  assert.equal(restored.data.memories[1].confirmed, false);
  assert.equal(restored.summary.conflictCount, 2);
  assert.equal(restored.summary.profileConflict, true);
});

test("replace restores all data while a version-2 partial backup preserves current records", () => {
  const current = state({ records: [record("current")], profile: { fullNameZh: "当前资料" }, legacyMemoryBackup: [memory("historical")] });
  const incoming = createBackup(state({ records: [record("backup")], profile: { fullNameZh: "备份资料" }, memories: [memory("m1")] }), now);
  const full = prepareRestore(current, incoming, "replace");
  assert.deepEqual(full.data, incoming.data);
  const old = { schemaVersion: 2, exportedAt: now, profile: { fullNameZh: "旧版资料" }, memories: [memory("old")], legacyMemories: [] };
  const partial = prepareRestore(current, old, "replace");
  assert.equal(partial.summary.partial, true);
  assert.equal(partial.data.records[0].id, "current");
  assert.equal(partial.data.profile.fullNameZh, "旧版资料");
  assert.equal(partial.data.legacyMemoryBackup[0].id, "historical");
});

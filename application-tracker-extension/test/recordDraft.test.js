import test from "node:test";
import assert from "node:assert/strict";
import { toDateInputValue } from "../src/dateUtils.js";
import { extractJobInfo } from "../src/jobInfo/extractJobInfo.js";
import { buildRecordDraft, recentJobChoices, recordStatus } from "../src/assistant/recordDraft.js";

function completeDraft(overrides = {}) {
  return {
    ...buildRecordDraft({ url: "https://careers.example/jobs/1?application=xyz", title: "分析师申请", today: "2026-10-13",
      jobInfo: extractJobInfo({ jobPostings: [{ company: "示例公司", title: "分析师", base: "香港" }] }) }),
    ...overrides
  };
}

test("structured job information makes a current-page draft with per-field origins and empty optional fields", () => {
  assert.deepEqual(completeDraft(), {
    company: "示例公司", role: "分析师", base: "香港", portalLink: "https://careers.example/jobs/1?application=xyz",
    pageTitle: "分析师申请", source: "company_portal", appliedDate: "2026-10-13", status: "applied",
    nextActionDate: "", jdText: "", notes: "", origin: { company: "结构化数据", role: "结构化数据" }
  });
});

test("draft source follows the current page and defaults to today's local date and applied status", () => {
  const draft = buildRecordDraft({ url: "https://hk.jobsdb.com/job/123", title: "岗位详情" });
  assert.equal(draft.source, "jobsdb");
  assert.equal(draft.appliedDate, toDateInputValue());
  assert.equal(draft.status, "applied");
});

test("recent choices are explicit, same-host first, newest first and limited to five roles", () => {
  const recentJobs = [
    { company: "别页公司", role: "别页岗位", host: "other.example", capturedAt: 900 },
    { company: "本页公司", role: "分析师", host: "careers.example", capturedAt: 100 },
    { company: "新公司", role: "助理", url: "https://careers.example/jobs/2", capturedAt: 200 },
    { company: "无岗位", role: "", host: "careers.example", capturedAt: 1000 },
    ...Array.from({ length: 5 }, (_, index) => ({ company: `其他 ${index}`, role: `岗位 ${index}`, host: "other.example", capturedAt: index }))
  ];
  const original = structuredClone(recentJobs);
  const draft = buildRecordDraft({ url: "https://careers.example/apply", title: "填写简历", jobInfo: {}, recentJobs });
  assert.equal(draft.role, "");
  assert.equal(draft.company, "");
  assert.deepEqual(draft.origin, { company: "", role: "" });
  const choices = recentJobChoices(recentJobs, "careers.example");
  assert.equal(choices.length, 5);
  assert.deepEqual(choices.slice(0, 3).map((job) => job.company), ["新公司", "本页公司", "别页公司"]);
  assert.deepEqual(recentJobs, original);
});

test("draft validation requires the company and role and rejects an unsafe reference", () => {
  assert.deepEqual(recordStatus(completeDraft(), []).errors, {});
  const status = recordStatus(completeDraft({ company: " ", role: "", portalLink: "javascript:alert(1)" }), []);
  assert.equal(status.errors.company, "请填写公司");
  assert.equal(status.errors.role, "请填写岗位");
  assert.match(status.errors.portalLink, /http/);
  assert.equal(status.duplicate, null);
});

test("draft duplicate detection checks page link and company plus role", () => {
  const existing = { ...completeDraft(), id: "saved-record", status: "interview" };
  const byLink = recordStatus(completeDraft({ company: "另一公司", role: "另一岗位" }), [existing]);
  assert.equal(byLink.duplicate.reason, "portalLink");
  assert.equal(byLink.duplicate.record, existing);
  const byNames = recordStatus(completeDraft({ portalLink: "https://other.example/apply", company: " 示例公司 ", role: "分析师 " }), [existing]);
  assert.equal(byNames.duplicate.reason, "companyRole");
  assert.equal(recordStatus(completeDraft({ portalLink: "https://other.example/apply", role: "不同岗位" }), [existing]).duplicate, null);
});

test("draft text is trimmed and AI extraction origins stay visible for review", () => {
  const draft = buildRecordDraft({ url: " https://careers.example/apply ", title: " 申请 ", today: "2026-10-13",
    jobInfo: { company: " 示例公司 ", role: " 分析师 ", base: " 香港 ", source: { company: "AI 识别，请核对", role: "AI 识别，请核对" } } });
  assert.deepEqual([draft.company, draft.role, draft.base, draft.pageTitle], ["示例公司", "分析师", "香港", "申请"]);
  assert.deepEqual(draft.origin, { company: "AI 识别，请核对", role: "AI 识别，请核对" });
  assert.deepEqual(recentJobChoices(undefined, "careers.example"), []);
});

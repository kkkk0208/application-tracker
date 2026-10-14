import test from "node:test";
import assert from "node:assert/strict";
import { RECENT_JOBS_KEY, rememberJob, loadRecentJobs } from "../src/jobInfo/recentJobs.js";

function sessionStorage(initial = {}) {
  const values = structuredClone(initial), writes = [];
  return {
    values, writes,
    async get(key) { return { [key]: structuredClone(values[key]) }; },
    async set(update) { writes.push(structuredClone(update)); Object.assign(values, structuredClone(update)); }
  };
}

const jobInfo = (company = "示例公司", role = "分析师") => ({
  company, role, base: "香港", confidence: { company: "high", role: "medium", base: "high" },
  source: { company: "结构化数据", role: "网页标题", base: "页面标签" }
});

test("recent jobs remember trusted fields only and use only the provided session storage", async () => {
  const storage = sessionStorage();
  const info = jobInfo();
  info.confidence.company = "low";
  info.confidence.base = "low";
  await rememberJob(storage, "https://careers.example/jobs/1", info);
  const [job] = await loadRecentJobs(storage);
  assert.deepEqual([job.company, job.role, job.base], ["", "分析师", ""]);
  assert.equal(job.host, "careers.example");
  assert.equal(typeof job.capturedAt, "number");
  assert.deepEqual(job.source, info.source);
  assert.deepEqual(Object.keys(storage.values), [RECENT_JOBS_KEY]);
  assert.equal(storage.writes.length, 1);
});

test("low confidence, location-only, absent info and unsafe URLs do not enter recent jobs", async () => {
  const storage = sessionStorage();
  const low = jobInfo();
  low.confidence = { company: "low", role: "low", base: "high" };
  await rememberJob(storage, "https://careers.example/jobs/1", low);
  await rememberJob(storage, "https://careers.example/jobs/1", jobInfo("", ""));
  await rememberJob(storage, "https://careers.example/jobs/1", null);
  for (const url of ["", "not a URL", "javascript:alert(1)", "file:///C:/private.txt"]) {
    await rememberJob(storage, url, jobInfo());
  }
  assert.deepEqual(await loadRecentJobs(storage), []);
  assert.equal(storage.writes.length, 0);
});

test("recent jobs strip private URL parts and retain different roles at a shared address", async () => {
  const storage = sessionStorage();
  await rememberJob(storage, "https://person:private@careers.example/jobs/1?token=secret#apply", jobInfo());
  await rememberJob(storage, "https://careers.example/jobs/2?tracking=1", jobInfo("另一公司", "助理"));
  await rememberJob(storage, "https://careers.example/jobs/1?token=other", jobInfo("新公司", "新岗位"));
  const jobs = await loadRecentJobs(storage);
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].url, "https://careers.example/jobs/1");
  assert.equal(jobs[0].company, "新公司");
  assert.equal(jobs[1].url, "https://careers.example/jobs/2");
  assert.equal(jobs[2].role, "分析师");
  assert.doesNotMatch(JSON.stringify(storage.values), /token|private|person|secret|tracking/);
});

test("recent jobs keep SPA job routes and business IDs without login tokens", async () => {
  const storage = sessionStorage();
  await rememberJob(storage, "https://careers.example/apply?jobId=1&token=secret#/job/1?ticket=secret", jobInfo("公司", "同名岗位"));
  await rememberJob(storage, "https://careers.example/apply?jobId=2&token=secret#/job/2", jobInfo("公司", "同名岗位"));
  const jobs = await loadRecentJobs(storage);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].url, "https://careers.example/apply?jobId=2#/job/2");
  assert.equal(jobs[1].url, "https://careers.example/apply?jobId=1#/job/1");
  assert.doesNotMatch(JSON.stringify(jobs), /secret|ticket|token/);
});

test("recent jobs retain the latest twenty URL identities", async () => {
  const storage = sessionStorage();
  for (let index = 0; index < 25; index++) {
    await rememberJob(storage, `https://careers.example/jobs/${index}`, jobInfo("示例公司", `岗位 ${index}`));
  }
  const jobs = await loadRecentJobs(storage);
  assert.equal(jobs.length, 20);
  assert.equal(jobs[0].role, "岗位 24");
  assert.equal(jobs.at(-1).role, "岗位 5");
});

test("recent jobs load absent or malformed lists as empty and do not write while reading", async () => {
  for (const initial of [{}, { [RECENT_JOBS_KEY]: {} }, { [RECENT_JOBS_KEY]: "invalid" }]) {
    const storage = sessionStorage(initial);
    assert.deepEqual(await loadRecentJobs(storage), []);
    assert.equal(storage.writes.length, 0);
  }
});

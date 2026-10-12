import test from "node:test";
import assert from "node:assert/strict";
import { detectSourceFromUrl, isMokaUrl } from "../src/sourceDetection.js";

test("detectSourceFromUrl maps LinkedIn URLs", () => {
  assert.equal(detectSourceFromUrl("https://www.linkedin.com/jobs/view/123"), "linkedin");
});

test("detectSourceFromUrl maps JobsDB URLs", () => {
  assert.equal(detectSourceFromUrl("https://hk.jobsdb.com/job/123"), "jobsdb");
});

test("detectSourceFromUrl maps CTgoodjobs URLs", () => {
  assert.equal(detectSourceFromUrl("https://www.ctgoodjobs.hk/job/123"), "ctgoodjobs");
  assert.equal(detectSourceFromUrl("https://ctgoodjobs.hk/job/123"), "ctgoodjobs");
});

test("detectSourceFromUrl maps BOSS URLs", () => {
  assert.equal(detectSourceFromUrl("https://www.zhipin.com/job_detail/123"), "boss");
  assert.equal(detectSourceFromUrl("https://www.bosszhipin.com/job_detail/123"), "boss");
});

test("detectSourceFromUrl defaults unknown or invalid URLs to company portal", () => {
  assert.equal(detectSourceFromUrl("https://careers.example.com/job/123"), "company_portal");
  assert.equal(detectSourceFromUrl("not a url"), "company_portal");
  assert.equal(detectSourceFromUrl(""), "company_portal");
});

test("isMokaUrl recognizes Moka domains and the supported custom domain", () => {
  assert.equal(isMokaUrl("https://jobs.mokahr.com/apply/example/123"), true);
  assert.equal(isMokaUrl("https://job.swsmu.com/campus_apply/example/123"), true);
  assert.equal(isMokaUrl("https://careers.example.com/job/123"), false);
  assert.equal(isMokaUrl("not a url"), false);
});

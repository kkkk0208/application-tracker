import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { collectJobSignals } from "../src/jobInfo/collectSignals.js";
import { extractJobInfo, sortRecentJobs, sanitizeJobUrl } from "../src/jobInfo/extractJobInfo.js";

function collectJsonLd(values, extra = {}) {
  const scripts = values.map((value) => ({ textContent: typeof value === "string" ? value : JSON.stringify(value) }));
  const document = { title: "", querySelector: () => null, querySelectorAll: (selector) => selector === "script[type='application/ld+json']" ? scripts : [] };
  // Recreate the function from its source, as chrome.scripting.executeScript does.
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${collectJobSignals.toString()})()`, {
    document: Object.assign(document, extra), location: { hostname: "careers.example.com", pathname: "/jobs/123" }
  })));
}

test("collectJobSignals reads object, array, @graph and nested JobPosting JSON-LD", () => {
  const posting = { "@type": "JobPosting", title: "财务实习生", hiringOrganization: { name: "某某集团" }, jobLocation: { address: { addressLocality: "深圳" } } };
  for (const data of [posting, [posting], { "@graph": [{ "@type": "Organization" }, posting] }, { mainEntity: posting }]) {
    const signals = collectJsonLd([data]);
    assert.deepEqual(signals.jobPostings, [{ title: "财务实习生", company: "某某集团", base: "深圳" }]);
    assert.equal(signals.hostname, "careers.example.com");
    assert.equal(signals.pathname, "/jobs/123");
    assert.equal(extractJobInfo(signals).source.role, "结构化数据");
  }
});

test("JSON-LD skips malformed scripts and combines location arrays without duplicate regions", () => {
  const signals = collectJsonLd(["{broken", { "@type": ["Thing", "JobPosting"], title: "Graduate Analyst", hiringOrganization: { name: "Some Bank" }, jobLocation: [
    { address: { addressRegion: "广东省", addressLocality: "深圳" } }, { address: { addressRegion: "香港", addressLocality: "香港" } }
  ] }]);
  assert.deepEqual(signals.jobPostings, [{ title: "Graduate Analyst", company: "Some Bank", base: "广东省 深圳 / 香港" }]);
});

test("extractJobInfo follows each field's structured, label, site, title and text priority", () => {
  const result = extractJobInfo({
    jobPostings: [{ company: "某某集团" }], labels: { company: ["另一集团"], role: ["财务实习生"] },
    siteCandidates: { role: ["审计助理"], base: ["深圳"] }, meta: { "og:site_name": "某某科技" },
    classCandidates: { company: ["页面集团"], role: ["管培生"], base: ["北京"] }
  });
  assert.deepEqual(result, { company: "某某集团", role: "财务实习生", base: "深圳", source: { company: "结构化数据", role: "页面标签", base: "页面标签" }, confidence: { company: "high", role: "high", base: "high" } });
});

test("extractJobInfo reads meta names and page headings", () => {
  const result = extractJobInfo({ meta: { "og:site_name": "Example Partners", "og:title": "Graduate Analyst" }, headings: ["财务实习生"] });
  assert.equal(result.company, "Example Partners");
  assert.equal(result.role, "财务实习生");
  assert.equal(result.confidence.company, "medium");
  assert.equal(result.source.role, "网页标题");
});

test("extractJobInfo handles the agreed Chinese and English title examples", () => {
  for (const [documentTitle, company, role, base] of [
    ["财务实习生-某某集团-招聘官网", "某某集团", "财务实习生", ""],
    ["【审计助理_深圳】某某会计师事务所招聘", "某某会计师事务所", "审计助理", "深圳"],
    ["Graduate Analyst | Some Bank Careers", "Some Bank", "Graduate Analyst", ""],
    ["「Graduate Analyst」Some Bank / Hong Kong / LinkedIn", "Some Bank", "Graduate Analyst", "Hong Kong"],
    ["华润集团招聘官网", "华润集团", "", ""],
    ["某某集团校园招聘", "某某集团", "", ""],
    ["审计助理招聘 · 某某事务所", "某某事务所", "审计助理", ""]
  ]) {
    const result = extractJobInfo({ documentTitle });
    assert.deepEqual([result.company, result.role, result.base], [company, role, base], documentTitle);
  }
});

test("platform and application page names cannot become a company or role", () => {
  for (const name of ["智联招聘", "智联", "BOSS直聘", "前程无忧", "51job", "猎聘", "猎聘网", "拉勾", "拉勾招聘", "实习僧", "牛客", "牛客网", "应届生求职网", "脉脉", "LinkedIn", "领英", "JobsDB", "CTgoodjobs", "Indeed", "Moka", "填写简历", "简历填写", "我的简历", "职位详情", "岗位详情", "申请职位", "投递简历", "个人中心", "首页", "登录", "注册", "校园招聘", "Careers", "Jobs"]) {
    const result = extractJobInfo({ documentTitle: name, meta: { "og:site_name": name }, headings: [name], labels: { company: [name], role: [name] }, classCandidates: { company: [name], role: [name] } });
    assert.equal(result.company, "", name);
    assert.equal(result.role, "", name);
  }
});

test("known-site candidates preserve CTgoodjobs, JobsDB and Moka extraction", () => {
  for (const hostname of ["www.ctgoodjobs.hk", "hk.jobsdb.com", "jobs.mokahr.com", "job.swsmu.com"]) {
    const result = extractJobInfo({ hostname, siteCandidates: { company: ["Example Capital Limited"], role: ["Graduate Analyst"], base: ["Hong Kong"] } });
    assert.deepEqual([result.company, result.role, result.base], ["Example Capital Limited", "Graduate Analyst", "Hong Kong"]);
    assert.equal(result.source.role, "页面标签");
  }
  const result = extractJobInfo({ documentTitle: "某某公司 - 校园招聘", siteCandidates: { company: ["某某公司"], role: ["2027届-财务专员（上海）", "校园"] } });
  assert.equal(result.role, "2027届-财务专员（上海）");
  assert.equal(extractJobInfo({ documentTitle: "某某基金管理有限公司-招聘", siteCandidates: { role: ["职位申请", "量化研究员"] } }).role, "量化研究员");
});

test("class guesses and logo alt are low confidence and empty locations stay empty", () => {
  const result = extractJobInfo({ classCandidates: { role: ["量化研究员"], base: ["-", "工作地点"] }, logoAlts: ["某某集团"] });
  assert.equal(result.company, "某某集团");
  assert.equal(result.role, "量化研究员");
  assert.equal(result.confidence.company, "low");
  assert.equal(result.source.role, "页面文字");
  assert.equal(result.base, "");
});

test("recent jobs prioritize the exact host then newest capture, without mutating inputs or assigning another job", () => {
  const jobs = [
    { company: "甲公司", role: "分析师", host: "other.example", capturedAt: 500 },
    { company: "乙公司", role: "专员", host: "careers.example", capturedAt: 100 },
    { company: "丙公司", role: "管培生", url: "https://careers.example/jobs/3", capturedAt: 200 }
  ];
  assert.deepEqual(sortRecentJobs(jobs, "careers.example").map((job) => job.company), ["丙公司", "乙公司", "甲公司"]);
  assert.equal(jobs[0].company, "甲公司");
  assert.equal(extractJobInfo({ documentTitle: "填写简历", hostname: "careers.example" }, { recentJobs: jobs }).role, "");
});

test("job URL identity strips query, hash and credentials and rejects invalid URLs", () => {
  assert.equal(sanitizeJobUrl("https://careers.example/jobs/1?token=private#application"), "https://careers.example/jobs/1");
  assert.equal(sanitizeJobUrl("https://user:secret@careers.example/jobs/2"), "https://careers.example/jobs/2");
  assert.equal(sanitizeJobUrl("not a URL"), "");
  assert.equal(sanitizeJobUrl("javascript:alert(1)"), "");
});

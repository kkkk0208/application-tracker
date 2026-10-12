// Job identification acceptance tests. Every response is a sanitized local
// fixture or fictional HTML; no request reaches a real recruitment website.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { collectJobSignals } from "../src/jobInfo/collectSignals.js";
import { extractJobInfo } from "../src/jobInfo/extractJobInfo.js";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const root = path.resolve(import.meta.dirname, "..");
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) });
let passed = 0;

try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const responses = new Map();
  await context.route("**/*", (route) => {
    const body = responses.get(route.request().url());
    return body !== undefined
      ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body })
      : route.abort();
  });
  const page = await context.newPage();
  async function fixture(html, url = "https://careers.example.test/job/fixture") {
    const requestUrl = new URL(url);
    requestUrl.hash = "";
    responses.set(requestUrl.href, html);
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }
  // Passing the function itself deliberately exercises Chrome-style function
  // serialization: any references to module-local helpers fail in the page.
  const collect = () => page.evaluate(collectJobSignals);
  async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
  const fields = ({ company, role, base }) => ({ company, role, base });
  const documentHtml = (body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title>${head}</head><body>${body}</body></html>`;
  const posting = { "@type": "JobPosting", title: "财务实习生", hiringOrganization: { name: "示例科技有限公司" }, jobLocation: { address: { addressLocality: "深圳" } } };
  const jsonLd = (value) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

  for (const { file, url, company } of [
    { file: "huarun-runjob.html", url: "https://runjob.crc.com.cn/application/fixture", company: "华润集团" },
    { file: "chinahr-applyjob.html", url: "https://applyjob.chinahr.com/application/fixture" },
    { file: "wintalent-crc.html", url: "https://crc.wintalent.cn/application/fixture" }
  ]) {
    await check(`job identification on sanitized ${file}`, async () => {
      await fixture(await readFile(path.join(root, "test/fixtures/real-pages", file), "utf8"), url);
      const info = extractJobInfo(await collect());
      if (company) assert.equal(info.company, company);
      assert.equal(info.role, "", "Application form names must never be identified as job roles");
      assert.ok(!["填写简历", "简历填写"].includes(info.company));
    });
  }

  for (const [name, data] of [
    ["single object", posting],
    ["top-level array", [{ "@type": "WebSite", name: "Example" }, posting]],
    ["nested @graph", { "@context": "https://schema.org", "@graph": [{ "@type": "Organization" }, { "@graph": [posting] }] }]
  ]) {
    await check(`serialized collector reads JSON-LD ${name}`, async () => {
      await fixture(documentHtml("<h1>页面上的另一个职位</h1>", '<script type="application/ld+json">{invalid</script>' + jsonLd(data)));
      const info = extractJobInfo(await collect());
      assert.deepEqual(fields(info), { company: "示例科技有限公司", role: "财务实习生", base: "深圳" });
      assert.deepEqual(info.source, { company: "结构化数据", role: "结构化数据", base: "结构化数据" });
      assert.deepEqual(info.confidence, { company: "high", role: "high", base: "high" });
    });
  }

  await check("JSON-LD handles type and jobLocation arrays", async () => {
    await fixture(documentHtml("", jsonLd({ ...posting, "@type": ["Thing", "JobPosting"], jobLocation: [
      { address: { addressRegion: "广东", addressLocality: "深圳" } },
      { address: { addressRegion: "香港", addressLocality: "香港" } }
    ] })));
    const info = extractJobInfo(await collect());
    assert.deepEqual(fields(info), { company: "示例科技有限公司", role: "财务实习生", base: "广东 深圳 / 香港" });
  });

  await check("explicit labels beat meta and nearby text is collected", async () => {
    await fixture(documentHtml('<div>公司名称：星海科技有限公司</div><dl><dt>岗位名称</dt><dd>审计助理</dd></dl><div><span>工作地点</span></div><p>深圳</p>', '<meta property="og:title" content="Graduate Analyst | Other Bank Careers"><meta property="og:site_name" content="Other Bank">'));
    const info = extractJobInfo(await collect());
    assert.deepEqual(fields(info), { company: "星海科技有限公司", role: "审计助理", base: "深圳" });
    assert.deepEqual(info.source, { company: "页面标签", role: "页面标签", base: "页面标签" });
  });

  await check("visible headings and metadata identify a generic job page", async () => {
    await fixture(documentHtml('<h1>Graduate Analyst</h1><h2 hidden>PRIVATE_HIDDEN_HEADING</h2><div style="display:none"><h1>PRIVATE_HIDDEN_PARENT</h1></div>', '<meta property="og:site_name" content="Fictional Bank"><meta name="twitter:title" content="Graduate Analyst | Fictional Bank Careers">'));
    const signals = await collect();
    const info = extractJobInfo(signals);
    assert.deepEqual(fields(info), { company: "Fictional Bank", role: "Graduate Analyst", base: "" });
    assert.equal(info.confidence.company, "medium");
    assert.equal(info.confidence.role, "medium");
    assert.equal(JSON.stringify(signals).includes("PRIVATE_HIDDEN"), false);
  });

  await check("collection never reads input values or includes form and editable answers", async () => {
    await fixture(documentHtml(`
      <h1>Graduate Analyst</h1><div class="company-name">Fictional Bank</div>
      <input id="outside-input" value="PRIVATE_INPUT_VALUE">
      <textarea class="job-title">PRIVATE_TEXTAREA_ANSWER</textarea>
      <div contenteditable="true" class="company-name">PRIVATE_EDITABLE_ANSWER<h2>PRIVATE_EDITABLE_HEADING</h2></div>
      <div role="textbox"><h2>PRIVATE_TEXTBOX_HEADING</h2></div>
      <div class="logo" contenteditable="true"><img alt="PRIVATE_EDITABLE_LOGO" width="100" height="20"></div>
      <form><h2>PRIVATE_FORM_HEADING</h2><div>公司名称：PRIVATE_FORM_COMPANY</div><div class="job-title">PRIVATE_FORM_ROLE</div><p>PRIVATE_SAVED_ANSWER</p><label>姓名<input value="PRIVATE_FORM_INPUT"></label></form>
      <div role="form"><div class="company-name">PRIVATE_ROLE_FORM_COMPANY</div></div>
      <div class="ant-form-item"><div class="company-name">PRIVATE_COMPONENT_COMPANY</div><input></div>
      <div class="job-title">PRIVATE_CONTAINER_TEXT<input value="PRIVATE_CONTAINER_INPUT"></div>
    `), "https://careers.example.test/job/privacy?answer=PRIVATE_QUERY_VALUE#PRIVATE_HASH_VALUE");
    await page.evaluate(() => {
      for (const element of document.querySelectorAll("input,textarea")) {
        Object.defineProperty(element, "value", { get() { throw new Error("Job collection read a private input value"); } });
      }
    });
    const signals = await collect();
    assert.equal(JSON.stringify(signals).includes("PRIVATE_"), false, "Job signals must exclude personal answers and URL query/hash data");
    assert.equal(signals.hostname, "careers.example.test");
    assert.equal(signals.pathname, "/job/privacy");
    assert.deepEqual(fields(extractJobInfo(signals)), { company: "Fictional Bank", role: "Graduate Analyst", base: "" });
  });

  await check("CTgoodjobs keeps its role, company and location adapter", async () => {
    await fixture(documentHtml('<h1>Finance Intern</h1><div class="company"><a>Fictional Capital Limited</a></div><div class="job-location">Hong Kong</div>'), "https://www.ctgoodjobs.hk/job/fictional-role");
    const info = extractJobInfo(await collect());
    assert.deepEqual(fields(info), { company: "Fictional Capital Limited", role: "Finance Intern", base: "Hong Kong" });
    assert.deepEqual(info.confidence, { company: "high", role: "high", base: "high" });
  });

  await check("CTgoodjobs keeps the company next to the job heading fallback", async () => {
    await fixture(documentHtml('<section><h1>Finance Intern</h1><p>Fictional Capital Limited</p></section>'), "https://www.ctgoodjobs.hk/job/fictional-nearby");
    const info = extractJobInfo(await collect());
    assert.equal(info.company, "Fictional Capital Limited");
    assert.equal(info.source.company, "页面标签");
  });

  await check("JobsDB keeps data-automation selectors", async () => {
    await fixture(documentHtml('<div data-automation="job-detail-title">Graduate Analyst</div><a data-automation="advertiser-name">Fictional Bank Limited</a><span data-automation="job-detail-location">Hong Kong</span>'), "https://hk.jobsdb.com/job/fictional-role");
    const info = extractJobInfo(await collect());
    assert.deepEqual(fields(info), { company: "Fictional Bank Limited", role: "Graduate Analyst", base: "Hong Kong" });
    assert.deepEqual(info.confidence, { company: "high", role: "high", base: "high" });
  });

  await check("Moka keeps explicit job page selectors", async () => {
    await fixture(documentHtml('<div class="companyName">星海科技有限公司</div><h1 class="jobTitle">财务实习生</h1><span class="workLocation">上海</span>'), "https://app.mokahr.com/campus-recruitment/fictional/job");
    const info = extractJobInfo(await collect());
    assert.deepEqual(fields(info), { company: "星海科技有限公司", role: "财务实习生", base: "上海" });
    assert.deepEqual(info.confidence, { company: "high", role: "high", base: "high" });
  });

  await check("Moka application wishes take priority over generic campus headings", async () => {
    await fixture(documentHtml('<div class="companyName">星海科技有限公司</div><h1>投递记录</h1><div class="jobTitle">校园</div><article><span>第 1 志愿</span><strong>2027届-财务专员（上海）</strong><p>状态：投递成功</p></article>'), "https://app.mokahr.com/candidate/fictional/applications");
    const info = extractJobInfo(await collect());
    assert.deepEqual(fields(info), { company: "星海科技有限公司", role: "2027届-财务专员（上海）", base: "" });
    assert.equal(info.confidence.role, "high");
  });

  console.log(`Job information browser cases passed: ${passed}`);
} finally {
  await browser.close();
}

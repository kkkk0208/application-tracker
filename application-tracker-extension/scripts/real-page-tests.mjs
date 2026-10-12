// Real-page scan acceptance test. Loads sanitized copies of real application forms
// (test/fixtures/real-pages/*.html), runs pageBridge "scan", and scores the result
// against the hand-checked answers in *.expected.json.
//   node scripts/real-page-tests.mjs            -> fails (exit 1) below the thresholds
//   node scripts/real-page-tests.mjs --report   -> prints the report only
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pageBridge } from "../src/assistant/pageBridge.js";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "test/fixtures/real-pages");
const reportOnly = process.argv.includes("--report");
const THRESHOLDS = { questionText: 0.95, section: 0.9, repeats: 1, controls: 0.9 };

const server = createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname).slice(1);
  if (!/^[\w.-]+\.html$/.test(name)) { res.writeHead(404).end(); return; }
  try { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(await readFile(path.join(dir, name))); } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
await context.route("**/*", (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
const page = await context.newPage();

const norm = (v) => String(v ?? "").normalize("NFKC").replace(/[\s*＊:：]/g, "").toLowerCase();
const GENERIC = /^(请输入|请选择|请填写|请选择日期|选择日期|未命名问题|pleaseenter|pleaseselect|select|choose)$/;
const sameSection = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x.includes(y) || y.includes(x)); };
const CONTROL_OK = {
  text: (f) => ["text"].includes(f.kind),
  textarea: (f) => f.kind === "textarea",
  select: (f) => ["select", "custom-select"].includes(f.kind),
  "select-2level": (f) => ["select", "custom-select"].includes(f.kind),
  "select+text": (f) => ["select", "custom-select", "text"].includes(f.kind),
  date: (f) => f.kind === "date" || /date|picker|my97/i.test(f.adapter || ""),
  "date-range": (f) => f.kind === "date" || /date|picker|my97/i.test(f.adapter || ""),
  cascader: (f) => f.kind === "cascader" || /cascader/i.test(f.adapter || ""),
  radio: (f) => f.kind === "radio",
  checkbox: (f) => ["checkboxes", "checkbox"].includes(f.kind),
  "popup-chooser": (f) => !f.supported ? !!f.reason : !!f.adapter
};
let failed = false;
const files = (await readdir(dir)).filter((f) => f.endsWith(".expected.json")).sort();
for (const file of files) {
  const expected = JSON.parse(await readFile(path.join(dir, file), "utf8"));
  await page.goto(`${origin}/${expected.fixture}`);
  const scan = await page.evaluate(pageBridge, { action: "scan" });
  const fields = [...scan.fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const questions = expected.questions.filter((q) => !["none", "file"].includes(q.control));
  const count = (list, key) => list.reduce((m, x) => m.set(key(x), (m.get(key(x)) || 0) + 1), new Map());
  const expText = count(questions, (q) => norm(q.question));
  const gotText = count(fields, (f) => norm(f.question || f.label));
  let textHit = 0; for (const [k, n] of expText) textHit += Math.min(n, gotText.get(k) || 0);
  let sectionHit = 0; const missed = [];
  const expSection = count(questions, (q) => `${q.section}\u0000${norm(q.question)}`);
  for (const [key, n] of expSection) {
    const [section, q] = key.split("\u0000");
    const got = fields.filter((f) => norm(f.question || f.label) === q && sameSection(f.section || f.group, section)).length;
    sectionHit += Math.min(n, got);
    if (got < n) missed.push(`${section} / ${q}`);
  }
  let repeatTotal = 0, repeatHit = 0;
  for (const [key, n] of expSection) {
    if (n < 2) continue;
    repeatTotal++;
    const [section, q] = key.split("\u0000");
    const groups = new Set(fields.filter((f) => norm(f.question || f.label) === q && sameSection(f.section || f.group, section)).map((f) => f.groupIndex ?? f.groupId));
    if (groups.size >= n) repeatHit++;
  }
  let controlTotal = 0, controlHit = 0; const badControls = [];
  for (const q of questions) {
    const check = CONTROL_OK[q.control];
    if (!check) continue;
    controlTotal++;
    // Control type is scored on the question text alone, so a section miss is not counted twice.
    const sameText = fields.filter((f) => norm(f.question || f.label) === norm(q.question));
    const inSection = sameText.filter((f) => sameSection(f.section || f.group, q.section));
    const candidates = inSection.length ? inSection : sameText;
    const ok = candidates.some((f) => check(f) && (q.control === "popup-chooser" || f.supported));
    if (ok) controlHit++; else badControls.push(`${q.section} / ${q.question} (${q.control})`);
  }
  const generic = fields.filter((f) => GENERIC.test(norm(f.question || f.label))).length;
  const ratio = (a, b) => (b ? a / b : 1);
  const result = { questionText: ratio(textHit, questions.length), section: ratio(sectionHit, questions.length), repeats: ratio(repeatHit, repeatTotal), controls: ratio(controlHit, controlTotal) };
  const pct = (x) => `${Math.round(x * 100)}%`;
  console.log(`\n${expected.fixture}  (${questions.length} 道可填的题, 扫描到 ${fields.length} 个字段, 题目是占位文字的 ${generic} 个)`);
  for (const [k, v] of Object.entries(result)) {
    const pass = v >= THRESHOLDS[k];
    if (!pass) failed = true;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${k.padEnd(12)} ${pct(v).padStart(4)}  (要求 ≥ ${pct(THRESHOLDS[k])})`);
  }
  if (missed.length) console.log(`  未对上的题（前 10 个）：${missed.slice(0, 10).join("；")}`);
  if (badControls.length) console.log(`  控件类型不对或不可填（前 10 个）：${badControls.slice(0, 10).join("；")}`);
}
await browser.close();
server.close();
if (failed && !reportOnly) { console.error("\n真实页面扫描未达标"); process.exit(1); }

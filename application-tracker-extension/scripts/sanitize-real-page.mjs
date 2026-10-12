// Make a test copy of a saved application page with personal data removed.
// Usage: node scripts/sanitize-real-page.mjs <saved-page.html> <slug> [--scrub "词1,词2"]
// Output: test/fixtures/real-pages/<slug>.html   (scripts, links, values, photos and tokens removed)
// The run fails if anything that looks like a phone number, email, ID number or filled value is left.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const [input, slug] = process.argv.slice(2);
if (!input || !/^[\w-]+$/.test(slug || "")) { console.error("用法: node scripts/sanitize-real-page.mjs <保存的网页.html> <英文短名>"); process.exit(2); }
const scrubIndex = process.argv.indexOf("--scrub");
const extraWords = scrubIndex > 0 ? String(process.argv[scrubIndex + 1] || "").split(/[,，]/).map((w) => w.trim()).filter(Boolean) : [];
const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "test/fixtures/real-pages");
const raw = (await readFile(input, "utf8")).replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<script\b[^>]*\/>/gi, "");

const browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) });
const context = await browser.newContext();
await context.route("**/*", (route) => route.abort());
const page = await context.newPage();
await page.setContent(raw, { waitUntil: "domcontentloaded" });
const result = await page.evaluate((extra) => {
  const PHONE = /(?<!\d)(1[3-9]\d)\d{8}(?!\d)/g, MAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g, IDNO = /(?<!\d)\d{17}[\dXx](?!\d)/g;
  const TEXT_TYPES = new Set(["text", "", "search", "tel", "email", "number", "date", "month", "url", "password", "hidden"]);
  const scrub = (t) => { let v = t.replace(PHONE, "$100000000").replace(MAIL, "user@example.com").replace(IDNO, "000000000000000000"); for (const w of extra) v = v.split(w).join("※"); return v; };
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT); const comments = []; while (walker.nextNode()) comments.push(walker.currentNode); comments.forEach((c) => c.remove());
  document.querySelectorAll("script, noscript, link, base, iframe, object, embed").forEach((n) => n.remove());
  document.querySelectorAll("meta").forEach((m) => { if (!m.hasAttribute("charset")) m.remove(); });
  const meta = document.createElement("meta"); meta.setAttribute("charset", "utf-8"); document.head.prepend(meta);
  let removed = 0;
  for (const i of document.querySelectorAll("input")) {
    if (TEXT_TYPES.has((i.getAttribute("type") || "text").toLowerCase()) && i.hasAttribute("value")) { if (i.getAttribute("value").trim()) removed++; i.removeAttribute("value"); }
    i.removeAttribute("checked");
  }
  document.querySelectorAll("option[selected]").forEach((o) => o.removeAttribute("selected"));
  document.querySelectorAll("textarea").forEach((t) => { if (t.textContent.trim()) removed++; t.textContent = ""; });
  document.querySelectorAll(".ant-select-selection-selected-value, .ant-select-selection-item").forEach((n) => { removed++; n.remove(); });
  document.querySelectorAll(".ant-select-selection__placeholder, .ant-select-selection-placeholder").forEach((n) => n.removeAttribute("style"));
  document.querySelectorAll(".ant-cascader-picker-label").forEach((n) => { if (n.textContent.trim()) removed++; n.textContent = ""; });
  document.querySelectorAll(".ant-cascader-input").forEach((n) => { if (!n.getAttribute("placeholder")) n.setAttribute("placeholder", "请选择"); });
  document.querySelectorAll("[class*='-checked'], .is-checked").forEach((n) => n.classList.remove(...[...n.classList].filter((c) => c.endsWith("-checked") || c === "is-checked")));
  document.querySelectorAll("img").forEach((n) => ["src", "srcset", "data-src"].forEach((a) => n.removeAttribute(a)));
  document.querySelectorAll("a[href]").forEach((n) => n.setAttribute("href", "#"));
  for (const el of document.querySelectorAll("*")) {
    for (const { name, value } of [...el.attributes]) {
      if ((name === "title" || name === "data-value") && el.closest(".ant-select, .ant-cascader-picker")) { el.removeAttribute(name); continue; }
      if (name.startsWith("data-") && /\d{8,}/.test(value)) { el.removeAttribute(name); continue; }
      if (name === "style" && /url\(/.test(value)) { el.setAttribute(name, value.replace(/url\([^)]*\)/g, "none")); continue; }
      const next = scrub(value).replace(/((?:https?:)?\/\/[^"'\s>?]+)\?[^"'\s>)]*/g, "$1"); // drop URL query strings (tokens, ids)
      if (next !== value) el.setAttribute(name, next);
    }
  }
  const texts = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
  while (texts.nextNode()) { const n = texts.currentNode; const next = scrub(n.nodeValue); if (next !== n.nodeValue) n.nodeValue = next; }
  const html = "<!doctype html>\n<!-- 已清除个人信息、脚本和外链，仅保留页面结构，用于扫描测试 -->\n" + document.documentElement.outerHTML;
  const left = { phone: (html.replace(/00000000/g, "").match(PHONE) || []).length, email: (html.match(MAIL) || []).filter((m) => m !== "user@example.com").length, id: (html.match(IDNO) || []).filter((m) => !/^0+$/.test(m)).length, words: extra.filter((w) => html.includes(w)).length,
    values: [...document.querySelectorAll("input")].filter((i) => TEXT_TYPES.has((i.getAttribute("type") || "text").toLowerCase()) && i.getAttribute("value")).length };
  return { html, removed, left };
}, extraWords);
await browser.close();
await mkdir(outDir, { recursive: true });
const out = path.join(outDir, `${slug}.html`);
await writeFile(out, result.html, "utf8");
console.log(`已写入 ${path.relative(root, out)}，清除填写值 ${result.removed} 处`);
const leftovers = Object.entries(result.left).filter(([, n]) => n > 0);
if (leftovers.length) { console.error("仍有疑似个人信息，请人工检查：", Object.fromEntries(leftovers)); process.exit(1); }
console.log("检查通过：没有发现手机号、邮箱、证件号或已填写的值。下一步请为它手写 <slug>.expected.json");

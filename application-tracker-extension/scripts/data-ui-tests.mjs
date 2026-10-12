// Synthetic data only, in fresh headless pages. The Chrome API adapter exercises
// the same mutation queue as the extension worker; it is not a user profile.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { createMutationQueue, MUTATION_MESSAGE } from "../src/storageMutations.js";
import { createBackup } from "../src/backup.js";
import { createRecord } from "../src/model.js";
import { STORAGE_KEY, PROFILE_STORAGE_KEY, AI_SETTINGS_STORAGE_KEY } from "../src/constants.js";
import { MEMORY_KEY } from "../src/storageKeys.js";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const root = path.resolve(import.meta.dirname, "..");
const server = createServer(async (request, response) => {
  const file = path.resolve(root, "." + new URL(request.url, "http://localhost").pathname);
  if (!file.startsWith(root + path.sep)) return response.writeHead(403).end();
  response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
  try { response.end(await readFile(file)); } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const errors = [];
try {
  const record = { ...createRecord({ company: "示例公司", role: "分析师", portalLink: "https://example.com/apply?id=1", source: "company_portal", appliedDate: "2026-09-20", status: "applied", notes: "原备注" }), id: "original-record" };
  const memory = { id: "original-memory", question: "其他技能", answer: "SQL", language: "zh", entityId: "self", scope: "https://example.com/apply?jobId=1", scopeVersion: 2, confirmed: true, updatedAt: "2026-09-20T12:00:00Z", history: [] };
  let data = { [STORAGE_KEY]: [record], [PROFILE_STORAGE_KEY]: { fullNameZh: "示例用户" }, [MEMORY_KEY]: [memory], [AI_SETTINGS_STORAGE_KEY]: { enabled: true, apiKey: "TEST_CREDENTIAL_DO_NOT_EXPORT" } };
  const pages = [];
  const get = async (keys) => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in data).map((key) => [key, data[key]])));
  const set = async (values) => {
    const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: data[key], newValue: value }]));
    data = { ...data, ...structuredClone(values) };
    await Promise.all(pages.map((page) => page.evaluate((changes) => window.__storageEvent?.emit(changes, "local"), changes)));
  };
  const mutate = createMutationQueue({ get, set });
  async function pageFor(route) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); pages.push(page);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeBinding("dataApi", async (_, method, args) => {
      if (method === "get") return get(args);
      if (method === "message" && args.type === MUTATION_MESSAGE) {
        try { return { ok: true, value: await mutate(args.mutation) }; } catch (error) { return { ok: false, error: error.message }; }
      }
      throw new Error(`Unexpected API ${method}`);
    });
    await page.addInitScript(() => {
      const listeners = new Set();
      window.__storageEvent = { addListener: (listener) => listeners.add(listener), emit: (...args) => listeners.forEach((listener) => listener(...args)) };
      window.chrome = { storage: { local: { get: (keys) => dataApi("get", keys) }, onChanged: window.__storageEvent }, runtime: { sendMessage: (message) => dataApi("message", message) } };
    });
    await page.goto(origin + route);
    return page;
  }
  const table = await pageFor("/src/records/records.html");
  const board = await pageFor("/src/board/board.html");
  await table.locator("button[data-action='edit']").click();
  await table.locator("textarea[name='notes']").fill("在表格里修改的新备注");
  await table.locator("#saveEditButton").click();
  await table.waitForFunction(() => !document.getElementById("recordDialog").open);
  await board.locator("select[data-action='status']").selectOption("oa");
  await table.waitForFunction(() => document.querySelector("select[data-action='status']")?.value === "oa");
  assert.equal(data[STORAGE_KEY][0].notes, "在表格里修改的新备注");
  console.log("PASS data UI synchronizes board and table while status updates preserve new notes");
  await table.locator("button[data-action='edit']").click();
  await table.locator("textarea[name='notes']").fill("旧窗口的编辑");
  await mutate({ operation: "record.patch", id: record.id, changes: { notes: "另一页面的最新备注" } });
  await table.locator("#saveEditButton").click();
  await table.locator("#editErrors").waitFor({ state: "visible" });
  assert.match(await table.locator("#editErrors").textContent(), /另一页面/);
  assert.equal(data[STORAGE_KEY][0].notes, "另一页面的最新备注");
  console.log("PASS data UI preserves edit drafts and reports conflicting concurrent edits");

  const memoryPage = await pageFor("/src/memory/memory.html");
  await memoryPage.locator(".memory-card").waitFor();
  await memoryPage.locator(".memory-card summary").click();
  assert.equal(await memoryPage.locator("[data-entity] option:checked").textContent(), "本人");
  await memoryPage.locator("[data-scope]").fill("https://example.com/apply?jobId=2&token=secret");
  await memoryPage.locator("[data-save]").click();
  await memoryPage.waitForFunction(() => document.getElementById("message").textContent.includes("已确认保存"));
  assert.equal(data[MEMORY_KEY][0].scope, "https://example.com/apply?jobId=2");
  console.log("PASS memory UI edits readable scopes and retains job identity without credentials");
  const downloadPromise = memoryPage.waitForEvent("download");
  await memoryPage.locator("#exportBackup").click();
  const exported = JSON.parse(await readFile(await (await downloadPromise).path(), "utf8"));
  assert.equal(exported.data.records.length, 1);
  assert.equal(JSON.stringify(exported).includes("TEST_CREDENTIAL_DO_NOT_EXPORT"), false);
  console.log("PASS backup UI exports complete data without API credentials");
  const incoming = createBackup({ records: [{ ...record, id: "imported-record", company: "备份公司" }], profile: { fullNameZh: "备份用户" }, memories: [{ ...memory, id: "imported-memory", answer: "Python" }], legacyMemories: [], legacyMemoryBackup: [] });
  await memoryPage.locator("#importBackup").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(incoming)) });
  await memoryPage.locator("#backupPreview").waitFor({ state: "visible" });
  assert.match(await memoryPage.locator("#backupSummary").textContent(), /恢复后共 2 条投递/);
  await memoryPage.locator("#confirmRestore").click();
  await memoryPage.waitForFunction(() => document.getElementById("message").textContent.startsWith("恢复完成"));
  assert.equal(data[STORAGE_KEY].length, 2);
  assert.equal(data[PROFILE_STORAGE_KEY].fullNameZh, "示例用户");
  assert.equal(data[MEMORY_KEY].find((entry) => entry.id === "imported-memory").confirmed, false);
  await table.waitForFunction(() => document.querySelectorAll("#recordsBody tr").length === 2);
  console.log("PASS backup UI previews and merges records while retaining current profile");
  await memoryPage.locator("#restoreRecovery").click();
  await memoryPage.waitForFunction(() => !document.getElementById("confirmRestore").disabled);
  await memoryPage.locator("#confirmRestore").click();
  await memoryPage.waitForFunction(() => document.getElementById("backupPreview").hidden);
  assert.equal(data[STORAGE_KEY].length, 1);
  assert.equal(data[MEMORY_KEY].length, 1);
  console.log("PASS backup UI recovers the data present before import");
  await memoryPage.locator("#importBackup").setInputFiles({ name: "broken.json", mimeType: "application/json", buffer: Buffer.from('{"schemaVersion":999}') });
  await memoryPage.waitForFunction(() => document.getElementById("message").textContent.includes("校验失败"));
  assert.equal(await memoryPage.locator("#backupPreview").isVisible(), false);
  assert.equal(data[STORAGE_KEY].length, 1);
  console.log("PASS backup UI rejects invalid files without changing data");
  await memoryPage.setViewportSize({ width: 420, height: 1000 });
  assert.equal(await memoryPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  const artifacts = path.join(root, "test-artifacts"); await mkdir(artifacts, { recursive: true });
  await memoryPage.screenshot({ path: path.join(artifacts, "memory-backup-preview.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Data UI integration cases passed: 8 (Chrome API adapter, synthetic fixtures)");
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }

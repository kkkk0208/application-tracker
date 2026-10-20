import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const root = path.resolve(import.meta.dirname, "..");
const fixture = '<!doctype html><html><head><meta charset="utf-8"><title>示例公司 · 分析师申请</title></head><body><form><section><h2>基本信息</h2><label>姓名<input id="name" required></label><label>邮箱<input id="email" type="email"></label></section><section><h2>硕士教育</h2><label>学校名称<input id="school"></label></section><section><h2>申请问题</h2><label>自我介绍<textarea id="intro"></textarea></label><label>奖惩情况<textarea id="awards"></textarea></label></section></form><iframe src="/child"></iframe></body></html>';
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === "/child") return res.end('<label>个人网站<input id="website"></label>');
  if (req.url === "/cross") return res.end(fixture.replace('src="/child"', `src="http://localhost:${server.address().port}/child"`));
  res.end(fixture);
});
let context;
let temporary;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  temporary = await mkdtemp(path.join(tmpdir(), "application-assistant-test-"));
  const extensionPath = path.join(temporary, "extension");
  await cp(root, extensionPath, { recursive: true, filter: (source) => !["test-artifacts", "node_modules", ".git"].includes(path.basename(source)) });
  const manifest = JSON.parse(await readFile(path.join(extensionPath, "manifest.json"), "utf8"));
  manifest.host_permissions.push("http://127.0.0.1/*");
  await writeFile(path.join(extensionPath, "manifest.json"), JSON.stringify(manifest));
  // Always use a new disposable profile, including when using installed Chrome.
  const browserChoice = process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: process.platform === "win32" ? "chrome" : "chromium" };
  const bundledArgs = browserChoice.channel === "chromium" ? [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] : [];
  context = await playwright.chromium.launchPersistentContext(path.join(temporary, "profile"), { ...browserChoice, headless: true, ignoreDefaultArgs: ["--disable-extensions"], args: ["--enable-unsafe-extension-debugging", ...bundledArgs] });
  context.setDefaultTimeout(15000);
  let extensionId = context.serviceWorkers().find((worker) => worker.url().startsWith("chrome-extension://"))?.url().split("/")[2];
  if (!extensionId) {
    // Extensions is a browser-target CDP domain, not a page-target domain.
    // This also supports Chrome versions that removed --load-extension.
    const cdp = await context.browser().newBrowserCDPSession();
    try { extensionId = (await cdp.send("Extensions.loadUnpacked", { path: extensionPath })).id; }
    finally { await cdp.detach(); }
  }
  // Wake MV3 through a real extension message; an idle worker need not start
  // merely because an unpacked extension has been registered.
  const recordsPage = await context.newPage();
  await recordsPage.goto(`chrome-extension://${extensionId}/src/records/records.html`);
  await recordsPage.evaluate(async () => (await import(chrome.runtime.getURL("src/storage.js"))).replaceAllRecords([]));
  const worker = context.serviceWorkers().find((item) => item.url().startsWith("chrome-extension://")) || await context.waitForEvent("serviceworker", { predicate: (item) => item.url().startsWith("chrome-extension://"), timeout: 15000 });
  assert.equal(new URL(worker.url()).host, extensionId);
  assert.ok(worker.url().endsWith("/src/assistant/background.js"));
  console.log(`Runtime: Chrome ${context.browser().version()}, real MV3 worker ${extensionId}, disposable profile`);
  const target = await context.newPage(); await target.goto(origin + "/apply");
  const ids = await worker.evaluate(async (url) => { const tabs = await chrome.tabs.query({}); const tab = tabs.find((t) => t.url === url); return { tabId: tab.id, windowId: tab.windowId }; }, origin + "/apply");
  const originalProfile = { fullNameZh: "示例申请人", email: "profile@example.com", masterUniversityZh: "示例大学", website: "https://portfolio.example.com", commonAnswers: { selfIntroduction: { zh: "这是一段待核对的自我介绍。", en: "" } } };
  await worker.evaluate(async ({ ids, profile }) => {
    await chrome.storage.local.set({ "applicationTracker.profile": profile, "applicationTracker.aiSettings": { enabled: false }, "applicationTracker.questionMemory": [{ id: "legacy-one", question: "其他技能", answer: "SQL", language: "zh", pageUrl: "https://example.com/apply" }] });
    await chrome.storage.session.set({ [`applicationTracker.assistant.target.${ids.windowId}`]: ids.tabId });
  }, { ids, profile: originalProfile });
  const panel = await context.newPage();
  const preparePage = async () => {
    if (!await panel.locator("#prepare").isVisible() && !await panel.locator("#menu").isVisible()) await panel.locator("#menuButton").click();
    await panel.locator("#prepare").click();
  };
  const errors = []; panel.on("pageerror", (error) => errors.push(error.message));
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/assistant.html`);
  const createRecords = (page, prefix) => page.evaluate(async (prefix) => {
    const { saveNewRecord } = await import(chrome.runtime.getURL("src/storage.js"));
    return Promise.all(Array.from({ length: 8 }, (_, index) => saveNewRecord({ company: `${prefix}-${index}`, role: "测试岗位", source: "company_portal", portalLink: "https://example.com/apply", appliedDate: "2026-09-21", status: "applied" })));
  }, prefix);
  const [leftRecords] = await Promise.all([createRecords(panel, "panel"), createRecords(recordsPage, "records")]);
  await Promise.all([
    panel.evaluate(async (id) => { const { saveExistingRecord } = await import(chrome.runtime.getURL("src/storage.js")); await saveExistingRecord(id, { status: "oa" }); }, leftRecords[0].id),
    recordsPage.evaluate(async (id) => { const { saveExistingRecord } = await import(chrome.runtime.getURL("src/storage.js")); await saveExistingRecord(id, { notes: "另一页面的更新" }); }, leftRecords[0].id)
  ]);
  const queuedRecords = await recordsPage.evaluate(async () => (await import(chrome.runtime.getURL("src/storage.js"))).getRecords());
  assert.equal(queuedRecords.length, 16);
  assert.equal(new Set(queuedRecords.map((record) => record.id)).size, 16);
  assert.equal(queuedRecords.find((record) => record.id === leftRecords[0].id).status, "oa");
  assert.equal(queuedRecords.find((record) => record.id === leftRecords[0].id).notes, "另一页面的更新");
  console.log("PASS real background queue preserves concurrent writes and independent patches across extension pages");
  await preparePage();
  await panel.locator("#questions .question").first().waitFor();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  assert.equal(await panel.locator("#questions .question").count(), 6);
  assert.match(await panel.locator("#coverage").textContent(), /2\/2/);
  assert.match(await panel.locator("#fill").textContent(), /5/);
  assert.equal(await panel.locator("[data-selected]:checked").count(), 5);
  const introduction = panel.locator(".question").filter({ has: panel.getByRole("textbox", { name: "自我介绍的答案", exact: true }) });
  assert.equal(await introduction.locator("[data-answer]").inputValue(), originalProfile.commonAnswers.selfIntroduction.zh);
  assert.equal(await introduction.locator("[data-selected]").isChecked(), true, "An existing personal narrative belongs in the one-confirmation batch with AI disabled");
  for (const selector of ["#name", "#email", "#school", "#intro", "#awards"]) assert.equal(await target.locator(selector).inputValue(), "", "Preparing the preview must not write to the application form");
  assert.equal(await target.frames()[1].locator("#website").inputValue(), "");
  console.log("PASS real extension previews five local answers including personal narrative across both frames without writing before confirmation");
  await target.locator("#email").fill("user-change@example.com");
  const versionCheck = await panel.evaluate(async (windowId) => {
    const { versionOf } = await import(chrome.runtime.getURL("src/assistant/planner.js"));
    const { getMemories, loadSession } = await import(chrome.runtime.getURL("src/assistant/store.js"));
    return { planned: (await loadSession(windowId)).memoryVersion, stored: versionOf(await getMemories()) };
  }, ids.windowId);
  assert.equal(versionCheck.planned, versionCheck.stored, "Chrome storage round-trip must preserve the memory version after migration");
  await panel.locator("#fill").click();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled && document.querySelectorAll("#resultList .result-row").length === 5);
  assert.equal(await target.locator("#name").inputValue(), "示例申请人");
  assert.equal(await target.locator("#school").inputValue(), "示例大学");
  assert.equal(await target.locator("#email").inputValue(), "user-change@example.com");
  assert.equal(await target.locator("#intro").inputValue(), originalProfile.commonAnswers.selfIntroduction.zh);
  assert.equal(await target.frames()[1].locator("#website").inputValue(), "https://portfolio.example.com");
  assert.match(await panel.locator("#resultSummary").textContent(), /4\/5/);
  console.log("PASS one confirmation writes and verifies all previewed answers while preserving manual webpage edits");
  const profileAfter = await worker.evaluate(async () => (await chrome.storage.local.get("applicationTracker.profile"))["applicationTracker.profile"]);
  assert.deepEqual(profileAfter, originalProfile);
  const memories = await worker.evaluate(async () => (await chrome.storage.local.get("applicationTracker.assistant.memories.v2"))["applicationTracker.assistant.memories.v2"]);
  assert.equal(memories.length, 1); assert.equal(memories[0].confirmed, false);
  console.log("PASS fill never edits profile or automatically promotes learned answers");
  await panel.locator("#undo").click();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled && [...document.querySelectorAll("#resultList .result-row p")].filter((node) => node.textContent === "已撤销").length === 4);
  assert.equal(await target.locator("#name").inputValue(), ""); assert.equal(await target.locator("#school").inputValue(), "");
  assert.equal(await target.locator("#email").inputValue(), "user-change@example.com");
  assert.equal(await target.locator("#intro").inputValue(), "");
  console.log("PASS extension undo restores only assistant-written fields");
  await preparePage(); await panel.waitForFunction(() => !document.getElementById("prepare").disabled);
  const artifacts = path.join(root, "test-artifacts"); await mkdir(artifacts, { recursive: true });
  await panel.setViewportSize({ width: 420, height: 1000 }); await panel.screenshot({ path: path.join(artifacts, "assistant-preview.png"), fullPage: true });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await panel.setViewportSize({ width: 320, height: 900 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  console.log("PASS side panel layout fits 320px and 420px widths");
  await panel.reload(); await panel.locator("#questions .question").first().waitFor();
  assert.equal(await panel.locator("#questions .question").count(), 6);
  console.log("PASS extension session restores after closing/reopening its document");
  await target.reload();
  await panel.waitForFunction(() => document.getElementById("fill").disabled);
  assert.match(await panel.locator("#message").textContent(), /变化|重新识别/);
  console.log("PASS navigation invalidates the old fill plan");

  // An inactive extension tab executes the real popup document while preserving
  // the active application tab, then is destroyed to model popup dismissal.
  const openPopupDocument = async () => {
    await worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), ids.tabId);
    const opened = context.waitForEvent("page");
    await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), `chrome-extension://${extensionId}/src/popup/popup.html`);
    const popup = await opened;
    popup.on("pageerror", (error) => errors.push(error.message));
    await popup.waitForLoadState();
    await popup.waitForFunction(() => !!document.querySelector('[name="portalLink"]').value);
    return popup;
  };
  let popup = await openPopupDocument();
  assert.equal(await popup.locator('[name="portalLink"]').inputValue(), origin + "/apply");
  assert.equal(await popup.locator('[name="company"]').inputValue(), "示例公司");
  assert.equal(await popup.locator('[data-job-source="company"]').textContent(), "网页标题");
  await popup.locator('[name="company"]').fill("草稿测试公司");
  assert.equal(await popup.locator('[data-job-source="company"]').isVisible(), false);
  await popup.locator('[name="role"]').fill("草稿测试岗位");
  await popup.locator('[name="notes"]').fill("最后一次输入后立即关闭");
  await popup.close();
  popup = await openPopupDocument();
  assert.equal(await popup.locator('[name="company"]').inputValue(), "草稿测试公司");
  assert.equal(await popup.locator('[name="role"]').inputValue(), "草稿测试岗位");
  assert.equal(await popup.locator('[name="notes"]').inputValue(), "最后一次输入后立即关闭");
  assert.match(await popup.locator("#saveMessage").textContent(), /恢复/);
  await popup.close();
  await target.goto(origin + "/apply?jobId=another-role");
  popup = await openPopupDocument();
  assert.equal(await popup.locator('[name="company"]').inputValue(), "示例公司");
  assert.equal(await popup.locator('[name="notes"]').inputValue(), "");
  await popup.close();
  await target.goto(origin + "/apply");
  popup = await openPopupDocument();
  assert.equal(await popup.locator('[name="company"]').inputValue(), "草稿测试公司");
  await popup.locator("#clearDraft").click();
  await popup.waitForFunction(() => document.getElementById("saveMessage").textContent.includes("已清空草稿"));
  await popup.close();
  popup = await openPopupDocument();
  assert.equal(await popup.locator('[name="company"]').inputValue(), "示例公司");
  assert.equal(await popup.locator('[name="portalLink"]').inputValue(), origin + "/apply");
  await popup.close();
  console.log("PASS real popup document restores after destruction, isolates job IDs and honors explicit clearing");
  await target.evaluate(() => { document.title = "填写简历"; });
  popup = await openPopupDocument();
  await popup.locator("#recentJobBox").waitFor({ state: "visible" });
  const currentLink = await popup.locator('[name="portalLink"]').inputValue();
  await popup.locator("#recentJob").selectOption("0");
  assert.equal(await popup.locator('[name="company"]').inputValue(), "示例公司");
  assert.equal(await popup.locator('[data-job-source="role"]').textContent(), "最近岗位");
  assert.equal(await popup.locator('[name="portalLink"]').inputValue(), currentLink);
  const recent = await worker.evaluate(async () => (await chrome.storage.session.get("applicationTracker.recentJobs"))["applicationTracker.recentJobs"]);
  assert.equal(recent.length, 2);
  assert.deepEqual(recent.map((job) => new URL(job.url).search).sort(), ["", "?jobId=another-role"]);
  await popup.close();
  await target.reload();
  console.log("PASS real popup offers recent jobs on application pages and preserves the current application link");

  // Exercise the native download/file-input and MV3 message/storage path, which
  // the DOM tests' Chrome API adapter cannot verify.
  const memoryPage = await context.newPage();
  memoryPage.on("pageerror", (error) => errors.push(error.message));
  await memoryPage.goto(`chrome-extension://${extensionId}/src/memory/memory.html`);
  await memoryPage.locator(".memory-card").first().waitFor();
  const apiKeyFixture = "fixture-key-must-never-be-exported";
  await memoryPage.evaluate(async (apiKey) => {
    const { saveAiSettings } = await import(chrome.runtime.getURL("src/storage.js"));
    await saveAiSettings({ enabled: false, apiKey, model: "gpt-5-mini" });
  }, apiKeyFixture);
  const downloaded = memoryPage.waitForEvent("download");
  await memoryPage.locator("#exportBackup").click();
  const download = await downloaded;
  const backupPath = path.join(temporary, "downloaded-fixture-backup.json");
  await download.saveAs(backupPath);
  const backupText = await readFile(backupPath, "utf8");
  const downloadedBackup = JSON.parse(backupText);
  assert.match(download.suggestedFilename(), /^application-tracker-backup-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(downloadedBackup.schemaVersion, 3);
  assert.equal(downloadedBackup.data.records.length, 16);
  assert.equal(downloadedBackup.data.memories.length, 1);
  assert.equal(downloadedBackup.data.profile.email, originalProfile.email);
  assert.ok(!backupText.includes(apiKeyFixture) && !backupText.includes('"apiKey"'));
  const readBackupState = () => memoryPage.evaluate(async () => (await import(chrome.runtime.getURL("src/storageClient.js"))).requestStorageMutation({ operation: "backup.export" }));
  await memoryPage.evaluate(async () => {
    const { saveNewRecord, saveProfile, getProfile } = await import(chrome.runtime.getURL("src/storage.js"));
    const { getMemories, saveMemory } = await import(chrome.runtime.getURL("src/assistant/store.js"));
    await saveNewRecord({ company: "导出后新增的公司", role: "恢复测试岗位", source: "company_portal", portalLink: "https://example.com/after-backup", appliedDate: "2026-09-21", status: "applied" });
    await saveProfile({ ...await getProfile(), email: "changed-before-restore@example.com" });
    const memory = (await getMemories())[0];
    await saveMemory({ ...memory, answer: "导入前更新的答案" });
  });
  const beforeImport = await readBackupState();
  assert.equal(beforeImport.data.records.length, 17);
  await memoryPage.locator("#importBackup").setInputFiles(backupPath);
  await memoryPage.waitForFunction(() => !document.getElementById("backupPreview").hidden && !document.getElementById("confirmRestore").disabled);
  await memoryPage.locator("#restoreMode").selectOption("replace");
  await memoryPage.waitForFunction(() => !document.getElementById("confirmRestore").disabled && document.getElementById("restoreDescription").textContent.includes("替换全部"));
  assert.match(await memoryPage.locator("#backupSummary").textContent(), /备份包含 16 条投递/);
  assert.deepEqual((await readBackupState()).data, beforeImport.data, "A real backup preview must not write data");
  await memoryPage.locator("#confirmRestore").click();
  await memoryPage.waitForFunction(() => document.getElementById("backupPreview").hidden && document.getElementById("message").textContent.includes("恢复完成"));
  assert.deepEqual((await readBackupState()).data, downloadedBackup.data);
  assert.equal(await memoryPage.evaluate(async () => (await chrome.storage.local.get("applicationTracker.aiSettings"))["applicationTracker.aiSettings"].apiKey), apiKeyFixture);
  await memoryPage.locator("#restoreRecovery").waitFor({ state: "visible" });
  await memoryPage.locator("#restoreRecovery").click();
  await memoryPage.waitForFunction(() => !document.getElementById("backupPreview").hidden && !document.getElementById("confirmRestore").disabled);
  assert.match(await memoryPage.locator("#backupSummary").textContent(), /备份包含 17 条投递/);
  await memoryPage.locator("#confirmRestore").click();
  await memoryPage.waitForFunction(() => document.getElementById("backupPreview").hidden && document.getElementById("message").textContent.includes("恢复完成"));
  assert.deepEqual((await readBackupState()).data, beforeImport.data);
  assert.equal(await memoryPage.evaluate(async () => (await chrome.storage.local.get("applicationTracker.aiSettings"))["applicationTracker.aiSettings"].apiKey), apiKeyFixture);
  console.log("PASS real backup download, file preview, replacement and recovery round-trip preserve data and exclude API credentials");

  // A host permission allows DOM inspection, but it does not grant the distinct
  // captureVisibleTab privilege. Programmatic activation and opening the popup
  // document above deliberately do not simulate a user extension-action grant.
  await worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), ids.tabId);
  const deniedCapture = await panel.evaluate(async (tabId) => {
    const { scanPage } = await import(chrome.runtime.getURL("src/assistant/session.js"));
    const { captureVisualContext } = await import(chrome.runtime.getURL("src/assistant/visualCapture.js"));
    const snapshot = await scanPage(tabId);
    try {
      await captureVisualContext(snapshot);
      return { captured: true };
    } catch (error) {
      return { captured: false, code: error.code, message: error.message };
    }
  }, ids.tabId);
  assert.equal(deniedCapture.captured, false);
  assert.equal(deniedCapture.code, "VISUAL_PERMISSION");
  assert.match(deniedCapture.message, /重新点击扩展图标/);
  assert.match(deniedCapture.message, /继续使用网页文字识别/);
  const savedState = await panel.evaluate(async () => JSON.stringify({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
  assert.equal(savedState.includes("data:image/"), false, "A denied screenshot must not leave image data in extension storage");
  console.log("PASS real screenshot permission denial explains recovery and preserves the text-recognition fallback without storing images");

  const aiPage = await context.newPage();
  aiPage.on("pageerror", (error) => errors.push(error.message));
  const priorAiSettings = await worker.evaluate(async () => (await chrome.storage.local.get("applicationTracker.aiSettings"))["applicationTracker.aiSettings"]);
  await aiPage.goto(`chrome-extension://${extensionId}/src/ai/ai.html`);
  await aiPage.waitForFunction(() => document.querySelector('[name="apiKey"]').value === "fixture-key-must-never-be-exported");
  assert.equal(await aiPage.locator('[name="visionEnabled"]').isChecked(), false);
  await aiPage.locator('[name="visionEnabled"]').check();
  await aiPage.locator('button[type="submit"]').click();
  await aiPage.locator("#message").waitFor({ state: "visible" });
  await aiPage.reload();
  await aiPage.waitForFunction(() => document.querySelector('[name="visionEnabled"]').checked);
  const optedIn = await worker.evaluate(async () => (await chrome.storage.local.get("applicationTracker.aiSettings"))["applicationTracker.aiSettings"]);
  assert.equal(optedIn.visionEnabled, true);
  assert.equal(optedIn.enabled, false, "Screenshot opt-in must not independently enable AI calls");
  assert.equal(optedIn.model, priorAiSettings.model);
  assert.equal(optedIn.apiKey, priorAiSettings.apiKey);
  await aiPage.locator('[name="visionEnabled"]').uncheck();
  await aiPage.locator('button[type="submit"]').click();
  await aiPage.locator("#message").waitFor({ state: "visible" });
  assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get("applicationTracker.aiSettings"))["applicationTracker.aiSettings"]), priorAiSettings);
  await aiPage.close();
  console.log("PASS real AI settings screen persists screenshot opt-in and opt-out without enabling AI or changing the model and key");
  await target.goto(origin + "/cross");
  await target.frameLocator("iframe").locator("#website").waitFor();
  await preparePage();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled && document.getElementById("coverage").textContent.includes("1/2"));
  const crossOrigin = `http://localhost:${server.address().port}`;
  assert.equal(await panel.getByRole("button", { name: `允许读取内嵌表单（localhost:${server.address().port}）`, exact: true }).count(), 1);
  const crossState = await panel.evaluate(async (windowId) => {
    const { loadSession } = await import(chrome.runtime.getURL("src/assistant/store.js"));
    const saved = await loadSession(windowId);
    return { failedFrames: saved.snapshot.failedFrames, fields: saved.snapshot.fields.length, permissions: await chrome.permissions.getAll() };
  }, ids.windowId);
  assert.equal(crossState.failedFrames.length, 1);
  assert.equal(crossState.failedFrames[0].origin, crossOrigin);
  assert.ok(crossState.failedFrames[0].frameId > 0);
  assert.equal(crossState.fields, 5);
  assert.ok(!crossState.permissions.origins.some((pattern) => /localhost|<all_urls>/.test(pattern)), "An optional permission must not be granted by scanning");
  assert.equal(await target.frameLocator("iframe").locator("#website").inputValue(), "");
  console.log("PASS real cross-origin iframe denial preserves main-page preview and offers only that frame origin without requesting access automatically");
  await target.goto(`http://localhost:${server.address().port}/apply?token=private-test-token`);
  await preparePage();
  await panel.locator("#allowPageAccess").waitFor({ state: "visible" });
  assert.match(await panel.locator("#message").textContent(), /尚未获得.*读取权限/);
  assert.ok((await panel.locator("#allowPageAccess").textContent()).includes(`localhost:${server.address().port}`));
  const mainDenied = await panel.evaluate(async (tabId) => {
    const { scanPage } = await import(chrome.runtime.getURL("src/assistant/session.js"));
    try { await scanPage(tabId); return { unexpectedSuccess: true }; }
    catch (error) { return { code: error.code, message: error.message, origin: error.origin }; }
  }, ids.tabId);
  assert.equal(mainDenied.code, "PAGE_ACCESS_REQUIRED");
  assert.equal(mainDenied.origin, `http://localhost:${server.address().port}`);
  assert.equal(await panel.evaluate((origin) => chrome.permissions.contains({ origins: [origin + "/*"] }), mainDenied.origin), false);
  assert.ok(!mainDenied.message.includes("private-test-token"));
  const afterDeniedPermissions = await worker.evaluate(() => chrome.permissions.getAll());
  assert.ok(!afterDeniedPermissions.origins.some((pattern) => /localhost|<all_urls>/.test(pattern)));
  assert.equal(await target.locator("#name").inputValue(), "");
  await target.goto(origin + "/apply"); await preparePage();
  await panel.waitForFunction(() => !document.getElementById("prepare").disabled && !document.getElementById("fill").disabled);
  assert.equal(await panel.locator("#allowPageAccess").isVisible(), false);
  assert.equal(await target.locator("#name").inputValue(), "");
  console.log("PASS real main-frame access denial is classified without tokens or automatic grants, and returning to an allowed page recovers preview only");
  assert.deepEqual(errors, []);
  console.log("Extension end-to-end cases passed: 15");
} catch (error) {
  for (const page of context?.pages() || []) if (/\/src\/(?:sidepanel\/assistant|memory\/memory)\.html$/.test(page.url())) {
    const diagnostic = await page.evaluate(() => Object.fromEntries(["message", "connection", "summary", "resultSummary", "resultList", "backupSummary", "restoreDescription"].map((id) => [id, document.getElementById(id)?.textContent]))).catch(() => ({}));
    console.error("Extension UI diagnostic:", JSON.stringify(diagnostic));
  }
  throw error;
} finally {
  if (context) await context.close().catch((error) => console.error("Browser cleanup:", error.message));
  if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  // Resolve and verify the exact mkdtemp directory before recursive cleanup.
  if (temporary && path.dirname(path.resolve(temporary)) === path.resolve(tmpdir()) && path.basename(temporary).startsWith("application-assistant-test-")) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

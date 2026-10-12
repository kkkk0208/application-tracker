import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pageBridge } from "../src/assistant/pageBridge.js";

// Only isolated synthetic pages are captured. Images remain in memory and no
// external AI service or existing user browser profile is used by this suite.
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const root = path.resolve(import.meta.dirname, "..");
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/fixture") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<!doctype html><html><head><title>Visual application fixture</title></head><body></body></html>'); return; }
  const file = path.resolve(root, "." + pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try { res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8"); res.end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let passed = 0;
const gray = [232, 236, 233, 255];
async function fixture() {
  await page.goto(origin + "/fixture");
  await page.evaluate(() => {
    document.body.innerHTML = `<style>
      body { margin:0; background:#fff; min-height:1600px; font-family:sans-serif }
      h2 { position:absolute; left:40px; top:12px }
      .form-item { position:absolute; width:300px; height:70px }
      label { display:block; height:25px }
      input, textarea { box-sizing:border-box; appearance:none; border:0; width:240px; height:40px; background:#e00000; color:#fff }
      #ordinary-box { left:40px; top:80px } #secret-box { left:40px; top:180px }
      #filled-box { left:40px; top:280px } #hidden-box { display:none }
      #shadow { position:absolute; left:40px; top:380px }
      #frame { position:absolute; left:400px; top:100px; width:250px; height:180px; border:0 }
      #offscreen-box { left:40px; top:1300px } #covered-box { left:700px; top:100px }
      #cover { position:absolute; left:690px; top:80px; width:290px; height:120px; background:#fafafa; z-index:2 }
      #readonly-answer { position:absolute; left:400px; top:350px; width:240px; height:40px; background:#e00000 }
    </style><h2>申请信息</h2>
    <div id="ordinary-box" class="form-item"><label for="ordinary">学校名称</label><input id="ordinary"></div>
    <div id="secret-box" class="form-item"><label for="secret">密码</label><input id="secret" type="password" value="SYNTHETIC_PASSWORD_ONLY"></div>
    <div id="filled-box" class="form-item"><label for="filled">邮箱</label><input id="filled" value="synthetic@example.test"></div>
    <div id="hidden-box" class="form-item"><input id="hidden"></div>
    <div id="offscreen-box" class="form-item"><label for="offscreen">其他说明</label><input id="offscreen"></div>
    <div id="covered-box" class="form-item"><label for="covered">被挡住的字段</label><input id="covered"></div><div id="cover"></div>
    <div id="shadow"></div>
    <iframe id="frame" srcdoc="<style>body { margin:0; background:#e00000 }</style>PRIVATE_FRAME_TEST_ONLY"></iframe>
    <div id="readonly-answer" data-answer>PRIVATE_READONLY_TEST_ONLY</div>`;
    document.getElementById("shadow").attachShadow({ mode: "open" }).innerHTML = '<style>.form-item { width:300px; height:70px }input { display:block; width:240px; height:40px; border:0; background:#e00000 }</style><div class="form-item"><label>私人字段<input value="PRIVATE_SHADOW_TEST_ONLY"></label></div>';
  });
  await page.locator("#frame").waitFor();
  await page.waitForFunction(() => document.getElementById("frame").contentDocument?.readyState === "complete");
  return page.evaluate(pageBridge, { action: "scan" });
}
const layoutFor = (scan, extra = {}) => page.evaluate(pageBridge, { action: "visual-layout", token: scan.token, scanId: scan.scanId, url: scan.url, ...extra });
const marked = (layout) => layout.fields.map((field, index) => ({ fieldId: `doc:${field.localFieldId}`, marker: `V${index + 1}`, rect: field.rect }));
const imageSamples = (imageUrl, coordinates) => page.evaluate(async ({ imageUrl, coordinates }) => {
  const bitmap = await createImageBitmap(await (await fetch(imageUrl)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
  const samples = coordinates.map(([x, y]) => [...ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data]);
  const result = { width: bitmap.width, height: bitmap.height, samples };
  bitmap.close(); canvas.width = 1; canvas.height = 1;
  return result;
}, { imageUrl, coordinates });
const render = (rawImageUrl, layout) => page.evaluate(async ({ rawImageUrl, layout, fields }) => (await import("/src/assistant/visualCapture.js")).renderVisualCapture(rawImageUrl, layout, fields), { rawImageUrl, layout, fields: marked(layout) });
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

try {
  await check("visual geometry contains no field text or values and excludes filled, offscreen, covered and iframe fields", async () => {
    const scan = await fixture();
    const layout = await layoutFor(scan);
    const ids = new Set(layout.fields.map((field) => field.localFieldId));
    assert.equal(ids.has(scan.fields.find((field) => field.identity.id === "ordinary").fieldId), true);
    for (const id of ["secret", "filled", "offscreen", "covered"]) assert.equal(ids.has(scan.fields.find((field) => field.identity.id === id).fieldId), false, id);
    assert.equal(layout.fields.length, 1);
    assert.ok(layout.redactions.length >= 7);
    assert.doesNotMatch(JSON.stringify(layout), /SYNTHETIC|PRIVATE|synthetic@|学校|密码|iframe|input/);
  });
  await check("real Chrome pixels redact inputs, filled containers, iframe, open shadow controls and answer blocks before marking", async () => {
    const scan = await fixture();
    const layout = await layoutFor(scan);
    const raw = `data:image/png;base64,${(await page.screenshot({ type: "png" })).toString("base64")}`;
    const points = [[200, 135], [200, 235], [200, 335], [600, 240], [200, 415], [600, 370]];
    const original = await imageSamples(raw, points);
    assert.ok(original.samples.every((pixel) => JSON.stringify(pixel) !== JSON.stringify(gray)));
    const result = await render(raw, layout);
    assert.equal(result.scale, 1);
    const processed = await imageSamples(result.imageUrl, points);
    assert.ok(processed.samples.every((pixel) => JSON.stringify(pixel) === JSON.stringify(gray)), JSON.stringify(processed.samples));
    assert.notEqual(result.imageUrl, raw);
    const marker = await imageSamples(result.imageUrl, [[41, 107], [900, 500]]);
    assert.deepEqual(marker.samples, [[22, 93, 216, 255], [255, 255, 255, 255]]);
    assert.equal(await page.locator("#secret").inputValue(), "SYNTHETIC_PASSWORD_ONLY");
    assert.equal(await page.locator("#ordinary").inputValue(), "");
  });
  await check("large real screenshots scale to 1600 pixels while retaining redaction", async () => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    const scan = await fixture();
    const layout = await layoutFor(scan);
    const raw = `data:image/png;base64,${(await page.screenshot({ type: "png" })).toString("base64")}`;
    const result = await render(raw, layout);
    assert.equal(result.scale, 0.625);
    const processed = await imageSamples(result.imageUrl, [[600 * result.scale, 240 * result.scale]]);
    assert.equal(processed.width, 1600); assert.equal(processed.height, 900);
    assert.deepEqual(processed.samples[0], gray);
    await page.setViewportSize({ width: 1000, height: 700 });
  });
  await check("transient geometry changes stay invalid after the original position returns", async () => {
    const scan = await fixture();
    const watchId = crypto.randomUUID();
    await layoutFor(scan, { startWatch: watchId });
    await page.locator("#ordinary").evaluate((el) => { el.style.transform = "translateX(10px)"; el.style.transform = ""; });
    assert.equal((await layoutFor(scan, { watchId })).changed, true);
    assert.deepEqual(await layoutFor(scan, { releaseWatch: watchId }), { released: true });
    const second = crypto.randomUUID();
    assert.equal((await layoutFor(scan, { startWatch: second })).changed, false);
    await layoutFor(scan, { releaseWatch: second });
  });
  await check("transient aria label changes invalidate screenshots even without geometry changes", async () => {
    const scan = await fixture();
    const watchId = crypto.randomUUID();
    await layoutFor(scan, { startWatch: watchId });
    await page.locator("#ordinary").evaluate((el) => { el.setAttribute("aria-label", "父亲学校"); el.removeAttribute("aria-label"); });
    assert.equal((await layoutFor(scan, { watchId })).changed, true);
    await layoutFor(scan, { releaseWatch: watchId });
  });
  await check("scrolling away and back invalidates a capture even with matching final coordinates", async () => {
    const scan = await fixture();
    const watchId = crypto.randomUUID();
    await layoutFor(scan, { startWatch: watchId });
    await page.evaluate(async () => { scrollTo(0, 200); await new Promise(requestAnimationFrame); scrollTo(0, 0); await new Promise(requestAnimationFrame); });
    assert.equal((await layoutFor(scan, { watchId })).changed, true);
    await layoutFor(scan, { releaseWatch: watchId });
  });
  await check("a fresh scan releases the previous capture watch and cannot reuse its old snapshot", async () => {
    const scan = await fixture();
    const watchId = crypto.randomUUID();
    await layoutFor(scan, { startWatch: watchId });
    const fresh = await page.evaluate(pageBridge, { action: "scan" });
    await assert.rejects(layoutFor(scan, { watchId }), /页面已变化/);
    const next = crypto.randomUUID();
    assert.equal((await layoutFor(fresh, { startWatch: next })).changed, false);
    await layoutFor(fresh, { releaseWatch: next });
  });
  assert.deepEqual(errors, []);
  console.log(`Vision browser cases passed: ${passed}`);
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }

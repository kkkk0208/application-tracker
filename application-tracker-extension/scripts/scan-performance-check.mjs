// Optional local diagnostic, deliberately not a timing pass/fail gate.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pageBridge } from "../src/assistant/pageBridge.js";
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end('<!doctype html><html><head><title>Scan performance fixture</title><style>.form-group{padding:2px}input{width:200px}</style></head><body><main id="fixture"></main></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) });
const page = await browser.newPage();
const bridgeSource = pageBridge.toString();
const time = (action, request = {}) => page.evaluate(async ({ bridgeSource, action, request }) => {
  const bridge = Function(`return (${bridgeSource})`)();
  const started = performance.now();
  const result = await bridge({ action, ...request });
  return { ms: performance.now() - started, result };
}, { bridgeSource, action, request });
const summary = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples: samples.map((value) => Math.round(value * 10) / 10), median: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10, max: Math.round(sorted.at(-1) * 10) / 10 };
};
try {
  for (const count of [30, 300]) {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator("#fixture").evaluate((node, count) => {
      node.innerHTML = '<h2>虚构测试资料</h2>' + Array.from({ length: count }, (_unused, index) => `<div class="form-group"><label for="f-${index}">测试字段${index}</label><input id="f-${index}"></div>`).join("");
    }, count);
    const scans = [], polls = [];
    let snapshot;
    for (let iteration = 0; iteration < 7; iteration++) {
      const scan = await time("scan");
      snapshot = scan.result;
      const poll = await time("changes", { token: snapshot.token, scanId: snapshot.scanId, url: snapshot.url });
      if (iteration) { scans.push(scan.ms); polls.push(poll.ms); }
    }
    console.log(JSON.stringify({ fields: count, scan: summary(scans), changes: summary(polls) }));
    if (count === 300) {
      // CSSOM mutation changes visibility without a DOM MutationObserver record.
      await page.evaluate(() => {
        window.observed = 0;
        window.testObserver = new MutationObserver((records) => { window.observed += records.length; });
        window.testObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        document.styleSheets[0].insertRule("#f-0 {display:none}", 0);
      });
      const poll = await time("changes", { token: snapshot.token, scanId: snapshot.scanId, url: snapshot.url });
      console.log(JSON.stringify({ diagnostic: "cssom-visibility", mutationRecords: await page.evaluate(() => window.observed), changed: poll.result.changed }));
      await page.evaluate(() => window.testObserver.disconnect());
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

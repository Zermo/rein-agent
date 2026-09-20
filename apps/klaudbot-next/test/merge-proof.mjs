import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const out = "/Users/portal/Projects/klaudbot-next-ultra/test-results";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: exe || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://127.0.0.1:4322/", { waitUntil: "networkidle" });
const title = await page.title();
const sign = await page.getByRole("button", { name: /Sign in · auth\.zermo\.org/ }).count();
await page.screenshot({ path: `${out}/merge-signin.png` });
await page.getByRole("tab", { name: "Path" }).click().catch(() => {});
await page.screenshot({ path: `${out}/merge-path.png` });
const spine = await page.locator(".turn-graph").evaluate(el => {
  const s = getComputedStyle(el);
  return { borderLeft: s.borderLeft, minHeight: s.minHeight };
}).catch(e => ({ error: String(e) }));
await page.getByRole("tab", { name: "CRT" }).click();
await page.screenshot({ path: `${out}/merge-crt.png` });
const crt = await page.locator(".computer-monitor").evaluate(el => {
  const s = getComputedStyle(el);
  return { color: s.color, background: s.backgroundColor };
}).catch(e => ({ error: String(e) }));
const chatOrder = await page.evaluate(() => {
  const chat = document.querySelector(".chat-pane");
  if (!chat) return { ok: false };
  const kids = [...chat.children].map(el => el.className);
  const t = kids.findIndex(c => c.includes("transcript"));
  const c = kids.findIndex(c => c.includes("composer"));
  return { kids, ledgerThenComposer: t >= 0 && c > t };
});
const report = { title, sign, spine, crt, chatOrder };
writeFileSync(`${out}/merge-proof.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log(JSON.stringify(report, null, 2));

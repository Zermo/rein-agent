import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { NATIVE_COMPOSER_VERSION, NATIVE_COMPOSER_CAPABILITY } from "../lib/native-composer.ts";

// A fixture backend only: no live bot, model request, account, or workspace is touched.
const root = fileURLToPath(new URL("../", import.meta.url));
const bot = { id: "klaud-bot-1234abcd", name: "Native fixture", sessionId: "fixture-session", created: "2026-01-01T00:00:00.000Z", computer: "local", engine: "openai-compat", cwd: "/fixture/workspace", avatar: "aviator" };
const secondBot = { ...bot, id: "klaud-bot-5678abcd", name: "Second fixture", sessionId: "second-session" };
const state = { shell: { version: 1, theme: { accent: "rain", density: "regular", dark: true }, chrome: { sidebar: true, tray: "normal", showActivity: true } }, prefs: { lastBotId: bot.id }, bots: [bot, secondBot], approvals: [] };
const records = [];
let stream;
let rejectNextRun = false;
const emit = event => stream.write(`data: ${JSON.stringify(event)}\n\n`);
const fixture = createServer(async (request, response) => {
  const path = new URL(request.url, "http://fixture.invalid").pathname;
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  records.push({ path, body });
  if (path === "/run") {
    if (rejectNextRun) { rejectNextRun = false; response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "Fixture rejection" })); return; }
    stream = response; response.writeHead(200, { "Content-Type": "text/event-stream" }); response.flushHeaders(); return;
  }
  if (path.endsWith("/cancel")) { emit({ type: "RUN_ERROR", message: "Fixture cancelled" }); stream.end(); }
  const data = path === "/health" ? { ok: true, name: "rein-klaud" }
    : path === "/state" || path === "/prefs" ? state : path === "/bots" ? state.bots
    : path === "/settings" ? { bashApproval: "ask", reasoningEffort: "default" }
    : path === "/activity" ? { autonomy: { status: "inactive" } }
    : path.endsWith("/messages") ? { messages: [], before: null }
    : path.endsWith("/inspect-list") ? { files: [] } : {};
  response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(data));
});
fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
const port = Number(process.env.NATIVE_TEST_PORT || 4334);
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", process.env.NATIVE_TEST_PRODUCTION ? "start" : "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: root, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", KLAUD_ORIGIN: `http://127.0.0.1:${fixture.address().port}`, KLAUD_PORT: String(port), KLAUD_BIND_HOST: "127.0.0.1", KLAUD_TRUST_AUTH_PROXY: "0" }, stdio: ["ignore", "pipe", "pipe"],
});
let logs = ""; server.stdout.on("data", chunk => { logs += chunk; }); server.stderr.on("data", chunk => { logs += chunk; });
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    if (await fetch(origin).then(response => response.ok).catch(() => false)) break;
    if (i === 99) throw new Error(`Next did not become ready: ${logs}`);
    await delay(300);
  }
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  async function open(protocolVersion, handler = true) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    await page.route("**/api/**", route => route.fulfill({ json: { routines: [], skills: [] } }));
    await page.addInitScript(({ protocolVersion, handler, capability }) => {
      localStorage.setItem("rein.klaud.setup-seen", "1"); localStorage.setItem("rein.klaud.rain-enabled", "false");
      window.__nativeMessages = [];
      if (protocolVersion === 99) window.crypto.randomUUID = undefined; // Insecure LAN browser: no native nonce is needed.
      window.klaudNative = { inApp: true, protocolVersion, capabilities: [capability], documentNonce: "fixture-document" };
      if (handler) window.webkit = { messageHandlers: { klaud: { postMessage: message => window.__nativeMessages.push(message) } } };
    }, { protocolVersion, handler, capability: NATIVE_COMPOSER_CAPABILITY });
    await page.goto(origin);
    await page.locator(".chat-heading h1").filter({ hasText: bot.name }).waitFor({ state: "attached", timeout: 10000 }).catch(async error => { console.error(await page.locator("body").innerText()); throw error; });
    return page;
  }
  const page = await open(NATIVE_COMPOSER_VERSION);
  await delay(300);
  const initial = await page.evaluate(() => window.__nativeMessages);
  const hello = initial.find(message => message.action === "hello" && message.botId === bot.id);
  assert(hello?.requestId, "native activation requires a scoped hello, not just a capability advertisement");
  assert.equal(await page.getByRole("textbox", { name: "Operator input" }).count(), 1, "keep web input until native acknowledges readiness");
  const command = async detail => page.evaluate(detail => window.dispatchEvent(new CustomEvent("klaud-native-composer-command", { detail })), { protocolVersion: NATIVE_COMPOSER_VERSION, documentNonce: "fixture-document", botId: bot.id, sessionId: bot.sessionId, ...detail });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("textbox", { name: "Operator input" }).fill("typed during handshake");
  await command({ action: "ready", requestId: hello.requestId, documentNonce: "old-document" });
  assert.equal(await page.getByRole("textbox", { name: "Operator input" }).count(), 1, "a different document cannot claim the web editor");
  await command({ action: "ready", requestId: "stale-hello" });
  assert.equal(await page.getByRole("textbox", { name: "Operator input" }).count(), 1, "a stale hello acknowledgement cannot hide web input");
  await command({ action: "ready", requestId: hello.requestId });
  await page.waitForFunction(() => !document.querySelector(".crt-input"));
  assert.equal(await page.locator(".field-kb").count(), 0, "native mode must remove the old DOM CRT keyboard too");
  const handoff = await page.evaluate(() => window.__nativeMessages.filter(message => message.action === "state" && message.visible).at(-1));
  assert.equal(handoff.draft, "typed during handshake");
  assert(handoff.webRevision > 0, "handoff must distinguish user edits from native echoes");
  await page.setViewportSize({ width: 390, height: 844 });
  await command({ action: "draft", revision: 1, text: "exact native text" });
  await page.waitForFunction(() => window.__nativeMessages.some(message => message.action === "draftAck" && message.accepted));
  await command({ action: "send", revision: 1, requestId: "send-1", text: "exact native text" });
  for (let i = 0; !stream && i < 100; i++) await delay(50);
  assert(stream, "native send must reach the existing harness path");
  assert.equal(await page.evaluate(() => window.__nativeMessages.some(message => message.action === "sendAck")), false, "do not acknowledge before RUN_STARTED");
  emit({ type: "RUN_STARTED", runId: "00000000-0000-4000-8000-000000000015" });
  await page.waitForFunction(() => window.__nativeMessages.some(message => message.action === "sendAck" && message.requestId === "send-1" && message.accepted));
  assert.equal(stream.writableEnded, false, "acknowledge acceptance before the entire run finishes");
  assert.equal(records.find(record => record.path === "/run").body.message, "exact native text");
  assert.equal(records.find(record => record.path === "/run").body.threadId, bot.sessionId);
  await command({ action: "send", revision: 1, requestId: "stale-scope", sessionId: "old-session", text: "must not send" });
  await page.waitForFunction(() => window.__nativeMessages.some(message => message.requestId === "stale-scope" && message.accepted === false));
  await command({ action: "stop", requestId: "stop-1" });
  await page.waitForFunction(() => window.__nativeMessages.some(message => message.action === "stopAck" && message.accepted));
  await delay(150);
  assert(records.some(record => record.path === "/runs/00000000-0000-4000-8000-000000000015/cancel"), "native stop must use the existing cancel endpoint");
  rejectNextRun = true;
  await command({ action: "draft", revision: 3, text: "retain rejected send" });
  await page.waitForFunction(() => window.__nativeMessages.some(message => message.action === "draftAck" && message.revision === 3 && message.accepted));
  await command({ action: "send", revision: 3, requestId: "reject-1", text: "retain rejected send" });
  await page.waitForFunction(() => window.__nativeMessages.some(message => message.action === "sendAck" && message.requestId === "reject-1" && message.accepted === false));
  await page.waitForFunction(() => window.__nativeMessages.filter(message => message.action === "state" && message.visible).at(-1)?.draft === "retain rejected send");
  await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL("../test-results/native-composer.png", import.meta.url)) });
  async function choose(page, target) {
    await page.locator("button.bot").filter({ hasText: target.name }).first().click();
    await page.locator(".chat-heading h1").filter({ hasText: target.name }).waitFor({ state: "attached" });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await command({ action: "draft", revision: 7, text: "native A only" });
  await page.waitForFunction(() => window.__nativeMessages.some(message => message.action === "draftAck" && message.revision === 7 && message.accepted));
  await choose(page, secondBot);
  assert.equal(await page.getByRole("textbox", { name: "Operator input" }).count(), 0, "a confirmed native transport must not reopen an editable web composer during a bot switch");
  await page.waitForFunction(id => window.__nativeMessages.some(message => message.action === "state" && message.botId === id && message.draft === ""), secondBot.id);
  await command({ action: "draft", botId: secondBot.id, sessionId: secondBot.sessionId, revision: 8, text: "native B only" });
  await page.waitForFunction(() => window.__nativeMessages.some(message => message.action === "draftAck" && message.revision === 8 && message.accepted));
  await choose(page, bot);
  await page.waitForFunction(id => window.__nativeMessages.filter(message => message.action === "state" && message.visible).at(-1)?.botId === id && window.__nativeMessages.filter(message => message.action === "state" && message.visible).at(-1)?.draft === "native A only", bot.id);
  await command({ action: "draft", revision: 6, text: "stale native text" });
  await page.waitForFunction(() => window.__nativeMessages.some(message => message.action === "draftAck" && message.revision === 6 && message.accepted === false));
  const beforeRenegotiation = await page.evaluate(() => window.__nativeMessages.filter(message => message.action === "hello").length);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.dispatchEvent(new Event("klaud-native-ready")));
  await page.waitForFunction(before => window.__nativeMessages.filter(message => message.action === "hello").length > before, beforeRenegotiation, { timeout: 1500 });
  await page.getByRole("textbox", { name: "Operator input" }).fill("");
  const resumedHello = await page.evaluate(() => window.__nativeMessages.filter(message => message.action === "hello").at(-1));
  await command({ action: "ready", requestId: resumedHello.requestId });
  await page.waitForFunction(() => !document.querySelector(".crt-input"));
  const deletion = await page.evaluate(() => window.__nativeMessages.filter(message => message.action === "state" && message.visible).at(-1));
  assert.equal(deletion.draft, "");
  assert(deletion.webRevision > handoff.webRevision, "explicit deletion during renegotiation must supersede the native cache");
  await page.evaluate(() => window.dispatchEvent(new Event("klaud-native-ready")));
  await page.getByRole("textbox", { name: "Operator input" }).fill("é".repeat(70000));
  const oversizedHello = await page.evaluate(() => window.__nativeMessages.filter(message => message.action === "hello").at(-1));
  await command({ action: "ready", requestId: oversizedHello.requestId });
  assert.equal(await page.getByRole("textbox", { name: "Operator input" }).count(), 1, "an over-limit UTF-8 draft must remain editable in the fallback");
  await page.getByRole("textbox", { name: "Operator input" }).fill("trimmed draft");
  await page.waitForFunction(id => window.__nativeMessages.filter(message => message.action === "hello").at(-1)?.requestId !== id, oversizedHello.requestId);
  const trimmedHello = await page.evaluate(() => window.__nativeMessages.filter(message => message.action === "hello").at(-1));
  await command({ action: "ready", requestId: trimmedHello.requestId });
  await page.waitForFunction(() => !document.querySelector(".crt-input"));
  state.bots = [];
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await page.waitForFunction(() => window.__nativeMessages.filter(message => message.action === "state").at(-1)?.visible === false, null, { timeout: 1500 });
  const beforeScopeLessNavigation = await page.evaluate(() => window.__nativeMessages.filter(message => message.action === "hello").length);
  await page.evaluate(() => window.dispatchEvent(new Event("klaud-native-ready")));
  state.bots = [bot, secondBot];
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await page.waitForFunction(before => window.__nativeMessages.filter(message => message.action === "hello").length > before, beforeScopeLessNavigation, { timeout: 1500 });
  const restoredHello = await page.evaluate(() => window.__nativeMessages.filter(message => message.action === "hello").at(-1));
  await command({ action: "ready", requestId: restoredHello.requestId });
  await page.waitForFunction(() => !document.querySelector(".crt-input"));
  for (const [version, handler] of [[99, true], [1, true], [NATIVE_COMPOSER_VERSION, false]]) {
    const fallback = await open(version, handler);
    assert.equal(await fallback.getByRole("textbox", { name: "Operator input" }).count(), 1, "unsupported or missing bridge must retain the web editor");
    await fallback.setViewportSize({ width: 1280, height: 900 });
    const input = fallback.getByRole("textbox", { name: "Operator input" });
    await input.fill("web A only");
    await choose(fallback, secondBot);
    assert.equal(await input.inputValue(), "", "web fallback must not expose A's draft to B");
    await input.fill("web B only");
    await choose(fallback, bot);
    assert.equal(await input.inputValue(), "web A only", "returning to A must restore A's own draft");
    const beforeSend = records.filter(record => record.path === "/run").length;
    await input.evaluate(input => input.form.requestSubmit());
    for (let i = 0; records.filter(record => record.path === "/run").length === beforeSend && i < 30; i++) await delay(50);
    assert.equal(records.filter(record => record.path === "/run").length, beforeSend + 1, "fallback send must work without crypto.randomUUID");
    emit({ type: "RUN_STARTED", runId: "00000000-0000-4000-8000-000000000016" });
    emit({ type: "RUN_FINISHED", runId: "00000000-0000-4000-8000-000000000016" }); stream.end();
    await fallback.waitForFunction(() => !document.querySelector(".stop-run"));
    await input.fill("web A only");
    const oldSession = bot.sessionId;
    bot.sessionId = "replacement-session";
    await fallback.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    await fallback.waitForFunction(() => document.querySelector(".crt-input")?.value === "");
    bot.sessionId = oldSession;
    await fallback.close();
  }
  console.log(JSON.stringify({ result: "PASS", checks: ["current UI bridge activation", "one composer/keyboard", "draft ack", "send accepted at RUN_STARTED", "scope rejection", "native cancellation", "native bot switch without editable fallback", "bot/session-scoped web drafts", "unsupported/missing bridge fallback"], runRequests: records.filter(record => record.path === "/run").length }));
} catch (error) { console.error(logs.slice(-3000)); throw error; }
finally {
  await browser?.close(); stream?.destroy(); fixture.closeAllConnections(); fixture.close();
  server.kill("SIGTERM"); await once(server, "exit").catch(() => {});
}

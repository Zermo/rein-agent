import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// This fixture is a test backend, never a replacement for the harness or a live identity.
const root = fileURLToPath(new URL("../", import.meta.url));
const bot = { id: "klaud-bot-1234abcd", name: "Fixture unit", sessionId: "fixture-session", created: "2026-01-01T00:00:00.000Z", computer: "local", engine: "openai-compat", cwd: "/fixture/workspace", avatar: "aviator" };
let state = { shell: { version: 1, theme: { accent: "rain", density: "regular", dark: true }, chrome: { sidebar: true, tray: "normal", showActivity: true } }, prefs: { lastBotId: bot.id }, bots: [bot], approvals: [] };
let settings = { bashApproval: "ask", reasoningEffort: "default" };
const longReply = "The complete field report remains in the ledger. ".repeat(45);
const history = [{ id: "user-1", role: "user", content: "Prepare a field report." }, { id: "reply-1", role: "assistant", content: longReply, toolCalls: [{ id: "tool-old", function: { name: "read", arguments: '{"path":"report.txt"}' } }] }, { id: "result-old", role: "tool", toolCallId: "tool-old", content: "Workspace inspected." }];
const records = [], streams = new Map();
const json = (response, value, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
const emit = (response, event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
let runCount = 0;
const fixture = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture.invalid");
  let body; if (request.method !== "GET") { const chunks = []; for await (const chunk of request) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
  records.push({ path: url.pathname, query: url.search, method: request.method, body });
  if (url.pathname === "/health") return json(response, { ok: true, name: "rein-klaud" });
  if (url.pathname === "/state") {
    if (body) for (const patch of body.patch) { const [, section, key] = patch.path.split("/"); state.shell[section][key] = patch.value; }
    return json(response, state);
  }
  if (url.pathname === "/bots") {
    if (body) { assert.deepEqual(Object.keys(body), ["name"]); const unit = { ...bot, id: "klaud-bot-5678abcd", name: body.name, sessionId: "fixture-second" }; state.bots.push(unit); return json(response, unit, 201); }
    return json(response, state.bots);
  }
  if (request.method === "PATCH" && /^\/bots\/[^/]+$/.test(url.pathname)) { const unit = state.bots.find(item => url.pathname.endsWith(item.id)); unit.avatar = body.avatar; return json(response, unit); }
  if (url.pathname === "/prefs") { state.prefs.lastBotId = body.value; return json(response, state); }
  if (url.pathname === "/settings") { if (body) settings = { ...settings, ...body }; return json(response, settings); }
  if (url.pathname === "/activity") return json(response, { autonomy: { status: "inactive" } });
  if (url.pathname.endsWith("/messages")) return json(response, { messages: history, before: null });
  if (url.pathname.endsWith("/inspect-list")) return json(response, { files: [
    { path: "report.txt", kind: "text", size: 25, mtime: 1 }, { path: "missing.txt", kind: "text", size: 5, mtime: 2 },
    { path: "latest.svg", kind: "image", size: 150, mtime: 3 }, { path: "preview.html", kind: "html", size: 100, mtime: 4 }
  ] });
  if (url.pathname.endsWith("/inspect")) {
    const path = url.searchParams.get("path");
    if (path === "missing.txt") return json(response, { error: "Inspect file is missing." }, 404);
    const text = path === "latest.svg" ? '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#12100e"/><text x="5" y="30" fill="#f4ead4">Field proof</text></svg>' : path === "preview.html" ? '<h1>Sandboxed report</h1><img src="https://example.invalid/beacon"><script>parent.document.body.dataset.compromised="yes"</script>' : "CRT cream ink stays readable.";
    response.writeHead(200, { "Content-Type": path === "latest.svg" ? "image/svg+xml" : path === "preview.html" ? "text/html" : "text/plain", "X-Inspect-Path": path }); response.end(text); return;
  }
  if (url.pathname === "/run") {
    assert.equal(body.threadId, state.bots.find(item => item.id === body.botId).sessionId);
    const id = `00000000-0000-4000-8000-${String(++runCount).padStart(12, "0")}`;
    streams.set(id, response); response.writeHead(200, { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" }); response.flushHeaders();
    emit(response, { type: "RUN_STARTED", runId: id }); emit(response, { type: "STATE_SNAPSHOT", snapshot: state });
    emit(response, { type: "CUSTOM", name: "klaud.progress", value: { phase: "thinking", turn: 1 } });
    if (runCount > 1) return;
    emit(response, { type: "CUSTOM", name: "klaud.frontend_tool", value: { runId: id, toolCallId: "front-patch", toolName: "patchShell", args: { patch: [{ op: "replace", path: "/theme/density", value: "compact" }] } } });
    return;
  }
  const action = /^\/runs\/([^/]+)\/(cancel|tools\/([^/]+)|approvals\/([^/]+))$/.exec(url.pathname);
  if (action) {
    const stream = streams.get(action[1]);
    if (!stream) return json(response, { error: "No run" }, 404);
    if (action[2] === "cancel") { emit(stream, { type: "RUN_ERROR", message: "Run cancelled." }); stream.end("data: [DONE]\n\n"); }
    else if (action[3] === "front-patch") emit(stream, { type: "CUSTOM", name: "klaud.frontend_tool", value: { runId: action[1], toolCallId: "front-confirm", toolName: "confirmAction", args: { action: "Review the fixture report?" } } });
    else if (action[3] === "front-confirm") emit(stream, { type: "CUSTOM", name: "klaud.approval", value: { runId: action[1], id: "approval-write", tool: "write", summary: "Write fixture report" } });
    else if (action[4]) {
      assert.equal(body.allow, true);
      emit(stream, { type: "TOOL_CALL_START", toolCallId: "write-one", toolCallName: "write" });
      emit(stream, { type: "TOOL_CALL_RESULT", toolCallId: "write-one", content: "Saved report.txt" });
      emit(stream, { type: "TEXT_MESSAGE_START", messageId: "live-answer" });
      emit(stream, { type: "TEXT_MESSAGE_CONTENT", messageId: "live-answer", delta: "Streamed answer. ".repeat(100) });
      setTimeout(() => { emit(stream, { type: "TEXT_MESSAGE_CONTENT", messageId: "live-answer", delta: " Showing `latest.svg`." }); emit(stream, { type: "TEXT_MESSAGE_END", messageId: "live-answer" }); emit(stream, { type: "RUN_FINISHED", runId: action[1] }); stream.end("data: [DONE]\n\n"); }, 150);
    }
    return json(response, { ok: true });
  }
  json(response, { error: "Not found" }, 404);
});

await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const port = 4324, origin = `http://127.0.0.1:${port}`;
const next = spawn(process.execPath, [root + "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: root, env: { ...process.env, KLAUD_ORIGIN: `http://127.0.0.1:${fixture.address().port}`, KLAUD_PORT: String(port), KLAUD_SANDBOX_ORIGIN: origin, KLAUD_TRUST_AUTH_PROXY: "0", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"]
});
let serverLog = ""; next.stdout.on("data", chunk => serverLog += chunk); next.stderr.on("data", chunk => serverLog += chunk);
let browser, page;
const proof = [];
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) break; } catch {} if (i === 99) throw new Error(serverLog); await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const path of ["/", "/index.html", "/browser.js", "/renderer.js", "/styles.css", "/tokens.css", "/setup.css", "/avatars.css", "/icon.svg", "/icon.png", "/favicon.ico", "/rein-logo.svg", "/rein-field-guide-card.jpg", "/health"]) assert.equal((await fetch(origin + path, { redirect: "manual" })).status, 200, `${path} stays public`);
  // Node26 fetch may normalize Host. Use raw Node HTTP for the spoof proof.
  const spoofStatus = await new Promise((resolve, reject) => { const request = httpRequest(origin + "/", { headers: { host: "attacker.invalid" } }, response => { response.resume(); resolve(response.statusCode); }); request.on("error", reject); request.end(); });
  assert.equal(spoofStatus, 403);
  assert.equal((await fetch(origin + "/icon.svg", { headers: { origin: "https://attacker.invalid" } })).status, 403);
  proof.push("Production middleware rejects bad Host/Origin; every named static asset and health is public");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  const errors = [], beacons = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("https://example.invalid/**", route => { beacons.push(route.request().url()); return route.abort(); });
  await page.goto(origin); await page.getByRole("heading", { name: "Fixture unit", exact: true }).waitFor();
  assert.equal(await page.title(), "klaʊdbot");
  assert.equal(await page.locator(".message-text").last().textContent(), longReply);
  assert(await page.locator(".reply-fold").getAttribute("open") !== null);
  assert(await page.locator(".transcript").evaluate(el => getComputedStyle(el).overflowY === "auto"));
  assert(await page.locator(".transcript").evaluate(el => el.nextElementSibling?.classList.contains("composer")));
  proof.push("Title, full long replies, native reply folding, ledger→composer, scrolling");
  await page.locator(".path-open").first().click();
  await page.locator(".turn-node").first().waitFor();
  assert.deepEqual(await page.locator(".turn-node strong").allTextContents(), ["You", "read", "Reply"]);
  assert(await page.locator(".turn-graph").evaluate(el => getComputedStyle(el).borderLeftWidth === "2px" || getComputedStyle(el, "::before").width === "2px"));
  await page.locator(".turn-node").nth(1).click(); assert(await page.locator(".turn-node").nth(1).evaluate(el => el.classList.contains("on")));
  await page.mouse.move(300, 100);
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".turn-node.on strong").evaluate(el => getComputedStyle(el).color), "rgb(18, 16, 14)");
  await mkdir(root + "test-results", { recursive: true }); await page.screenshot({ path: root + "test-results/path-desktop.png" });
  proof.push("Path timeline: You→tool→Reply, 2px spine and selected-node inversion");
  await page.getByRole("button", { name: /03 Computer/ }).click();
  await page.getByRole("button", { name: "Take hold", exact: true }).click();
  await page.locator(".desktop-icon").filter({ hasText: "report.txt" }).click();
  await page.getByText("CRT cream ink stays readable.").waitFor();
  assert.equal(await page.locator(".inspect-text").evaluate(el => getComputedStyle(el).color), "rgb(244, 234, 212)");
  await page.getByRole("button", { name: "Close file inspection" }).click();
  await page.locator(".desktop-icon").filter({ hasText: "missing.txt" }).click(); await page.getByText("Could not open this file.").waitFor();
  assert.equal(await page.locator(".signal-fault").count(), 0);
  await page.screenshot({ path: root + "test-results/crt-inspect-error.png" });
  await page.getByRole("button", { name: "Close file inspection" }).click();
  await page.locator(".desktop-icon").filter({ hasText: "preview.html" }).click(); await page.locator(".inspect-preview iframe").waitFor();
  assert.equal(await page.locator("iframe").getAttribute("sandbox"), ""); await page.waitForTimeout(100); assert.equal(await page.locator("body").getAttribute("data-compromised"), null); assert.deepEqual(beacons, []);
  await page.getByRole("button", { name: "Release", exact: true }).click(); assert(await page.locator(".desktop-icon").first().isDisabled());
  proof.push("CRT ink, take/release, window close, isolated misses and sandboxed HTML");
  await page.locator(".composer textarea").fill("Fixture instruction"); await page.getByRole("button", { name: /Transmit/ }).click();
  await page.getByText("Review the fixture report?").first().waitFor();
  assert.equal(await page.locator(".message-text").filter({ hasText: /^Fixture instruction$/ }).count(), 1);
  await page.locator(".approvals").getByRole("button", { name: "Allow", exact: true }).click();
  await page.getByText("Write fixture report").first().waitFor(); await page.locator(".approvals").getByRole("button", { name: "Whitelist", exact: true }).click();
  await page.getByRole("button", { name: /Transmit/ }).waitFor(); await page.locator(".inspect-preview img").waitFor();
  assert.equal(records.filter(record => record.query.includes("latest.svg") && record.path.endsWith("/inspect")).length, 1);
  assert.equal(await page.locator(".message-text").filter({ hasText: /^Fixture instruction$/ }).count(), 1);
  assert((await page.locator(".message-text").last().textContent()).length > 1500);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("rein.klaud.approve")).remember), true);
  proof.push("Live SSE, frontend shell patch/confirm, approval Whitelist persistence, local IDs, single visual auto-open");
  await page.locator(".composer textarea").fill("Cancellable fixture"); await page.locator(".composer textarea").press("Enter");
  await page.locator(".masthead .activity").filter({ hasText: "Thinking" }).waitFor();
  await page.getByRole("button", { name: "Stop run" }).click(); await page.getByRole("button", { name: /Transmit/ }).waitFor();
  for (let i = 0; i < 40 && !records.some(record => record.path.endsWith("/cancel")); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert(records.some(record => record.path.endsWith("/cancel"))); proof.push("POST cancellation without a false fault banner");
  await page.getByRole("button", { name: /04 Settings/ }).click();
  await page.getByLabel("Night console", { exact: false }).click(); await page.waitForFunction(() => document.documentElement.dataset.dark === "false");
  await page.getByRole("button", { name: /03 Computer/ }).click();
  await page.getByRole("button", { name: "Take hold", exact: true }).click();
  await page.getByRole("button", { name: "Close file inspection" }).click();
  await page.locator(".desktop-icon").filter({ hasText: "report.txt" }).click(); await page.getByText("CRT cream ink stays readable.").waitFor();
  assert.equal(await page.locator(".inspect-text").evaluate(el => getComputedStyle(el).color), "rgb(244, 234, 212)");
  await page.getByRole("button", { name: /04 Settings/ }).click();
  await page.getByLabel("Show agent rail", { exact: false }).click(); await page.waitForFunction(() => document.querySelector(".workspace")?.classList.contains("no-agent-rail")); assert.equal(await page.locator(".context-rail").count(), 1);
  await page.getByRole("button", { name: /Assisted setup/ }).click(); await page.getByRole("button", { name: "Keep existing model" }).click(); await page.getByRole("button", { name: "Review starter" }).click();
  await page.getByRole("button", { name: "Save profile & open composer" }).click(); await page.locator(".composer textarea").waitFor(); assert((await page.locator(".composer textarea").inputValue()).length > 50);
  proof.push("Settings persist shell and local profile; wizard drafts without running");
  await page.getByRole("button", { name: /01 Bots/ }).click(); await page.getByRole("button", { name: /Add (agent|field unit|bot)/i }).first().click();
  await page.locator("dialog input[type=text], dialog input:not([type])").first().fill("Second fixture");
  await page.locator("dialog").getByRole("button", { name: /^Medic:/ }).click();
  await page.locator("dialog").getByRole("button", { name: "Add field unit", exact: true }).click();
  await page.getByRole("heading", { name: "Second fixture", exact: true }).waitFor();
  assert.deepEqual(records.find(record => record.path === "/bots" && record.method === "POST").body, { name: "Second fixture" });
  assert(records.some(record => record.method === "PATCH" && record.body.avatar === "medic")); proof.push("Bot name-only POST then avatar PATCH and preference selection");
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(100);
  assert(await page.locator(".context-rail").isVisible()); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: root + "test-results/mobile.png" }); proof.push("390px mobile: context rail visible, no horizontal page overflow");
  const publicPage = await browser.newPage();
  await publicPage.route("https://openbot.zermo.org/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/state") return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Fixture offline"}' });
    const response = await fetch(origin + url.pathname + url.search); const headers = Object.fromEntries(response.headers); delete headers["content-encoding"]; delete headers["transfer-encoding"];
    await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
  });
  await publicPage.goto("https://openbot.zermo.org/"); await publicPage.getByText("Fixture offline").waitFor();
  assert.equal(await publicPage.locator("input[type=password]").count(), 0); proof.push("Public-origin offline login has Authelia and no bearer field");
  await publicPage.route("https://auth.zermo.org/**", route => route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Fixture house login</h1>" }));
  await publicPage.getByRole("button", { name: "Sign in with Authelia" }).click();
  await publicPage.waitForURL("https://auth.zermo.org/?rd=https%3A%2F%2Fopenbot.zermo.org%2F");
  proof.push("Sign in navigates the window to fixed Authelia return URL");
  const redirectPage = await browser.newPage();
  await redirectPage.route("https://auth.zermo.org/**", route => route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Fixture house login</h1>" }));
  await redirectPage.route("https://openbot.zermo.org/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/state") return route.fulfill({ status: 302, headers: { location: "https://auth.zermo.org/" } });
    const response = await fetch(origin + url.pathname + url.search); const headers = Object.fromEntries(response.headers); delete headers["content-encoding"]; delete headers["transfer-encoding"];
    await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
  });
  await redirectPage.goto("https://openbot.zermo.org/");
  await redirectPage.waitForURL("https://auth.zermo.org/?rd=https%3A%2F%2Fopenbot.zermo.org%2F");
  proof.push("Direct public API 302 is not followed in fetch; the window opens Authelia");
  assert.deepEqual(errors, []);
  await writeFile(root + "test-results/browser-proof.json", JSON.stringify({ passed: proof, browserErrors: errors, backend: "isolated fixture only" }, null, 2));
  console.log(proof.map(item => `PASS ${item}`).join("\n"));
} catch (error) { console.error(serverLog); if (page) { console.error((await page.locator("body").innerText()).slice(0,8000)); await mkdir(root + "test-results", {recursive:true}); await page.screenshot({path: root + "test-results/failure.png"}); } console.error(records.slice(-12)); throw error; }
finally { await browser?.close(); next.kill("SIGTERM"); for (const stream of streams.values()) stream.destroy(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
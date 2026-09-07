import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { applyDelta, applyShellPatch, frontendTools, replayEvents, requestRoute, sseEvents, validateConnection, validateMessages, validateState } from "../model.mjs";
import { stopChild } from "../lifecycle.mjs";

const baseline = () => ({
  shell: { version: 1, theme: { accent: "rain", density: "regular", dark: true }, chrome: { sidebar: true, tray: "normal", showActivity: true } },
  prefs: {}, bots: [{ id: "klaud-bot-12345678", name: "Rain", sessionId: "session-1" }], approvals: [],
});

test("shell deltas validate atomically, including failed tests and prototype paths", () => {
  const original = baseline();
  const valid = [{ op: "replace", path: "/shell/theme/accent", value: "storm" }, { op: "replace", path: "/shell/chrome/tray", value: "quiet" }];
  assert.equal(applyDelta(original, valid).shell.theme.accent, "storm");
  assert.equal(original.shell.theme.accent, "rain");
  for (const bad of [
    [...valid, { op: "test", path: "/shell/theme/dark", value: false }],
    [...valid, { op: "replace", path: "/shell/theme/density", value: "enormous" }],
    [{ op: "replace", path: "/shell/__proto__/polluted", value: true }],
    [{ op: "replace", path: "/prefs/lastBotId", value: "another" }],
    [{ op: "remove", path: "/shell/chrome/sidebar" }],
  ]) assert.throws(() => applyDelta(original, bad));
  assert.deepEqual(original, baseline());
  assert.throws(() => validateState({ ...original, prefs: { token: "private" } }));
  assert.throws(() => validateState({ ...original, shell: { ...original.shell, theme: { ...original.shell.theme, dark: "false" } } }));
});

test("IPC routes cannot choose origins, headers, arbitrary endpoints, or path traversal", () => {
  assert.deepEqual(validateConnection("http://127.0.0.1:4317/", "runtime-token"), { url: "http://127.0.0.1:4317", token: "runtime-token" });
  for (const url of ["https://127.0.0.1:4317", "http://localhost:4317", "http://127.1:4317", "http://127.0.0.1", "http://127.0.0.1:4317/state", "http://127.0.0.1:4317/?x=1", "http://user@127.0.0.1:4317", "http://example.invalid:4317", "file:///tmp/state"]) assert.throws(() => validateConnection(url, "token"));
  assert.throws(() => validateConnection("http://127.0.0.1:4317", "bad\ntoken"));
  assert.throws(() => requestRoute("http://example.invalid"));
  for (const id of ["..", ".", "../state", "x/y", "%2e%2e", "?x"]) assert.throws(() => requestRoute("messages", { id }));
  assert.equal(requestRoute("messages", { id: "klaud-bot-12345678" }).path, "/bots/klaud-bot-12345678/messages");
  assert.equal(requestRoute("messages", { id: "klaud-bot-12345678", before: 100 }).path, "/bots/klaud-bot-12345678/messages?before=100");
  assert.throws(() => requestRoute("messages", { id: "klaud-bot-12345678", before: "../state" }));
  assert.deepEqual(requestRoute("setPref", { key: "lastBotId", value: "klaud-bot-12345678", headers: { Authorization: "ignored" } }).body, { key: "lastBotId", value: "klaud-bot-12345678" });
  assert.throws(() => requestRoute("createBot", { name: "a".repeat(65) }));
});

test("SSE handles chunk boundaries, UTF-8, CRLF, terminal markers, and malformed input", async () => {
  const data = new TextEncoder().encode('data: {"type":"TEXT_MESSAGE_CONTENT","delta":"klaʊd"}\r\n\r\ndata: [DONE]\r\n\r\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of data) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.deepEqual(await Array.fromAsync(sseEvents(stream)), [{ type: "TEXT_MESSAGE_CONTENT", delta: "klaʊd" }]);
  for (const text of ['data: {"type":"START"}', 'data: not-json\n\n', 'data: {"role":"assistant"}\n\n']) {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
    await assert.rejects(async () => { for await (const _ of sseEvents(stream)) {} });
  }
});

test("failed spawn and normal child shutdown resolve without an exit event", async () => {
  const failed = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null, signalCode: null, kill() { assert.fail("Failed spawn has no process to kill."); } });
  await stopChild(failed, 10);
  const signals = [];
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, kill(signal) { signals.push(signal); queueMicrotask(() => child.emit("close")); } });
  await stopChild(child, 10);
  assert.deepEqual(signals, ["SIGTERM"]);
});

// Evaluate the actual main functions with Electron startup disabled. No GUI or server starts.
async function mainHarness(ownsInstance = false, appOverrides = {}) {
  const sourceUrl = new URL("../main.mjs", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8").replace(/^import .*;\n/gm, "").replaceAll("import.meta.url", JSON.stringify(sourceUrl.href));
  const context = {
    app: { setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => ownsInstance, quit() {}, on() {}, whenReady: () => new Promise(() => {}), ...appOverrides },
    dirname, join, resolve, fileURLToPath, pathToFileURL, randomUUID, process: { ...process, env: {}, on() {} },
    applyDelta, applyShellPatch, frontendTools, replayEvents, requestRoute, sseEvents, validateConnection, validateMessages, validateState, stopChild,
    Buffer, AbortSignal, AbortController, setTimeout, clearTimeout, setImmediate, structuredClone, Map, Promise,
  };
  await vm.runInNewContext(`(async () => { ${source}\n globalThis.hooks = {
    connect, startRun, answerTool, trusted,
    configure(options) { if (options.stop) stopOwnedServe = options.stop; if (options.start) startLocal = options.start; if (options.json) json = options.json; if (options.http) http = options.http; if (options.tray) updateTray = options.tray; if (options.state) state = options.state; if (options.window) window = options.window; if (options.connection) connection = options.connection; },
    quit() { quitting = true; },
    current() { return { run: activeRun, state, sequence }; }
  }; })()`, context);
  return context.hooks;
}

test("ESM entry finishes loading before Electron emits ready", async () => {
  let timer;
  try {
    const hooks = await Promise.race([mainHarness(true), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Entry blocked Electron readiness")), 500); })]);
    assert.equal(typeof hooks.connect, "function");
  } finally { clearTimeout(timer); }
});

test("desktop chrome and package metadata consistently use the rein-klaʊd name", async () => {
  let nativeName;
  await mainHarness(false, { setName(value) { nativeName = value; } });
  assert.equal(nativeName, "rein-klaʊd", "the macOS application menu must not inherit Electron's name");

  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const metadata = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
  assert.equal(metadata.productName, "rein-klaʊd");
  assert.equal(metadata.build.productName, "rein-klaʊd");
  assert.match(readFileSync(join(appRoot, "index.html"), "utf8"), /<title>rein-klaʊd<\/title>/);

  const main = readFileSync(join(appRoot, "main.mjs"), "utf8");
  assert.match(main, /process\.title = "rein-klaʊd"/);
  assert.match(main, /new BrowserWindow\(\{[\s\S]*?title: "rein-klaʊd"/);
  assert.match(main, /label: "rein-klaʊd", submenu:/);
  assert.doesNotMatch(main, /label: "Electron"|title: "Electron"/);
});

test("immediate backend cleanup resumes native Quit on the next event-loop turn", async () => {
  let beforeQuit, quitCalls = 0, cleanupCalls = 0, prevented = 0;
  const event = { preventDefault() { prevented++; } };
  const hooks = await mainHarness(true, {
    on(name, handler) { if (name === "before-quit") beforeQuit = handler; },
    quit() { quitCalls++; beforeQuit(event); },
  });
  // CLI launches attach to an external backend, so cleanup resolves immediately.
  const cleanup = Promise.resolve();
  hooks.configure({ stop() { cleanupCalls++; return cleanup; } });
  beforeQuit(event);
  beforeQuit(event);
  await cleanup;
  assert.equal(cleanupCalls, 1, "repeated Quit cannot start another cleanup");
  assert.equal(quitCalls, 0, "resuming inside cleanup's microtask reenters the native macOS Quit operation");
  assert.equal(prevented, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quitCalls, 1, "Quit resumes after the original native operation has returned");
  assert.equal(prevented, 2, "the resumed before-quit event must allow shutdown");
});

test("Quit during connection cleanup cannot start a later owned server", async () => {
  const hooks = await mainHarness();
  let release, entered = 0, spawned = 0;
  hooks.configure({ stop: async () => { if (++entered === 1) await new Promise(resolve => { release = resolve; }); }, start: async () => { spawned++; } });
  const connecting = hooks.connect({ mode: "local" });
  await new Promise(resolve => setImmediate(resolve));
  hooks.quit(); release();
  await assert.rejects(connecting, /quitting/);
  assert.equal(spawned, 0);
});

test("run reload retains a pre-run baseline and replays only unresolved frontend actions", async () => {
  const hooks = await mainHarness(), state = baseline(), runId = "12345678-abcd-1234-abcd-123456789abc";
  const history = [{ id: "old-user", role: "user", content: "Earlier question" }, { id: "old-assistant", role: "assistant", content: "Earlier answer" }];
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const sent = [];
  hooks.configure({ state, connection: { url: "http://127.0.0.1:4317", token: "private" }, tray() {},
    window: { isDestroyed: () => false, webContents: { send(_channel, event) { sent.push(structuredClone(event)); } } },
    json: async (method, path) => path.endsWith("/messages") ? { messages: history } : path === "/state" ? state : { ok: true },
    http: async () => ({ headers: new Headers({ "content-type": "text/event-stream" }), body: stream }),
  });
  await hooks.startRun({ botId: state.bots[0].id, threadId: state.bots[0].sessionId, message: "Current question" });
  const push = event => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  push({ type: "RUN_STARTED", runId });
  push({ type: "STATE_SNAPSHOT", snapshot: state });
  push({ type: "TEXT_MESSAGE_CONTENT", messageId: "stream-1", delta: "Current answer" });
  push({ type: "CUSTOM", name: "klaud.frontend_tool", value: { runId, toolCallId: "call-1", toolName: "patchShell", args: { patch: [] } } });
  await new Promise(resolve => setImmediate(resolve));
  const run = hooks.current().run;
  assert.equal(run.baseline.length, 3);
  assert.equal(run.baseline.at(-1).content, "Current question");
  history.push({ id: "durable-current", role: "assistant", content: "Current answer" });
  assert.equal(run.baseline.length, 3, "durable writes after run start cannot enter the replay baseline");
  assert.equal(replayEvents(run).filter(event => event.type === "CUSTOM").length, 1);
  await hooks.answerTool({ runId, toolCallId: "call-1", result: "{}" });
  assert.equal(replayEvents(run).filter(event => event.type === "CUSTOM").length, 0, "acknowledged patch is never replayed");
  assert.ok(replayEvents(run).every(event => event.type !== "STATE_SNAPSHOT"));
  const capturedSequence = hooks.current().sequence;
  push({ type: "TEXT_MESSAGE_CONTENT", messageId: "stream-1", delta: " continued" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.filter(event => event.sequence > capturedSequence).length, 1, "sequence distinguishes live events from those captured by status");
  run.eventBytes = 8 * 1024 * 1024;
  push({ type: "CUSTOM", name: "klaud.frontend_tool", value: { runId, toolCallId: "call-2", toolName: "navigateTo", args: { dest: "chat" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.replayTruncated, true);
  assert.equal(run.events.length, 0);
  assert.equal(run.controller.signal.aborted, false, "the UI replay bound cannot stop the agent run");
  assert.equal(replayEvents(run)[0].value.toolCallId, "call-2", "pending actions remain available after replay truncation");
  push({ type: "TOOL_CALL_RESULT", toolCallId: "display-scope-call-2", providerToolCallId: "call-2", content: "Timed out" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replayEvents(run).length, 0, "expired frontend actions cannot reopen after reload");
  push({ type: "RUN_FINISHED", runId }); controller.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hooks.current().run, undefined);
});

test("IPC rejects subframes and a renderer navigated away from the packaged page", async () => {
  const hooks = await mainHarness();
  const frame = { url: new URL("../dist/index.html", import.meta.url).href };
  const contents = { mainFrame: frame };
  hooks.configure({ window: { webContents: contents } });
  hooks.trusted({ sender: contents, senderFrame: frame });
  assert.throws(() => hooks.trusted({ sender: contents, senderFrame: { url: frame.url } }), /Untrusted/);
  frame.url = "http://127.0.0.1:4317";
  assert.throws(() => hooks.trusted({ sender: contents, senderFrame: frame }), /Untrusted/);
});

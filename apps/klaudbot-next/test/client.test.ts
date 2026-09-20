import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, isPublicHost, KlaudApi, protectedHtml, safeInspectPath, sseEvents } from "../lib/api.ts";
import { DEFAULT_SHELL, groupTurns, latestPresentation, mergeHistory, updateTranscript } from "../lib/model.ts";
import type { AgEvent, Bot, Message } from "../lib/types.ts";

const bot: Bot = { id: "klaud-bot-1234abcd", name: "Fixture", created: "2026-01-01T00:00:00.000Z", sessionId: "fixture-session", computer: "local", engine: "openai-compat", avatar: "aviator" };
const state = { shell: DEFAULT_SHELL, prefs: { lastBotId: bot.id }, bots: [bot], approvals: [] };
const encoder = new TextEncoder();
const frames = (events: AgEvent[]) => events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
function stream(bytes: Uint8Array, piece = 1) { let offset = 0; return new ReadableStream<Uint8Array>({ pull(controller) { if (offset >= bytes.length) return controller.close(); controller.enqueue(bytes.slice(offset, offset += piece)); } }); }

test("all API rows use exact methods/payloads; bots create then avatar patch; run thread is sessionId", async () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    assert.equal(init?.credentials, "same-origin"); assert.equal(init?.redirect, "error");
    calls.push({ method: init?.method ?? "GET", path, body });
    if (path === "/run") return new Response(frames([{ type: "RUN_STARTED", runId: "run-1" }, { type: "RUN_FINISHED" }]), { headers: { "content-type": "text/event-stream" } });
    if (path.includes("inspect?")) return new Response("workspace", { headers: { "content-type": "text/plain" } });
    if (path.includes("inspect-list")) return Response.json({ files: [] });
    if (path.includes("messages")) return Response.json({ messages: [], before: null });
    if (path === "/bots" && init?.method === "GET") return Response.json([bot]);
    if (path === "/bots" || init?.method === "PATCH") return Response.json(bot);
    if (path === "/settings") return Response.json({ bashApproval: "always", reasoningEffort: "default" });
    if (path === "/activity") return Response.json({ autonomy: { status: "inactive" } });
    if (path === "/health") return Response.json({ ok: true, name: "rein-klaud" });
    return Response.json(state);
  }) as typeof fetch;
  const api = new KlaudApi("", fake);
  await Promise.all([api.health(), api.state(), api.bots(), api.settings(), api.activity()]);
  await api.createBot(" Fixture "); await api.avatar(bot.id, "medic"); await api.pref(bot.id);
  await api.patchShell([{ op: "replace", path: "/theme/dark", value: false }]); await api.saveSettings({ reasoningEffort: "high" });
  await api.inspectList(bot.id); await api.inspect(bot.id, "folder/space name.md"); await api.messages(bot.id, 10);
  await api.run(bot, "hello", new AbortController().signal, () => {});
  await api.cancel("run-1"); await api.approve("run-1", "approval:1", false); await api.toolResult("run-1", "tool:1", "done");
  assert.deepEqual(calls.find(call => call.path === "/bots" && call.method === "POST")?.body, { name: "Fixture" });
  assert.deepEqual(calls.find(call => call.method === "PATCH")?.body, { avatar: "medic" });
  assert.deepEqual(calls.find(call => call.path === "/prefs")?.body, { key: "lastBotId", value: bot.id });
  assert(calls.some(call => call.path.endsWith("/inspect?path=folder%2Fspace%20name.md")));
  const run = calls.find(call => call.path === "/run")?.body as { threadId: string; tools: { name: string }[] };
  assert.equal(run.threadId, bot.sessionId); assert.deepEqual(run.tools.map(tool => tool.name), ["patchShell", "setPref", "navigateTo", "confirmAction"]);
  assert.deepEqual(calls.find(call => call.path.includes("/approvals/"))?.body, { allow: false });
});
test("SSE handles byte-split CRLF, UTF-8 and multiline data, ignores keepalive comments", async () => {
  const raw = ': heartbeat\r\n\r\ndata: {"type":"TEXT_MESSAGE_CONTENT",\r\ndata: "delta":"klaʊdbot ☔"}\r\n\r\n' + frames([{ type: "RUN_FINISHED" }]);
  const result = []; for await (const event of sseEvents(stream(encoder.encode(raw)))) result.push(event);
  assert.equal(result[0].delta, "klaʊdbot ☔"); assert.equal(result.length, 2);
});
test("SSE rejects malformed, oversized and prematurely disconnected runs", async () => {
  const consume = async (raw: string) => { for await (const event of sseEvents(stream(encoder.encode(raw), 50000))) void event; };
  await assert.rejects(consume('data: {"type":"RUN_STARTED"}\n\n'), /before completion/);
  await assert.rejects(consume("data: [DONE]\n\n"), /terminal/);
  await assert.rejects(consume("data: {}\n\n"), /Invalid/);
  await assert.rejects(consume("data: " + "x".repeat(2100000)), /too large/);
});
test("query-first inspect basename retry retains spaces, no legacy suffix fallback", async () => {
  const paths: string[] = [];
  const api = new KlaudApi("", (async (input: string) => { paths.push(input); return paths.length === 1 ? Response.json({ error: "missing" }, { status: 404 }) : new Response("ok"); }) as typeof fetch);
  const doc = await api.inspect(bot.id, "folder/space name.txt");
  assert.equal(doc.text, "ok"); assert(paths[1].endsWith("?path=space%20name.txt")); assert(!paths.some(path => path.includes("/inspect/")));
});
test("inspect rejects traversal, secrets, keys, unknown extensions and >5MiB", async () => {
  for (const path of ["../a.png", "dir/../a.txt", ".env", ".env.json", "secret.json", "serve-token.txt", "private.key.json", "keys.json", "id_rsa.txt", "/outside.png", "file.pdf"]) assert.throws(() => safeInspectPath(path));
  const api = new KlaudApi("", (async () => new Response("a", { headers: { "content-length": String(5 * 1024 * 1024 + 1) } })) as typeof fetch);
  await assert.rejects(api.inspect(bot.id, "large.png"), /5 MiB/);
});
test("only exact public hostname hides bearer; auth errors are distinct from network errors", async () => {
  assert(isPublicHost("openbot.zermo.org")); assert(!isPublicHost("openbot.zermo.org.attacker.test"));
  const api = new KlaudApi("", (async () => Response.json({ error: "auth_required" }, { status: 401 })) as typeof fetch);
  await assert.rejects(api.state(), error => error instanceof ApiError && error.authRequired);
});
test("loadMessages preserves empty active assistant and local user; stream targets placeholder", () => {
  const saved: Message[] = [{ id: "old", role: "assistant", content: "previous" }];
  const local: Message[] = [...saved, { id: "local-user", role: "user", content: "new", local: true, pending: true }, { id: "placeholder", role: "assistant", content: "", local: true, pending: true }];
  const merged = mergeHistory(local, saved);
  assert.deepEqual(merged.map(item => item.id), ["old", "local-user", "placeholder"]);
  const started = updateTranscript(merged, { type: "TEXT_MESSAGE_START", messageId: "sse-id" });
  assert.equal(started.length, 3); assert.equal(started[2].id, "sse-id");
  const content = updateTranscript(started, { type: "TEXT_MESSAGE_CONTENT", messageId: "sse-id", delta: "full answer" });
  assert.equal(content[2].content, "full answer");
});
test("history reconciliation retains full long reply and local identity without duplicates", () => {
  const local: Message[] = [{ id: "local-reply", role: "assistant", content: "answer".repeat(1000), local: true, pending: false }];
  const same: Message[] = [{ id: "durable-id", role: "assistant", content: local[0].content }];
  assert.deepEqual(mergeHistory(local, same).map(item => item.id), ["local-reply"]);
  const truncated: Message[] = [{ ...same[0], content: local[0].content.slice(0, 100) + "\n[Preview shortened; full text remains in session history.]", truncated: true }];
  assert.equal(mergeHistory(local, truncated)[0].content.length, 6000);
});
test("delayed history while running aliases pending user id after shared anchor", () => {
  const local: Message[] = [{ id: "old", role: "user", content: "hello" }, { id: "new-local", role: "user", content: "hello", local: true, pending: true }, { id: "placeholder", role: "assistant", content: "", local: true, pending: true }];
  const saved: Message[] = [{ id: "old", role: "user", content: "hello" }, { id: "new-durable", role: "user", content: "hello" }];
  const first = mergeHistory(local, saved);
  assert.deepEqual(first.map(item => item.id), ["old", "new-local", "placeholder"]);
  assert.equal(first[1].persistedId, "new-durable");
  assert.deepEqual(mergeHistory(first, saved).map(item => item.id), ["old", "new-local", "placeholder"]);
});
test("refreshing the latest page preserves already-loaded earlier history order", () => {
  const local: Message[] = [{ id: "u1", role: "user", content: "one" }, { id: "a1", role: "assistant", content: "first" }, { id: "u2", role: "user", content: "two" }, { id: "a2", role: "assistant", content: "second" }];
  assert.deepEqual(mergeHistory(local, local.slice(2)).map(item => item.id), ["u1", "a1", "u2", "a2"]);
});
test("multiple streamed text blocks within one assistant turn match joined durable text", () => {
  let rows: Message[] = [];
  for (const [id, text] of [["run:0:0", "First part"], ["run:0:1", "Second part"]]) {
    rows = updateTranscript(rows, { type: "TEXT_MESSAGE_START", messageId: id });
    rows = updateTranscript(rows, { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text });
    rows = updateTranscript(rows, { type: "TEXT_MESSAGE_END", messageId: id });
  }
  assert.equal(rows.length, 1); assert.equal(rows[0].content, "First part\nSecond part");
  const merged = mergeHistory(rows, [{ id: "durable", role: "assistant", content: "First part\nSecond part" }]);
  assert.equal(merged.length, 1); assert.equal(merged[0].id, "run:0:0");
});
test("blob HTML carries an early restrictive network CSP", () => {
  const html = protectedHtml('<img src="https://example.invalid/beacon"><script>bad()</script>');
  assert(html.startsWith('<meta http-equiv="Content-Security-Policy"')); assert(html.includes("default-src 'none'")); assert(html.includes("base-uri 'none'"));
});
test("Path is You → paired tools → Reply; snippets capped, chat untouched", () => {
  const messages: Message[] = [{ id: "u", role: "user", content: "Build" }, { id: "a", role: "assistant", content: "answer".repeat(300), toolCalls: [{ id: "t", function: { name: "bash", arguments: "ls" } }] }, { id: "r", role: "tool", toolCallId: "t", content: "done" }];
  const turns = groupTurns(messages);
  assert.deepEqual(turns[0].nodes.map(item => item.label), ["You", "bash", "Reply"]);
  assert.equal(turns[0].nodes[2].text.length, 500); assert.equal(messages[1].content.length, 1800);
});
test("auto-open one newest png/svg/html only, never user md/json references", () => {
  const messages: Message[] = [{ id: "1", role: "user", content: "open private.png" }, { id: "2", role: "assistant", content: "Saved `older.svg`, then `report with spaces.html` and `notes.md`." }];
  assert.equal(latestPresentation(messages), "report with spaces.html");
  assert.equal(latestPresentation([{ id: "a", role: "assistant", content: "Only data.json and notes.md" }]), undefined);
});
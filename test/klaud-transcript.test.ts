import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSession } from "../src/agent/session.ts";
import { startKlaudServe } from "../src/harness/klaud/serve.ts";

const hidden = "PRIVATE_TRANSCRIPT_THOUGHT_FIXTURE", rawCallId = "provider-reused-call";
type PublicEvent = { type: string; [key: string]: any };
function completion(text: string, tool?: { name: string; args: object; id?: string }, reasoning = 7) {
	return { choices: [{ message: { content: text, reasoning_content: hidden, ...(tool ? { tool_calls: [{ id: tool.id ?? rawCallId, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) }, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32, completion_tokens_details: { reasoning_tokens: reasoning } } };
}
const shellCall = { name: "klaud_patch_shell", args: { patch: [] } };
function decode(body: string): PublicEvent[] {
	assert.ok(body.endsWith("data: [DONE]\n\n"));
	assert.ok(!body.includes(hidden), "private thought content cannot enter desktop events");
	return body.split("\n\n").filter(block => block.startsWith("data: ") && block !== "data: [DONE]").map(block => JSON.parse(block.slice(6)));
}

/** Exercise the actual agent loop and provider adapter: an opts.run generator
 * bypasses message_end conversion and previously hid these identity regressions. */
async function fixture(t: test.TestContext, respond: (count: number) => object, toolsMode: "native" | "text" = "native") {
	const home = mkdtempSync(join(tmpdir(), "rein-transcript-fixture-")), cwd = join(home, "work"); mkdirSync(cwd);
	const saved = Object.fromEntries(["REIN_HOME", "REIN_BASE_URL", "REIN_MODEL", "REIN_API"].map(key => [key, process.env[key]]));
	let requests = 0;
	const model = createServer(async (req, res) => {
		try { for await (const _ of req) {} res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(respond(++requests))); }
		catch { res.writeHead(500).end(); }
	});
	await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
	Object.assign(process.env, { REIN_HOME: home, REIN_BASE_URL: baseUrl, REIN_MODEL: "transcript-fixture", REIN_API: "chat-completions" });
	writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "custom", model: "transcript-fixture", baseUrl, toolsMode, maxTurns: 6 }), { mode: 0o600 });
	const server = await startKlaudServe({ home, cwd });
	t.after(async () => {
		await server.close(); await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(home, { recursive: true, force: true });
	});
	const headers = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
	const created = await fetch(server.url + "/bots", { method: "POST", headers, body: JSON.stringify({ name: "Transcript fixture" }) });
	assert.equal(created.status, 201); const bot = await created.json();
	return { home, bot, run: async () => {
		const response = await fetch(server.url + "/run", { method: "POST", headers, body: JSON.stringify({ botId: bot.id, threadId: bot.sessionId, message: "Run the synthetic transcript fixture." }) });
		assert.equal(response.status, 200); const events = decode(await response.text());
		assert.equal(events.filter(event => event.type === "RUN_FINISHED").length, 1); assert.equal(events.some(event => event.type === "RUN_ERROR"), false);
		return events;
	} };
}

test("real multi-turn runs retain distinct text identities and authoritative public completion", { timeout: 15_000 }, async t => {
	const f = await fixture(t, count => completion(`Phase ${count}.`, count < 3 ? shellCall : undefined, count));
	const events = await f.run(), deltas = events.filter(event => event.type === "TEXT_MESSAGE_CONTENT");
	assert.deepEqual(deltas.map(event => event.delta), ["Phase 1.", "Phase 2.", "Phase 3."]);
	assert.equal(new Set(deltas.map(event => event.messageId)).size, 3, "distinct model turns must not append into the same earlier reply");
	const finals = events.filter(event => event.type === "TEXT_MESSAGE_END" && typeof event.content === "string");
	assert.equal(finals.length, 3);
	assert.deepEqual(finals.map(event => event.messageId), deltas.map(event => event.messageId));
	assert.deepEqual(finals.map(event => event.content), ["Phase 1.", "Phase 2.", "Phase 3."]);
	assert.deepEqual(finals.map(event => event.completion), [{ stopReason: "toolUse", reasoningTokens: 1 }, { stopReason: "toolUse", reasoningTokens: 2 }, { stopReason: "stop", reasoningTokens: 3 }]);
	for (const final of finals) assert.ok(events.indexOf(final) > events.indexOf(deltas.find(event => event.messageId === final.messageId)!));
});

test("reused provider tool IDs have separate UI cards and correlated starts, arguments and results", { timeout: 15_000 }, async t => {
	const f = await fixture(t, count => completion(`Step ${count}.`, count < 3 ? shellCall : undefined));
	const events = await f.run(), starts = events.filter(event => event.type === "TOOL_CALL_START"), args = events.filter(event => event.type === "TOOL_CALL_ARGS"), results = events.filter(event => event.type === "TOOL_CALL_RESULT");
	assert.equal(starts.length, 2, "native OpenAI tool execution must become visible before it finishes");
	assert.equal(args.length, 2); assert.equal(results.length, 2);
	assert.equal(new Set(starts.map(event => event.toolCallId)).size, 2, "a reused provider ID must not overwrite an earlier tool card");
	assert.ok(starts.every(event => event.toolCallId !== rawCallId));
	assert.deepEqual(starts.map(event => event.toolCallName), [shellCall.name, shellCall.name]);
	assert.deepEqual(starts.map(event => event.providerToolCallId), [rawCallId, rawCallId]);
	for (const start of starts) {
		const argumentsEvent = args.find(event => event.toolCallId === start.toolCallId), result = results.find(event => event.toolCallId === start.toolCallId);
		assert.ok(argumentsEvent); assert.deepEqual(JSON.parse(argumentsEvent.delta), shellCall.args);
		assert.ok(result); assert.equal(result.toolName, shellCall.name); assert.equal(result.isError, false); assert.equal(typeof result.content, "string");
		assert.ok(events.indexOf(start) < events.indexOf(result), "tool start precedes its result");
	}
	const stored = loadSession(f.bot.sessionId, f.home).messages;
	assert.deepEqual(stored.flatMap(message => message.role === "assistant" ? message.content.filter(part => part.type === "toolCall").map(part => part.id) : []), [rawCallId, rawCallId]);
	assert.deepEqual(stored.filter(message => message.role === "toolResult").map(message => message.toolCallId), [rawCallId, rawCallId], "UI identity scoping cannot rewrite model protocol or durable storage IDs");
});

test("text-tool compatibility replaces raw tool markup with cleaned assistant text exactly once", { timeout: 15_000 }, async t => {
	const toolText = 'Checking the shell.\n<tool name="klaud_patch_shell">\n{"patch": []}\n</tool>';
	const f = await fixture(t, count => completion(count === 1 ? toolText : "The shell is ready."), "text");
	const events = await f.run(), finals = events.filter(event => event.type === "TEXT_MESSAGE_END" && typeof event.content === "string");
	assert.deepEqual(finals.map(event => event.content), ["Checking the shell.", "The shell is ready."]);
	const visible = new Map<string, string>();
	for (const event of events) {
		if (event.type === "TEXT_MESSAGE_CONTENT") visible.set(event.messageId, (visible.get(event.messageId) ?? "") + event.delta);
		if (event.type === "TEXT_MESSAGE_END" && typeof event.content === "string") visible.set(event.messageId, event.content);
	}
	assert.deepEqual([...visible.values()], ["Checking the shell.", "The shell is ready."], "authoritative content replaces its streamed preview rather than appending it");
	assert.doesNotMatch([...visible.values()].join("\n"), /<tool|"patch"|PRIVATE_TRANSCRIPT/);
	assert.equal(events.filter(event => event.type === "TOOL_CALL_START").length, 1);
	assert.equal(events.filter(event => event.type === "TOOL_CALL_RESULT").length, 1);
});

test("failed tool results keep their actual tool name and error state", { timeout: 15_000 }, async t => {
	const name = "fixture_unknown_tool", f = await fixture(t, count => completion(count === 1 ? "Trying a fixture tool." : "The fixture tool is unavailable.", count === 1 ? { name, args: {} } : undefined));
	const events = await f.run(), start = events.find(event => event.type === "TOOL_CALL_START"), result = events.find(event => event.type === "TOOL_CALL_RESULT");
	assert.ok(start); assert.ok(result); assert.equal(start.toolCallId, result.toolCallId);
	assert.equal(start.toolCallName, name); assert.equal(result.toolName, name); assert.equal(result.isError, true); assert.match(result.content, /not found/);
});

test("tool display identities remain separate across runs of the same durable bot", { timeout: 15_000 }, async t => {
	const f = await fixture(t, count => completion(`Reply ${count}.`, count % 2 ? shellCall : undefined));
	const first = await f.run(), second = await f.run();
	const a = first.find(event => event.type === "TOOL_CALL_START"), b = second.find(event => event.type === "TOOL_CALL_START");
	assert.ok(a); assert.ok(b); assert.equal(a.providerToolCallId, rawCallId); assert.equal(b.providerToolCallId, rawCallId); assert.notEqual(a.toolCallId, b.toolCallId);
	assert.notEqual(first.find(event => event.type === "TEXT_MESSAGE_CONTENT")!.messageId, second.find(event => event.type === "TEXT_MESSAGE_CONTENT")!.messageId);
});

test("real notes writes report journaling, reads report tool activity, and completion clears the phase", { timeout: 15_000 }, async t => {
	const noteContent = "SYNTHETIC_NOTE_CONTENT_EXCLUDED_FROM_PROGRESS", path = "phase-fixture.md";
	const f = await fixture(t, count => count === 1
		? completion("Saving a fixture note.", { name: "notes", args: { op: "write", path, content: noteContent }, id: "notes-write" })
		: count === 2 ? completion("Reading the fixture note.", { name: "notes", args: { op: "read", path }, id: "notes-read" })
			: completion("The fixture note was saved and read."));
	const events = await f.run(), progress = events.filter(event => event.type === "CUSTOM" && event.name === "klaud.progress");
	assert.equal(progress[0].value.phase, "working"); assert.equal(progress[0].value.turn, 1);
	assert.equal(progress.filter(event => event.value.phase === "journaling").length, 1);
	for (const [providerId, phase, turn] of [["notes-write", "journaling", 1], ["notes-read", "tool", 2]] as const) {
		const startIndex = events.findIndex(event => event.type === "TOOL_CALL_START" && event.providerToolCallId === providerId);
		const resultIndex = events.findIndex(event => event.type === "TOOL_CALL_RESULT" && event.providerToolCallId === providerId);
		const phaseIndex = events.findIndex(event => event.type === "CUSTOM" && event.name === "klaud.progress" && event.value.phase === phase && event.value.turn === turn);
		assert.ok(startIndex >= 0 && phaseIndex > startIndex && resultIndex > phaseIndex, "the actual tool start selects its phase until its result arrives");
		assert.equal(events[resultIndex].isError, false);
		assert.equal(events[phaseIndex].value.toolName, "notes");
		const cleared = events[resultIndex + 1];
		assert.equal(cleared.type, "CUSTOM"); assert.equal(cleared.name, "klaud.progress"); assert.deepEqual(cleared.value, { phase: "working", turn });
	}
	assert.ok(progress.some(event => event.value.phase === "working" && event.value.turn === 3), "the next model turn begins with working instead of stale journaling");
	const readResult = events.find(event => event.type === "TOOL_CALL_RESULT" && event.providerToolCallId === "notes-read");
	assert.ok(readResult.content.includes(noteContent), "the local fixture must execute the real write and read tools");
	const publicPhases = JSON.stringify(progress);
	assert.ok(!publicPhases.includes(noteContent)); assert.ok(!publicPhases.includes(path)); assert.ok(!publicPhases.includes(hidden));
	for (const event of progress) assert.ok(Object.keys(event.value).every(key => ["phase", "turn", "toolName"].includes(key)), "progress contains only public phase metadata");
});

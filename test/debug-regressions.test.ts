import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, relative } from "node:path";
import { Posthorse } from "../src/harness/posthorse.ts";
import { contextTools } from "../src/harness/tools/context.ts";
import { toolsForCwd } from "../src/harness/tools/index.ts";
import { createSession, appendMessage, sessionPath } from "../src/agent/session.ts";
import { stream } from "../src/ai/openai-completions.ts";

const model = { id: "offline", provider: "custom", baseUrl: "http://unused", contextWindow: 8000, maxTokens: 1000 };
const horse = () => new Posthorse({ model, prompt: () => "", tools: () => [] });

test("notes accepts its documented .pi/notes prefix without nesting it again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rein-debug-notes-"));
	try {
		mkdirSync(join(dir, ".pi", "notes"), { recursive: true });
		writeFileSync(join(dir, ".pi", "notes", "MEMORY.md"), "verified current task");
		const notes = contextTools(horse(), dir).find(tool => tool.name === "notes")!;
		const result = await notes.execute("read", { op: "read", path: ".pi/notes/MEMORY.md" });
		assert.equal(result.content, "verified current task");
		assert.equal((await notes.execute("append", { op: "append", path: ".pi/notes/MEMORY.md", content: "next fact" })).content, "Appended to .pi/notes/MEMORY.md");
		await assert.rejects(notes.execute("bad", { op: "write", path: ".pi/notes/../../outside", content: "bad" }), /path/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a provider's empty success is reported as an actionable error", async t => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: null }, finish_reason: "stop" }] }));
	const message = await stream(model, { messages: [] }).result();
	assert.equal(message.stopReason, "error"); assert.match(message.errorMessage!, /no usable|empty/i);
});

test("provider length stop takes precedence over salvaged tool calls", async t => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "partial", function: { name: "bash", arguments: '{"command":"echo partial"}' } }] }, finish_reason: "length" }] }));
	const message = await stream(model, { messages: [] }).result();
	assert.equal(message.stopReason, "length");
});

test("small notes reads share context by actual page size instead of reserving a full page each", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rein-debug-pages-"));
	try {
		const state = horse();
		const notes = contextTools(state, dir).find(tool => tool.name === "notes")!;
		await notes.execute("write", { op: "write", path: "tiny", content: "brief fact" });
		for (let i = 0; i < 5; i++) assert.equal((await notes.execute("read", { op: "read", path: "tiny" })).content, "brief fact");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("history lists scoped sessions and reads a session ID without mistaking it for an entry ID", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rein-debug-history-")); const previous = process.env.REIN_HOME;
	process.env.REIN_HOME = join(dir, "home");
	try {
		const cwd = join(dir, "workspace"), other = join(dir, "other"); mkdirSync(cwd); mkdirSync(other);
		const saved = createSession({ cwd, id: "custom-debug-session" }); appendMessage(saved, { role: "user", content: "known earlier request", timestamp: 1 });
		const foreign = createSession({ cwd: other }); appendMessage(foreign, { role: "user", content: "foreign request", timestamp: 2 });
		const history = contextTools(horse(), cwd).find(tool => tool.name === "history")!;
		assert.match((await history.execute("list", { op: "list" })).content, new RegExp(saved));
		assert.doesNotMatch((await history.execute("list", { op: "list" })).content, new RegExp(foreign));
		assert.match((await history.execute("read", { op: "read", id: saved })).content, /known earlier request/);
		await assert.rejects(history.execute("foreign", { op: "read", id: foreign }), /No history|repository|scope/);
	} finally { if (previous === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previous; rmSync(dir, { recursive: true, force: true }); }
});

test("history applies its recent-session cap within the repository scope", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rein-debug-history-cap-")); const previous = process.env.REIN_HOME;
	process.env.REIN_HOME = join(dir, "home");
	try {
		const cwd = join(dir, "project"), other = join(dir, "other"); mkdirSync(cwd); mkdirSync(other);
		const saved = createSession({ cwd }); appendMessage(saved, { role: "user", content: "SCOPED_HISTORY_SENTINEL", timestamp: 1 });
		utimesSync(sessionPath(saved), 1, 1);
		for (let i = 0; i < 200; i++) createSession({ cwd: other });
		const history = contextTools(horse(), cwd).find(tool => tool.name === "history")!;
		assert.match((await history.execute("list", { op: "list" })).content, new RegExp(saved));
		assert.match((await history.execute("search", { op: "search", all: true, query: "SCOPED_HISTORY_SENTINEL" })).content, /SCOPED_HISTORY_SENTINEL/);
	} finally { if (previous === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previous; rmSync(dir, { recursive: true, force: true }); }
});

test("automatic rollovers keep direct user intent without nesting earlier recovery blocks", () => {
	const state = horse();
	state.record({ role: "user", content: "Inspect only the supplied logs. Do not alter any remote host. CURRENT-INTENT", timestamp: 1 });
	for (let i = 0; i < 12; i++) {
		state.record({ role: "assistant", content: [{ type: "text", text: "old evidence ".repeat(2200) }], stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0 }, timestamp: i + 2, model: model.id, provider: model.provider });
		state.prepare(state.messages);
		const recovery = state.window?.handoff ?? "";
		assert.equal(recovery.split("Automatic context rollover recovery record").length - 1, 1);
		assert.match(recovery, /CURRENT-INTENT/);
		assert.ok(recovery.length <= state.freshLimit());
	}
});

test("file tools expand the home shortcut independently of the runner working directory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rein-debug-home-"));
	try {
		const file = join(dir, "sentinel"); writeFileSync(file, "home-relative marker");
		const read = toolsForCwd(dir).find(tool => tool.name === "read")!;
		const result = await read.execute("read", { path: `~/${relative(homedir(), file)}` });
		assert.equal(result.isError, undefined); assert.match(result.content, /home-relative marker/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

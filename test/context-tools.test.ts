import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextTools, notesRoot } from "../src/harness/tools/context.ts";
import { Posthorse } from "../src/harness/posthorse.ts";
import { createSession, branchSession, loadSession, appendMessage } from "../src/agent/session.ts";

function controller(): Posthorse {
	return new Posthorse({ model: { id: "offline", provider: "offline", baseUrl: "http://localhost", maxTokens: 1024, contextWindow: 32768 }, prompt: () => "", tools: () => [] });
}
function toolsAt(state: Posthorse, cwd: string) {
	return Object.fromEntries(contextTools(state, cwd).map(tool => [tool.name, (args: Record<string, unknown>, signal?: AbortSignal) => tool.execute("test", args, signal)]));
}
function fixture() { return mkdtempSync(join(tmpdir(), "rein-context-tools-")); }
function git(cwd: string, args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }


test("notes preserve original operations, enforce page bounds and reject escaping paths", async () => {
	const cwd = fixture();
	try {
		const state = controller(); state.pageLimit = () => 256;
		const tools = toolsAt(state, cwd);
		assert.deepEqual(Object.keys(tools), ["new_context", "get_context_remaining", "notes", "history"]);
		assert.match((await tools.notes({ op: "list" })).content, /no notes/);
		await tools.notes({ op: "write", path: "state/progress.md", content: "goal" });
		await tools.notes({ op: "append", path: "state/progress.md", content: "next step" });
		assert.equal((await tools.notes({ op: "read", path: "state/progress.md" })).content, "goal\nnext step\n");
		assert.match((await tools.notes({ op: "search", query: "NEXT" })).content, /state\/progress.md:2: next step/);
		await tools.notes({ op: "write", path: "state/progress.md", content: "" });
		assert.equal((await tools.notes({ op: "read", path: "state/progress.md" })).content, "");
		const content = "abcdefghijklmnop".repeat(100);
		await tools.notes({ op: "write", path: "long", content });
		let offset = 0; let recovered = "";
		while (offset < content.length) {
			const result = (await tools.notes({ op: "read", path: "long", offset })).content;
			assert.ok(result.length <= 256);
			const footer = /\n\[chars \d+-(\d+) of \d+; continue with offset \d+\]$/.exec(result);
			recovered += footer ? result.slice(0, footer.index) : result;
			offset = footer ? Number(footer[1]) : content.length;
		}
		assert.equal(recovered, content);
		for (const path of ["../outside", "/tmp/outside", "C:\\outside", ".", "nested/../../outside", "a\0b"]) {
			await assert.rejects(tools.notes({ op: "write", path, content: "bad" }), /path/i);
		}
		for (const offset of [-1, 1.5, "3", NaN]) await assert.rejects(tools.notes({ op: "read", path: "long", offset }), /offset/i);
		await assert.rejects(tools.notes({ op: "read", path: "long", offset: 10_000 }), /past the end/);
		await assert.rejects(tools.notes({ op: "unknown", query: "anything" }), /Unknown/);
		await assert.rejects(tools.new_context({ handoff: 123 }), /string/);
		const abort = new AbortController(); abort.abort();
		await assert.rejects(tools.new_context({}, abort.signal), /aborted/);
		const result = await tools.new_context({ handoff: "  saved goal  " });
		assert.deepEqual(result.newContext, { handoff: "saved goal" });
		assert.equal(state.window, undefined, "request tool must leave commit to the batch controller");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("notes reject root/file symlinks and hardlinks without changing external files", async () => {
	const cwd = fixture();
	try {
		const outside = join(cwd, "outside"); mkdirSync(outside);
		writeFileSync(join(outside, "sentinel"), "untouched");
		symlinkSync(outside, join(cwd, ".pi"));
		const tools = toolsAt(controller(), cwd);
		await assert.rejects(tools.notes({ op: "write", path: "x", content: "bad" }), /Symbolic/);
		await assert.rejects(tools.notes({ op: "list" }), /Symbolic/);
		rmSync(join(cwd, ".pi")); mkdirSync(join(cwd, ".pi", "notes"), { recursive: true });
		symlinkSync(join(outside, "sentinel"), join(cwd, ".pi", "notes", "linked"));
		await assert.rejects(tools.notes({ op: "append", path: "linked", content: "bad" }), /Symbolic/);
		linkSync(join(outside, "sentinel"), join(cwd, ".pi", "notes", "hardlinked"));
		await assert.rejects(tools.notes({ op: "append", path: "hardlinked", content: "bad" }), /hard links/);
		assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "untouched");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("notes share a canonical root across nested linked worktrees and separate git dirs", async () => {
	const dir = fixture();
	try {
		const main = join(dir, "main checkout"); mkdirSync(main);
		git(main, ["init", "--separate-git-dir", join(dir, "metadata")]);
		git(main, ["-c", "user.name=Offline Test", "-c", "user.email=offline@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
		const linked = join(dir, "linked tree"); git(main, ["worktree", "add", "--detach", linked]);
		const nested = join(linked, "nested"); mkdirSync(nested);
		assert.equal(notesRoot(nested), realpathSync(join(dir, "metadata")));
		assert.equal(notesRoot(main), notesRoot(nested));
		await toolsAt(controller(), main).notes({ op: "write", path: "shared", content: "shared state" });
		assert.equal((await toolsAt(controller(), nested).notes({ op: "read", path: "shared" })).content, "shared state");
		const normal = join(dir, "normal"); mkdirSync(normal);
		git(normal, ["init"]);
		git(normal, ["-c", "user.name=Offline Test", "-c", "user.email=offline@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
		const normalLinked = join(dir, "normal-linked"); git(normal, ["worktree", "add", "--detach", normalLinked]);
		assert.equal(notesRoot(normalLinked), realpathSync(normal));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("history scopes all-session recovery, deduplicates forks and labels retroactive window boundaries", async () => {
	const dir = fixture(); const previous = process.env.REIN_HOME;
	process.env.REIN_HOME = join(dir, "rein-home");
	try {
		const cwd = join(dir, "workspace"); const other = join(dir, "other"); mkdirSync(cwd); mkdirSync(other);
		const source = createSession({ cwd });
		appendMessage(source, { role: "user", content: "original needle", timestamp: Date.now() });
		const state = controller(); state.setSession(source);
		state.record({ role: "user", content: "pending needle " + "longtext".repeat(200), timestamp: Date.now() });
		state.rollover("carry", "threshold", 1);
		const pendingId = state.messages[1].id;
		const branch = branchSession(source);
		state.setSession(branch);
		const foreign = createSession({ cwd: other });
		appendMessage(foreign, { role: "user", content: "foreign needle", timestamp: Date.now() });
		const peer = createSession({ cwd });
		appendMessage(peer, { role: "user", content: "peer needle", timestamp: Date.now() });
		const peerId = loadSession(peer).messages[0].id;
		const tools = toolsAt(state, cwd);
		state.pageLimit = () => 20_000;
		const search = (await tools.history({ op: "search", query: "needle", all: true })).content;
		assert.equal(search.split("original needle").length - 1, 1, "forked messages should appear once");
		assert.match(search, /peer needle/);
		assert.doesNotMatch(search, /foreign needle/);
		assert.match(search, new RegExp(`window ${state.window!.id}.*${pendingId}`));
		await assert.rejects(tools.history({ op: "read", id: peerId }), /all=true/);
		assert.match((await tools.history({ op: "read", id: peerId, all: true })).content, /peer needle/);
		state.pageLimit = () => 256;
		const read = (await tools.history({ op: "read", id: pendingId })).content;
		assert.ok(read.length <= 256, `header and footer exceeded allocation: ${read.length}`);
		assert.match(read, /continue with offset/);
		await assert.rejects(tools.history({ op: "search", query: "needle", limit: 0 }), /limit/);
	} finally {
		if (previous === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

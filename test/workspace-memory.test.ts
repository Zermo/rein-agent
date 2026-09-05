import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSession, latestWorkspaceSnapshot, loadSession, workspaceMemoryRecords } from "../src/agent/session.ts";
import { Posthorse } from "../src/harness/posthorse.ts";

function git(cwd: string, args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function user(content: string) { return { role: "user" as const, content, timestamp: Date.now() }; }
function horse(cwd: string) {
	return new Posthorse({
		cwd,
		model: { id: "offline", provider: "llamacpp", baseUrl: "http://localhost/v1", contextWindow: 32_768, maxTokens: 1024 },
		prompt: () => "", tools: () => [],
	});
}

test("resuming an archived session creates an isolated current workspace overlay", () => {
	const dir = join(tmpdir(), `rein-workspace-memory-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const home = `${dir}-home`;
	const priorHome = process.env.REIN_HOME;
	process.env.REIN_HOME = home;
	try {
		mkdirSync(dir, { recursive: true });
		git(dir, ["init"]); git(dir, ["config", "user.name", "Offline Test"]); git(dir, ["config", "user.email", "offline@example.invalid"]);
		writeFileSync(join(dir, "tracked.txt"), "before\n");
		mkdirSync(join(dir, ".pi", "notes"), { recursive: true });
		writeFileSync(join(dir, ".pi", "notes", "MEMORY.md"), "Deployment decisions require the smoke test.\n");
		git(dir, ["add", "tracked.txt", ".pi/notes/MEMORY.md"]); git(dir, ["commit", "-m", "base"]);

		const archived = createSession({ cwd: dir });
		const original = horse(dir); original.setSession(archived); original.record(user("ARCHIVED_TOOL_TRANSCRIPT_SENTINEL")); original.captureWorkspace();
		const archivedBase = latestWorkspaceSnapshot(loadSession(archived).entries)!;

		writeFileSync(join(dir, "tracked.txt"), "before\ncurrent session change\n");
		git(dir, ["add", "tracked.txt"]); git(dir, ["commit", "-m", "current session change"]);
		const current = createSession({ cwd: dir });
		const currentHorse = horse(dir); currentHorse.setSession(current); currentHorse.record(user("CURRENT_SESSION_SENTINEL")); currentHorse.rollover("Current session changed tracked.txt and verified the smoke test.", "manual", 1); currentHorse.captureWorkspace();
		const peerCheckpoints = loadSession(current).entries.filter(entry => entry.type === "workspace_snapshot").length;
		writeFileSync(join(dir, "tracked.txt"), "before\ncurrent session change\nuncommitted followup\n");
		currentHorse.captureWorkspace();
		assert.equal(loadSession(current).entries.filter(entry => entry.type === "workspace_snapshot").length, peerCheckpoints + 1, "a second edit to an already changed path updates the peer checkpoint");

		const resumed = horse(dir); resumed.setSession(archived);
		const loaded = loadSession(archived);
		assert.equal(loaded.window?.reason, "resume");
		assert.equal(loaded.window?.start, 1, "resume boundary follows the archived transcript");
		assert.equal(loaded.messages[0].content, "ARCHIVED_TOOL_TRANSCRIPT_SENTINEL", "full old transcript remains durable");
		const active = resumed.active();
		assert.equal(active.length, 1, "old tool/chat transcript is not replayed into the fresh request");
		assert.match((active[0] as { content: string }).content, /persistent workspace overlay/);
		assert.match((active[0] as { content: string }).content, /current session change/);
		assert.match((active[0] as { content: string }).content, /uncommitted followup/);
		assert.match((active[0] as { content: string }).content, /Deployment decisions require the smoke test/);
		assert.match((active[0] as { content: string }).content, /Current session changed tracked\.txt/);
		assert.doesNotMatch((active[0] as { content: string }).content, /ARCHIVED_TOOL_TRANSCRIPT_SENTINEL/);
		const latest = latestWorkspaceSnapshot(loaded.entries)!;
		assert.notEqual(latest.head, archivedBase.head);
		assert.ok(workspaceMemoryRecords(latest.scope, archived).some(record => record.sessionId === current));
	} finally {
		if (priorHome === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = priorHome;
		rmSync(dir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("unchanged workspace resume remains a fresh boundary without duplicate snapshots", () => {
	const dir = join(tmpdir(), `rein-workspace-resume-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const home = `${dir}-home`;
	const priorHome = process.env.REIN_HOME;
	process.env.REIN_HOME = home;
	try {
		mkdirSync(dir, { recursive: true }); git(dir, ["init"]); git(dir, ["config", "user.name", "Offline Test"]); git(dir, ["config", "user.email", "offline@example.invalid"]);
		writeFileSync(join(dir, "tracked.txt"), "base\n"); git(dir, ["add", "tracked.txt"]); git(dir, ["commit", "-m", "base"]);
		const id = createSession({ cwd: dir }); const first = horse(dir); first.setSession(id); first.record(user("old")); first.captureWorkspace();
		const before = loadSession(id).entries.filter(entry => entry.type === "workspace_snapshot").length;
		const second = horse(dir); second.setSession(id);
		const after = loadSession(id);
		assert.equal(after.window?.reason, "resume");
		assert.equal(after.entries.filter(entry => entry.type === "workspace_snapshot").length, before, "same state does not churn snapshot records");
		assert.match((second.active()[0] as { content: string }).content, /working tree: clean/);
	} finally {
		if (priorHome === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = priorHome;
		rmSync(dir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

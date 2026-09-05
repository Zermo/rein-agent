import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, linkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { acquireLock, autonomyDirectory, canonicalWorkspace, decideProposal, initialState, proposalId, readState, updateState } from "../src/harness/autonomy/state.ts";
import { runCycle, runDaemon } from "../src/harness/autonomy/engine.ts";
import { collectAutonomyEvidence } from "../src/harness/autonomy/history.ts";
import { createSession, appendMessage, branchSession, loadSession } from "../src/agent/session.ts";
import { runAutonomyCommand } from "../src/harness/autonomy/command.ts";

async function isolated(fn: (workspace: string) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "rein-autonomy-engine-")); const prev = process.env.REIN_HOME;
	process.env.REIN_HOME = join(dir, "home"); mkdirSync(process.env.REIN_HOME); const workspace = join(dir, "workspace"); mkdirSync(workspace);
	try { await fn(canonicalWorkspace(workspace)); } finally { if (prev === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = prev; rmSync(dir, { recursive: true, force: true }); }
}
function seed(workspace: string) {
	const id = createSession({ cwd: workspace });
	appendMessage(id, { role: "user", content: "We need to check the local import regression regularly after schema changes.", timestamp: 1000 });
	appendMessage(id, { role: "user", content: "The importer changed today and still needs a focused review before use.", timestamp: 2000 });
	return id;
}
const draftFor = (workspace: string, evidenceIds: string[]) => ({ title: "Review the importer", kind: "routine" as const, workspace, prompt: "Inspect importer changes and report any remaining schema regressions with file evidence.", reason: "Earlier recurring checks are still needed after today's importer change.", evidenceIds, intervalMinutes: 60 });

test("changed history gets two independent tool-free passes, persists reviewable proposals, and unchanged history is free", () => isolated(async workspace => {
	seed(workspace); await updateState(s => { s.workspaces = [workspace]; });
	const evidence = collectAutonomyEvidence([workspace]); const draft = draftFor(workspace, [evidence.sources[0].id]); let calls = 0;
	const deps = { generate: async (system: string, prompt: string) => { calls++; assert.match(system, /no tools|have no tools/i); return calls === 1 ? JSON.stringify({ proposals: [draft] }) : JSON.stringify({ keep: [proposalId(draft)] }); } };
	assert.match(await runCycle("scan", undefined, { manual: true }, deps), /1 new proposal/);
	assert.equal(calls, 2); let state = readState();
	assert.equal(state.proposals[0].status, "pending"); assert.equal(state.proposals[0].allowWrites, false);
	assert.equal(state.proposals[0].evidence?.[0].excerpt, evidence.sources[0].excerpt);
	assert.equal(state.runs.length, 1);
	assert.match(await runCycle("scan", undefined, { manual: true }, deps), /unchanged/);
	assert.equal(calls, 2); assert.equal(readState().runs.length, 1);
}));

test("proposal execution requires current approval and obeys pause, daily budget, and one-shot projects", () => isolated(async workspace => {
	const draft = draftFor(workspace, ["source"]); const id = proposalId(draft); let executed = 0;
	await updateState(s => { s.workspaces = [workspace]; s.paused = false; s.maxRunsPerDay = 1; s.proposals.push({ ...draft, kind: "project", id, status: "pending", allowWrites: false, created: Date.now() }); });
	const deps = { execute: async () => { executed++; return "Verified project evidence."; } };
	assert.match(await runCycle("routine", id, { manual: true }, deps), /Enable/); assert.equal(executed, 0);
	await decideProposal(id, "enabled");
	assert.equal(await runCycle("routine", id, {}, deps), "Verified project evidence.");
	assert.equal(readState().proposals[0].nextRun, undefined);
	assert.match(await runCycle("routine", id, { manual: true }, deps), /budget/); assert.equal(executed, 1);
	await updateState(s => { s.paused = true; });
	assert.match(await runCycle("routine", id, { manual: true }, deps), /paused/);
}));

test("pause and permission downgrades cancel active work and do not mark it successful", () => isolated(async workspace => {
	const draft = draftFor(workspace, ["source"]); const id = proposalId(draft);
	await updateState(s => { s.workspaces = [workspace]; s.paused = false; s.proposals.push({ ...draft, id, status: "pending", allowWrites: false, created: Date.now() }); });
	for (const pause of [false, true]) {
		await decideProposal(id, "enabled", true); await updateState(s => { s.paused = false; });
		const deps = { execute: async (_p: unknown, _s: unknown, signal: AbortSignal) => {
			if (pause) await updateState(s => { s.paused = true; }); else await decideProposal(id, "enabled", false);
			await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			return "must not be recorded as success";
		} };
		assert.match(await runCycle("routine", id, { manual: true }, deps), /cancelled/);
		assert.equal(readState().runs.at(-1)?.status, "cancelled");
	}
}));

test("lock ownership, concurrent updates, stale atomic-publication locks and invalid records", () => isolated(async workspace => {
	await Promise.all(Array.from({ length: 5 }, (_, i) => updateState(s => { s.workspaces.push(`${workspace}/${i}`); })));
	assert.equal(readState().workspaces.length, 5);
	const release = acquireLock("cycle")!; assert.ok(release); assert.equal(acquireLock("cycle"), undefined); release();
	const temp = join(autonomyDirectory(), "dead.tmp"); const lock = join(autonomyDirectory(), "cycle.lock");
	writeFileSync(temp, JSON.stringify({ pid: 2147483647, token: "dead-owner" })); linkSync(temp, lock); utimesSync(lock, new Date(0), new Date(0));
	const reclaimed = acquireLock("cycle"); assert.ok(reclaimed, "dead owner with publication hardlink is recoverable"); reclaimed!();
	writeFileSync(join(autonomyDirectory(), "state.json"), JSON.stringify({ ...initialState(), runs: [null] }));
	assert.throws(readState, /Invalid autonomy run record/);
}));

test("generated sessions never cause autonomous feedback and paused daemon exits without model work", () => isolated(async workspace => {
	seed(workspace); const before = collectAutonomyEvidence([workspace]);
	const id = createSession({ cwd: workspace, purpose: "autonomy" }); appendMessage(id, { role: "user", content: "This generated task must not become new user intent", timestamp: Date.now() });
	assert.equal(loadSession(branchSession(id)).header?.purpose, "autonomy");
	assert.equal(collectAutonomyEvidence([workspace]).digest, before.digest);
	await updateState(s => { s.workspaces = [workspace]; s.paused = true; });
	const controller = new AbortController(); const run = runDaemon(controller.signal); setTimeout(() => controller.abort(), 30); await run;
	assert.equal(readState().runs.length, 0);
}));

test("approved read-only runs use the actual adapter and save generated reports without normal write tools", t => isolated(async workspace => {
	writeFileSync(join(workspace, "tracked.txt"), "current fixture evidence\n");
	writeFileSync(join(process.env.REIN_HOME!, "config.json"), JSON.stringify({ provider: "custom", baseUrl: "http://autonomy-fixture.invalid/v1", model: "offline" }));
	const draft = draftFor(workspace, ["source"]); const id = proposalId(draft);
	await updateState(s => { s.paused = false; s.workspaces = [workspace]; s.proposals.push({ ...draft, id, status: "pending", allowWrites: false, created: Date.now() }); });
	await decideProposal(id, "enabled"); let requests = 0;
	t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
		const body = JSON.parse(init.body as string); requests++;
		assert.ok(body.tools.every((tool: any) => ["read", "ls", "search"].includes(tool.function.name)));
		assert.match(body.messages[0].content, /read-only tools/);
		if (requests === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "inspect", type: "function", function: { name: "read", arguments: '{"path":"tracked.txt"}' } }] }, finish_reason: "tool_calls" }] });
		assert.ok(body.messages.some((m: any) => m.role === "tool" && m.content.includes("current fixture evidence")));
		return Response.json({ choices: [{ message: { content: "Inspected current evidence; no writes performed." }, finish_reason: "stop" }] });
	});
	assert.match(await runCycle("routine", id, { manual: true }), /Inspected current evidence/);
	const run = readState().runs.at(-1)!; assert.equal(run.status, "success"); assert.ok(run.sessionId);
	assert.equal(loadSession(run.sessionId!).header?.purpose, "autonomy"); assert.equal(requests, 2);
}));

test("init is an explicit paused enrollment and rejects invalid budgets before saving", () => isolated(async workspace => {
	await assert.rejects(runAutonomyCommand(["init"], { workspace, "daily-budget": "0" }), /daily-budget/);
	assert.equal(readState().workspaces.length, 0);
	await runAutonomyCommand(["init"], { workspace, "daily-budget": "3" });
	const state = readState(); assert.equal(state.paused, true); assert.deepEqual(state.workspaces, [workspace]); assert.equal(state.maxRunsPerDay, 3);
}));

test("revocation blocks the very next write tool before the background cancellation poll", t => isolated(async workspace => {
	writeFileSync(join(workspace, "tracked.txt"), "original\n");
	writeFileSync(join(process.env.REIN_HOME!, "config.json"), JSON.stringify({ provider: "custom", baseUrl: "http://autonomy-revoke.invalid/v1", model: "offline" }));
	const draft = draftFor(workspace, ["source"]); const id = proposalId(draft);
	await updateState(s => { s.paused = false; s.workspaces = [workspace]; s.proposals.push({ ...draft, id, status: "pending", allowWrites: false, created: Date.now() }); });
	await decideProposal(id, "enabled", true); let requests = 0;
	t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
		const body = JSON.parse(init.body as string); requests++;
		if (requests === 1) {
			await decideProposal(id, "enabled", false);
			return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "attempt", type: "function", function: { name: "write", arguments: '{"path":"tracked.txt","content":"should not be written"}' } }] }, finish_reason: "tool_calls" }] });
		}
		assert.ok(body.messages.some((m: any) => m.role === "tool" && m.content.includes("approval changed")));
		return Response.json({ choices: [{ message: { content: "Stopped after approval changed." }, finish_reason: "stop" }] });
	});
	assert.match(await runCycle("routine", id, { manual: true }), /cancelled/);
	assert.equal(readFileSync(join(workspace, "tracked.txt"), "utf8"), "original\n");
	assert.equal(readState().runs.at(-1)?.status, "cancelled");
}));

test("scan revocation stops the next model pass even before the cancellation poll", () => isolated(async workspace => {
	seed(workspace);
	const evidence = collectAutonomyEvidence([workspace]); const draft = draftFor(workspace, [evidence.sources[0].id]);
	for (const mode of ["pause", "unenroll", "paused-preview"] as const) {
		await updateState(s => { s.workspaces = [workspace]; s.paused = mode === "paused-preview"; });
		let calls = 0;
		const deps = { generate: async () => {
			calls++;
			await updateState(s => { if (mode === "unenroll") s.workspaces = []; else s.paused = true; if (mode === "paused-preview") s.controlRevision = (s.controlRevision ?? 0) + 1; });
			return JSON.stringify({ proposals: [draft] });
		} };
		assert.match(await runCycle("scan", undefined, { manual: true }, deps), /cancelled/);
		assert.equal(calls, 1, "revoked evidence must not go to the reviewer");
		assert.equal(readState().proposals.length, 0); assert.equal(readState().lastDigest, undefined);
		assert.equal(readState().runs.at(-1)?.status, "cancelled");
	}
}));

test("all 32 enrolled workspaces retain old and recent evidence within the bounded scan prompt", () => isolated(async workspace => {
	const workspaces = Array.from({ length: 32 }, (_, i) => join(workspace, `project-${i}`));
	for (const path of workspaces) { mkdirSync(path); seed(path); }
	await updateState(s => { s.workspaces = workspaces; });
	let calls = 0;
	const deps = { generate: async (_system: string, prompt: string) => {
		calls++; const evidence = JSON.parse(prompt).evidence;
		assert.ok(evidence.length <= 48000);
		const records = evidence.split("\n").slice(1).filter(Boolean).map((line: string) => JSON.parse(line));
		for (const path of workspaces) {
			assert.ok(records.some((r: any) => r.workspace === path && r.period === "older"), `older evidence for ${path}`);
			assert.ok(records.some((r: any) => r.workspace === path && r.period === "recent"), `recent evidence for ${path}`);
		}
		return JSON.stringify({ proposals: [] });
	} };
	assert.match(await runCycle("scan", undefined, { manual: true }, deps), /No new actionable/);
	assert.equal(calls, 1);
}));

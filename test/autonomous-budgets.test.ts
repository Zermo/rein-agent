import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model, StopReason } from "../src/ai/types.ts";
import type { RunnerOptions } from "../src/harness/runner.ts";
import { runExperimentLoop } from "../src/harness/loop.ts";
import { runImproveLoop } from "../src/harness/improve.ts";
import { runHeartbeat } from "../src/harness/heartbeat.ts";
import { loadSession } from "../src/agent/session.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(t: { after: (fn: () => void) => void }, config: Record<string, unknown> = {}) {
	const directory = mkdtempSync(join(tmpdir(), "rein-loop-budgets-")), home = join(directory, "home"), cwd = join(directory, "repo");
	mkdirSync(home); mkdirSync(cwd);
	const names = ["REIN_HOME", "REIN_MODEL", "REIN_BASE_URL", "REIN_API_KEY"], prior = names.map(name => [name, process.env[name]] as const);
	for (const name of names) delete process.env[name]; process.env.REIN_HOME = home;
	writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "custom", baseUrl: "http://budget-fixture.invalid/v1", model: "budget-fixture", ...config }));
	git(cwd, "init", "-q"); git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.invalid");
	writeFileSync(join(cwd, "tracked.txt"), "baseline"); writeFileSync(join(cwd, "LESSONS.md"), "# Lessons\n## harness\n- Test fixture weakness\n");
	writeFileSync(join(cwd, "TASK.md"), "Improve the fixture.");
	writeFileSync(join(cwd, "METRIC.md"), "```sh\nif [ \"$(cat tracked.txt)\" = improved ]; then printf 'METRIC=2\\n'; else printf 'METRIC=1\\n'; fi\n```\n");
	git(cwd, "add", "-A"); git(cwd, "commit", "-qm", "baseline");
	t.after(() => { for (const [name, value] of prior) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } rmSync(directory, { recursive: true, force: true }); });
	return { cwd, home };
}
const model: Model = { id: "fixture", provider: "custom", baseUrl: "http://budget-fixture.invalid/v1", api: "openai-completions", contextWindow: 32768, maxTokens: 4096 };
const reply = (text: string, stopReason: StopReason = "stop"): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], model: model.id, provider: model.provider, stopReason, usage: { input: 1, output: 1, totalTokens: 2 }, timestamp: Date.now() });
const doctor = async () => ({ healthy: 1, total: 1, fixed: [], warnings: 0, failures: 0, flags: [], checks: [] });

test("experiment honors an explicit turn budget beyond40 through the actual runner", async t => {
	const { cwd } = fixture(t, { maxTurns: 4, maxIterations: 9 }); let requests = 0, tools = 0;
	t.mock.method(globalThis, "fetch", async () => {
		requests++;
		return Response.json({ choices: [{ message: requests <= 42 ? { content: null, tool_calls: [{ id: `step-${requests}`, type: "function", function: { name: "step", arguments: JSON.stringify({ number: requests }) } }] } : { content: "RESULT: improved" }, finish_reason: requests <= 42 ? "tool_calls" : "stop" }] });
	});
	await runExperimentLoop({ cwd, maxTurns: 45, maxIterations: 1, autoContext: false, toolsMode: "native", systemPrompt: "Fixture",
		tools: [{ name: "step", description: "Fixture step", parameters: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] }, execute: async (_id, args) => { tools++; if (args.number === 42) writeFileSync(join(cwd, "tracked.txt"), "improved"); return { content: `step ${args.number}` }; } }],
	});
	assert.equal(requests, 43); assert.equal(tools, 42); assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "improved");
	assert.equal(git(cwd, "status", "--porcelain"), "");
	assert.match(readFileSync(join(cwd, "LESSONS.md"), "utf8"), /iteration limit reached; goal completion is unverified/);
});
test("loop uses saved iteration and turn limits and retains one runner plus measured feedback", async t => {
	const { cwd } = fixture(t, { maxTurns: 91, maxIterations: 2 }); let creates = 0, runs = 0;
	await runExperimentLoop({ cwd }, { createRunner: async options => {
		creates++; assert.equal(options.maxTurns, 91);
		return { model, run: async prompt => {
			runs++; if (runs === 2) { assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "baseline"); assert.match(String(prompt.content), /did not improve.*discarded/); }
			writeFileSync(join(cwd, "tracked.txt"), runs === 1 ? "worse" : "improved");
			return [reply("RESULT: improved")];
		} };
	} });
	assert.equal(creates, 1); assert.equal(runs, 2); assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "improved");
});
test("improve obeys saved budgets and explicit overrides while independently testing each change", async t => {
	const { cwd } = fixture(t, { maxTurns: 151, maxIterations: 3 }); let runs = 0, creates = 0, tests = 0; const seen: number[] = [];
	const dependencies = { repoDir: cwd, createRunner: async (options: RunnerOptions) => {
		creates++; seen.push(options.maxTurns!);
		return { model, run: async () => { runs++; writeFileSync(join(cwd, "tracked.txt"), `change${runs}`); return [reply("RESULT: improved")]; } };
	}, runTests: () => { tests++; return { pass: true, output: "independent fixture validation" }; } };
	await runImproveLoop({ cwd }, dependencies); assert.equal(runs, 3); assert.equal(tests, 3);
	await runImproveLoop({ cwd, maxTurns: 77, maxIterations: 2 }, dependencies);
	assert.deepEqual(seen, [151, 77]); assert.equal(creates, 2); assert.equal(runs, 5); assert.equal(tests, 5);
});
test("improve tells retained context when independent verification discarded the prior experiment", async t => {
	const { cwd } = fixture(t); let runs = 0, tests = 0, creates = 0;
	await runImproveLoop({ cwd, maxIterations: 2 }, { repoDir: cwd, createRunner: async () => {
		creates++; return { model, run: async prompt => { runs++;
			if (runs === 2) { assert.match(String(prompt.content), /test suite failed.*discarded/); assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "baseline"); }
			writeFileSync(join(cwd, "tracked.txt"), `change${runs}`); return [reply("RESULT: improved")];
		} };
	}, runTests: () => ({ pass: ++tests === 2, output: "fixture test evidence" }) });
	assert.equal(creates, 1); assert.equal(runs, 2); assert.equal(tests, 2); assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "change2");
});
test("budget-stopped loop and improve preserve incomplete work and make no success commit", async t => {
	const { cwd } = fixture(t), head = git(cwd, "rev-parse", "HEAD"); let tests = 0, saves = 0;
	const createRunner = async () => ({ model, saveSession: () => { saves++; return "fixture-session"; }, run: async () => { writeFileSync(join(cwd, "tracked.txt"), "incomplete work"); return [reply("RESULT: improved", "budget")]; } });
	await assert.rejects(runExperimentLoop({ cwd, maxIterations: 1 }, { createRunner }), /paused: budget.*preserved.*rein --resume fixture-session/);
	assert.equal(git(cwd, "rev-parse", "HEAD"), head); assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "incomplete work");
	git(cwd, "checkout", "--", "tracked.txt");
	await assert.rejects(runImproveLoop({ cwd, maxIterations: 1 }, { repoDir: cwd, createRunner, runTests: () => { tests++; return { pass: true, output: "must not run" }; } }), /paused: budget.*preserved.*rein --resume fixture-session/);
	assert.equal(git(cwd, "rev-parse", "HEAD"), head); assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "incomplete work"); assert.equal(tests, 0);
	assert.equal(saves, 2);
});
test("a real budget-stopped loop saves its tools and pause marker for resuming unfinished work", async t => {
	const { cwd } = fixture(t), head = git(cwd, "rev-parse", "HEAD");
	t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "unfinished-step", type: "function", function: { name: "step", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }));
	let sessionId: string | undefined;
	await assert.rejects(runExperimentLoop({ cwd, maxTurns: 1, maxIterations: 1, autoContext: false, toolsMode: "native", systemPrompt: "Fixture",
		tools: [{ name: "step", description: "Fixture step", parameters: { type: "object", properties: {} }, execute: async () => { writeFileSync(join(cwd, "tracked.txt"), "unfinished change"); return { content: "unfinished change written" }; } }],
	}), error => {
		sessionId = (error as Error).message.match(/rein --resume ([a-zA-Z0-9_-]+)/)?.[1];
		assert.ok(sessionId, (error as Error).message); return true;
	});
	const saved = loadSession(sessionId!);
	assert.equal(saved.header?.cwd, cwd);
	assert.ok(saved.messages.some(message => message.role === "user" && String(message.content).includes("Improve the fixture")));
	assert.ok(saved.messages.some(message => message.role === "toolResult" && message.toolCallId === "unfinished-step"));
	assert.equal(saved.messages.at(-1)?.role, "assistant");
	assert.equal((saved.messages.at(-1) as AssistantMessage).stopReason, "budget");
	assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "unfinished change");
	assert.equal(git(cwd, "rev-parse", "HEAD"), head);
});
test("invalid budgets fail before metrics, repo edits or heartbeat self-healing", async t => {
	const { cwd, home } = fixture(t); let doctorCalls = 0, modelCalls = 0;
	const dependencies = { createRunner: async () => { modelCalls++; throw new Error("must not start"); } };
	for (const maxTurns of [0, -1, 1.5, Infinity, 10001]) await assert.rejects(runExperimentLoop({ cwd, maxTurns }, dependencies), /maxTurns/);
	for (const maxIterations of [0, -1, 1.5, Infinity, 1001]) await assert.rejects(runImproveLoop({ cwd, maxIterations, dryRun: true }, { repoDir: cwd, ...dependencies }), /maxIterations/);
	await assert.rejects(runHeartbeat({ cwd, maxTurns: 0, init: true, file: join(home, "HEARTBEAT.md") }, { doctor: async () => { doctorCalls++; return doctor(); } }), /maxTurns/);
	assert.equal(modelCalls, 0); assert.equal(doctorCalls, 0); assert.equal(existsSync(join(home, "HEARTBEAT.md")), false);
});
test("heartbeat keeps40 turns and1 improve iteration despite foreground settings, with explicit overrides", async t => {
	const { cwd, home } = fixture(t, { maxTurns: 999, maxIterations: 999 }), file = join(home, "HEARTBEAT.md");
	writeFileSync(file, "Check the fixture\n# improve: review the fixture\n");
	const observed: Array<[string, number | undefined, number | undefined]> = [];
	const dependencies = { doctor, createRunner: async (options: RunnerOptions) => { observed.push(["task", options.maxTurns, undefined]); return { model, run: async () => [reply("Checked fixture")] }; }, improve: async (options: any) => { observed.push(["improve", options.maxTurns, options.maxIterations]); } };
	assert.equal(await runHeartbeat({ cwd, file, quiet: true }, dependencies), 0);
	assert.equal(await runHeartbeat({ cwd, file, quiet: true, maxTurns: 12, maxIterations: 2 }, dependencies), 0);
	assert.deepEqual(observed, [["task", 40, undefined], ["improve", 40, 1], ["task", 12, undefined], ["improve", 12, 2]]);
});
test("heartbeat reports budget, aborted, empty and improvement failures as unsuccessful work", async t => {
	const { cwd, home } = fixture(t), file = join(home, "HEARTBEAT.md"); writeFileSync(file, "Check the fixture\n");
	for (const messages of [[reply("unfinished", "budget")], [reply("unfinished", "aborted")], []]) {
		assert.equal(await runHeartbeat({ cwd, file, quiet: true }, { doctor, createRunner: async () => ({ model, run: async () => messages }) }), 1);
		const entry = JSON.parse(readFileSync(join(home, "heartbeat.log"), "utf8").trim().split("\n").at(-1)!); assert.equal(entry.tasks[0].ok, false);
	}
	writeFileSync(file, "# improve: review the fixture\n");
	assert.equal(await runHeartbeat({ cwd, file, quiet: true }, { doctor, improve: async () => { throw new Error("turn budget reached; incomplete"); } }), 1);
});

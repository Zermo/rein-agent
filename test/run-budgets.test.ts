import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { configPath, readConfig, saveConfig } from "../src/ai/config.ts";
import { resolveRunBudgets } from "../src/harness/run-budgets.ts";
import { runBudgetSetup } from "../src/harness/budget-setup.ts";
import { createRunner } from "../src/harness/runner.ts";

async function isolated(fn: (home: string) => Promise<void>) {
	const home = mkdtempSync(join(tmpdir(), "rein-budgets-"));
	const prior = process.env.REIN_HOME; process.env.REIN_HOME = home;
	try { await fn(home); } finally { if (prior === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = prior; rmSync(home, { recursive: true, force: true }); }
}
function prompts(answers: string[], log: string[]) {
	return { async ask(question: string, fallback = "") { assert.ok(answers.length, question); return answers.shift()! || fallback; }, async secret() { throw new Error("Budgets must never ask for credentials"); }, close() {}, log: (text: string) => log.push(text) };
}

test("finite foreground limits use explicit > saved > defaults and reject invalid values", () => {
	assert.deepEqual(resolveRunBudgets(), { maxTurns: 300, maxIterations: 25 });
	assert.deepEqual(resolveRunBudgets({ maxTurns: 640, maxIterations: 15 }, { maxTurns: 900 }), { maxTurns: 900, maxIterations: 15 });
	for (const bad of [0, -1, NaN, Infinity, 1.5, null, "300", Number.MAX_SAFE_INTEGER]) {
		assert.throws(() => resolveRunBudgets({ maxTurns: bad }), /maxTurns/);
		assert.throws(() => resolveRunBudgets({ maxIterations: bad }), /maxIterations/);
	}
	assert.throws(() => resolveRunBudgets({ maxTurns: 10001 }), /maxTurns/);
	assert.throws(() => resolveRunBudgets({ maxIterations: 1001 }), /maxIterations/);
});

test("custom offline setup writes visible private limits, preserves other settings, and never calls a model", async t => isolated(async home => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Offline setup attempted networking"); });
	saveConfig({ provider: "custom", model: "fixture-model", apiKey: "fixture-private-key", customSetting: { retained: true } });
	const logs: string[] = [], prompt = prompts(["4", "0", "750", "1.5", "40"], logs);
	await runBudgetSetup({}, { prompt, log: prompt.log });
	assert.deepEqual(readConfig(), { provider: "custom", model: "fixture-model", apiKey: "fixture-private-key", customSetting: { retained: true }, maxTurns: 750, maxIterations: 40 });
	assert.match(readFileSync(configPath(), "utf8"), /\n  "maxTurns": 750/);
	if (process.platform !== "win32") assert.equal(statSync(configPath()).mode & 0o777, 0o600);
	assert.match(logs.join("\n"), /30000 model turns/);
	assert.doesNotMatch(logs.join("\n"), /fixture-private-key/);
	assert.ok(configPath().startsWith(home));
}));

test("missing and empty files initialize on explicit save; status and skip do not write", async () => isolated(async () => {
	const logs: string[] = [];
	await runBudgetSetup({ status: true }, { log: text => logs.push(text) });
	assert.equal(existsSync(configPath()), false);
	assert.match(logs.join("\n"), /300 \(default\)/);
	const prompt = prompts(["5"], logs);
	await runBudgetSetup({}, { prompt, log: prompt.log });
	assert.equal(existsSync(configPath()), false);
	writeFileSync(configPath(), "");
	await runBudgetSetup({ yes: true }, { log: () => {} });
	assert.deepEqual(readConfig(), { maxTurns: 300, maxIterations: 25 });
	const before = readFileSync(configPath(), "utf8");
	await runBudgetSetup({ json: true }, { log: text => { const report = JSON.parse(text); assert.equal(report.source.maxTurns, "saved"); assert.equal(report.configPath, configPath()); } });
	assert.equal(readFileSync(configPath(), "utf8"), before);
}));

test("malformed config is actionable, redacted, and never replaced by budget setup", async () => isolated(async () => {
	for (const text of ['{"apiKey":"private-fixture-token", BROKEN', '[]', 'null', '"private-fixture-token"']) {
		writeFileSync(configPath(), text);
		await assert.rejects(runBudgetSetup({ yes: true }), error => {
			assert.match((error as Error).message, /Invalid Rein config/); assert.doesNotMatch((error as Error).message, /private-fixture-token/); return true;
		});
		assert.equal(readFileSync(configPath(), "utf8"), text);
	}
}));

test("setup rereads unrelated edits and refuses concurrent budget replacement", async () => isolated(async () => {
	saveConfig({ maxTurns: 500 });
	await runBudgetSetup({}, { prompt: { async ask() { saveConfig({ maxTurns: 500, model: "new-fixture" }); return "2"; }, async secret() { return undefined; }, close() {} }, log: () => {} });
	assert.deepEqual(readConfig(), { maxTurns: 1000, maxIterations: 100, model: "new-fixture" });
	await assert.rejects(runBudgetSetup({}, { prompt: { async ask() { saveConfig({ maxTurns: 600, maxIterations: 100 }); return "3"; }, async secret() { return undefined; }, close() {} }, log: () => {} }), /changed during setup/);
	assert.equal(readConfig().maxTurns, 600);
}));

test("invalid saved limits can be repaired in the wizard without losing valid fields or changing anything on skip", async () => isolated(async () => {
	saveConfig({ maxTurns: 0, maxIterations: 80, apiKey: "fixture-kept" });
	const original = readFileSync(configPath(), "utf8"), logs: string[] = [];
	let prompt = prompts(["5"], logs);
	await runBudgetSetup({}, { prompt, log: prompt.log });
	assert.equal(readFileSync(configPath(), "utf8"), original);
	assert.match(logs.join("\n"), /Saved task limits need repair/);
	prompt = prompts(["1"], logs);
	await runBudgetSetup({}, { prompt, log: prompt.log });
	assert.deepEqual(readConfig(), { maxTurns: 300, maxIterations: 80, apiKey: "fixture-kept" });
	await assert.rejects(runBudgetSetup({ maxTurns: 0 }, { prompt, log: prompt.log }), /maxTurns/);
	for (const invalid of [{ invalid: true }, []]) {
		saveConfig({ maxTurns: invalid, maxIterations: 80 });
		prompt = prompts(["1"], logs);
		await runBudgetSetup({}, { prompt, log: prompt.log });
		assert.deepEqual(readConfig(), { maxTurns: 300, maxIterations: 80 });
	}
}));

test("runner respects saved limits and launch override, validating before discovery", async t => isolated(async () => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("No request expected"); });
	saveConfig({ model: "fixture", baseUrl: "http://fixture.invalid/v1", maxTurns: 850, maxIterations: 7 });
	assert.equal((await createRunner({ cwd: process.cwd(), tools: [] })).maxTurns, 850);
	assert.equal((await createRunner({ cwd: process.cwd(), tools: [], maxTurns: 400 })).maxTurns, 400);
	saveConfig({ maxTurns: 0 });
	await assert.rejects(createRunner({ cwd: process.cwd() }), /maxTurns/);
	assert.equal(calls, 0);
}));

test("budget CLI configures offline from an empty file, reports its actual path, and rejects ignored flags", async () => isolated(async home => {
	const cli = (args: string[], input = "") => new Promise<{ code: number | null; text: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [new URL("../bin/rein.js", import.meta.url).pathname, "setup", "budgets", ...args], { cwd: home, env: { ...process.env, REIN_HOME: home } });
		let text = ""; child.stdout.on("data", chunk => text += chunk); child.stderr.on("data", chunk => text += chunk);
		child.on("error", reject); child.on("close", code => resolve({ code, text })); child.stdin.end(input);
	});
	writeFileSync(configPath(), "");
	let result = await cli(["--yes", "--max-turns", "950", "--max-iterations", "45"]);
	assert.equal(result.code, 0, result.text); assert.deepEqual(readConfig(), { maxTurns: 950, maxIterations: 45 });
	result = await cli(["--json"]); assert.equal(JSON.parse(result.text).configPath, configPath());
	for (const flags of [["--yes", "--max-turns", "10001"], ["--status", "--max-turns", "900"], ["--provider", "custom"]]) {
		result = await cli(flags); assert.equal(result.code, 1, result.text); assert.equal(readConfig().maxTurns, 950);
	}
	result = await cli([], "4\n640\n20\n"); assert.equal(result.code, 0, result.text); assert.equal(readConfig().maxTurns, 640);
	result = await cli([], "4\n"); assert.equal(result.code, 1, result.text); assert.equal(readConfig().maxTurns, 640);
}));

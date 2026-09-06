import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_PRESETS } from "../src/ai/models.ts";
import { runAutonomyCommand, serviceConfigurationIssue, type AutonomyCommandDependencies } from "../src/harness/autonomy/command.ts";
import { readState, updateState } from "../src/harness/autonomy/state.ts";
import type { ServiceResult } from "../src/harness/autonomy/service.ts";

function fixture(t: { after: (fn: () => void) => void; mock: { method: (...args: any[]) => any } }) {
	const dir = mkdtempSync(join(tmpdir(), "rein-autonomy-command-"));
	const names = ["REIN_HOME", "REIN_BASE_URL", "REIN_MODEL", "REIN_API_KEY", ...Object.values(PROVIDER_PRESETS).map(p => p.keyEnv)];
	const previous = new Map(names.map(name => [name, process.env[name]]));
	for (const name of names) delete process.env[name];
	process.env.REIN_HOME = join(dir, "home"); mkdirSync(process.env.REIN_HOME);
	const workspace = join(dir, "workspace"); mkdirSync(workspace);
	writeFileSync(join(process.env.REIN_HOME, "config.json"), JSON.stringify({ provider: "custom", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model" }));
	const messages: string[] = [];
	t.mock.method(console, "log", (...args: unknown[]) => messages.push(args.map(String).join(" ")));
	t.after(() => { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } rmSync(dir, { recursive: true, force: true }); });
	const result: ServiceResult = { manager: "launchd", path: "/mock/rein.plist", installed: true, active: true, message: "Autonomy service is running." };
	const dependencies: AutonomyCommandDependencies = { serviceOptions: () => ({ home: process.env.REIN_HOME!, cliPath: "/mock/rein.js", nodePath: process.execPath }), install: () => result, wait: async (_options, initial) => initial, uninstall: () => ({ ...result, installed: false, active: false, message: "Uninstalled" }) };
	return { workspace, messages, dependencies, result };
}

test("service configuration rejects terminal-only overrides without exposing credential values", () => {
	const config = { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "saved-model" };
	assert.match(serviceConfigurationIssue(config, { REIN_BASE_URL: "https://other.invalid/v1" })!, /REIN_BASE_URL/);
	assert.match(serviceConfigurationIssue(config, { REIN_MODEL: "different-model" })!, /REIN_MODEL/);
	for (const keyName of ["REIN_API_KEY", "OPENAI_API_KEY"]) {
		const issue = serviceConfigurationIssue(config, { [keyName]: "fixture_terminal_secret" })!;
		assert.match(issue, /terminal-only API credential/);
		assert.ok(issue.includes(keyName)); assert.ok(!issue.includes("fixture_terminal_secret"));
	}
	assert.match(serviceConfigurationIssue({ ...config, apiKey: "old_saved_key" }, { OPENAI_API_KEY: "new_terminal_key" })!, /differs from the saved connection/);
	assert.equal(serviceConfigurationIssue({ ...config, apiKey: "same-key" }, { OPENAI_API_KEY: "same-key", REIN_BASE_URL: "https://api.openai.com/v1/chat/completions", REIN_MODEL: " saved-model " }), undefined);
	assert.equal(serviceConfigurationIssue({ provider: "custom", baseUrl: "http://10.0.0.1:8000/v1", model: "local" }, { OPENAI_API_KEY: "unrelated" }), undefined);
	assert.equal(serviceConfigurationIssue({ provider: "codex", model: "default", auth: { type: "cli", provider: "codex" } }, { OPENAI_API_KEY: "ignored-for-subscription" }), undefined);
});

test("incompatible service credentials pause before installation and are never copied", async t => {
	const { workspace, dependencies } = fixture(t);
	process.env.REIN_API_KEY = "fixture_terminal_key";
	await updateState(state => { state.planner = "main"; });
	let installs = 0;
	await assert.rejects(runAutonomyCommand(["enable"], { workspace }, { ...dependencies, install: () => { installs++; return dependencies.install!({ home: "/mock", cliPath: "/mock/rein.js" }); } }), /terminal-only API credential/);
	assert.equal(installs, 0); assert.equal(readState().paused, true);
	assert.ok((readState().controlRevision ?? 0) >= 1);
	assert.ok(!JSON.stringify(readState()).includes("fixture_terminal_key"));
});

test("rules-only service starts without a main provider or terminal credentials", async t => {
	const { workspace, dependencies } = fixture(t);
	process.env.REIN_API_KEY = "fixture_not_copied";
	process.env.REIN_BASE_URL = "https://unused.invalid/v1";
	await runAutonomyCommand(["enable"], { workspace }, dependencies);
	assert.equal(readState().paused, false); assert.equal(readState().planner, "rules");
	assert.ok(!JSON.stringify(readState()).includes("fixture_not_copied"));
});

test("planner selection is explicit, invalidates changed-evidence checkpoint, and keeps decisions", async t => {
	const { messages } = fixture(t);
	await updateState(state => { state.lastDigest = "old"; state.nextScan = Date.now() + 60000; });
	await runAutonomyCommand(["planner", "main"]);
	assert.equal(readState().planner, "main"); assert.equal(readState().lastDigest, undefined); assert.equal(readState().nextScan, undefined);
	assert.match(messages.at(-1)!, /credits or subscription/);
	await runAutonomyCommand(["planner", "rules"]); assert.equal(readState().planner, "rules");
	await assert.rejects(runAutonomyCommand(["planner", "cloud"]), /rules\|main/);
});
test("a running rules service cannot switch to another terminal-only model/account implicitly", async t => {
	const { dependencies, result } = fixture(t);
	process.env.REIN_API_KEY = "fixture_not_saved";
	const service = { ...dependencies, status: () => result };
	await assert.rejects(runAutonomyCommand(["planner", "main"], {}, service), /not enabled.*terminal-only/);
	assert.equal(readState().planner, "rules");
	await updateState(state => { state.proposals.push({ id: "check", workspace: "/synthetic/work", title: "Check", kind: "project", prompt: "Review current status", reason: "Requested", evidenceIds: [], intervalMinutes: 1440, status: "pending", created: 0, allowWrites: false }); });
	await assert.rejects(runAutonomyCommand(["approve", "check"], {}, service), /not enabled.*terminal-only/);
	assert.equal(readState().proposals[0].status, "pending");
});

test("enable requires verified active status and leaves stopped or unknown services paused", async t => {
	const { workspace, messages, dependencies, result } = fixture(t);
	for (const active of [false, null]) {
		await assert.rejects(runAutonomyCommand(["enable"], { workspace }, { ...dependencies, wait: async () => ({ ...result, active, message: "Installed; startup not confirmed." }) }), /remains paused.*resume followed by rein autonomy daemon/);
		assert.equal(readState().paused, true);
	}
	await runAutonomyCommand(["enable"], { workspace }, dependencies);
	assert.equal(readState().paused, false);
	assert.match(messages.at(-1)!, /Autonomy enabled/);
});

test("a newer pause during service startup takes precedence over successful startup", async t => {
	const { workspace, messages, dependencies, result } = fixture(t);
	await runAutonomyCommand(["enable"], { workspace }, { ...dependencies, wait: async () => {
		await runAutonomyCommand(["pause"]);
		return result;
	} });
	assert.equal(readState().paused, true);
	assert.match(messages.at(-1)!, /newer autonomy controls/);
});

test("explicit command controls advance revision even when pause state is unchanged", async t => {
	const { workspace, dependencies } = fixture(t);
	for (const command of ["init", "pause", "pause", "resume", "unenroll", "disable"]) {
		const revision = readState().controlRevision ?? 0;
		await runAutonomyCommand([command], { workspace }, dependencies);
		assert.ok((readState().controlRevision ?? 0) > revision, command);
	}
});

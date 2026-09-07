import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runModelCommand, type ModelCommandDependencies } from "../src/models/command.ts";
import type { ModelArtifact } from "../src/models/artifacts.ts";
import type { HardwareProfile } from "../src/hardware/profile.ts";
import { runOSCommand } from "../src/os/command.ts";

const id = "a".repeat(64), token = "hf_fixture_secret", localKey = "d".repeat(64);
const artifact: ModelArtifact = { schemaVersion: 1, id, repo: "fixture/Tiny", revision: "b".repeat(40), file: "tiny.gguf", sha256: "c".repeat(64), sizeBytes: 128, url: "https://huggingface.co/fixture/Tiny" };
const machine: HardwareProfile = { os: "linux", arch: "x64", cpu: { name: "Fixture", cores: 8, physicalCores: 8, features: [] }, ram: { totalBytes: 32 * 1024 ** 3, availableBytes: 24 * 1024 ** 3 }, gpus: [], unifiedMemory: false };
test("plan stays read-only and install forwards the resolved immutable artifact", async () => {
	const log: string[] = []; let installs = 0;
	const deps: ModelCommandDependencies = { log: line => log.push(line), account: async () => ({ source: "environment", token }), hardware: async () => machine,
		resolveArtifact: async (repo, file, options) => { assert.equal(repo, artifact.repo); assert.equal(file, artifact.file); assert.equal(options?.token, token); return artifact; },
		installArtifact: async (selected, options) => { installs++; assert.equal(selected, artifact); assert.equal(options?.token, token); return { artifact, path: "/fixture/model.gguf", installedAt: "fixture" }; },
	};
	await runModelCommand(["plan", artifact.repo], { file: artifact.file, json: true }, deps);
	assert.equal(JSON.parse(log.pop()!).memory, null); assert.equal(installs, 0);
	await runModelCommand(["install", artifact.repo], { file: artifact.file, json: true }, deps);
	assert.equal(JSON.parse(log.pop()!).artifact.revision, artifact.revision); assert.equal(installs, 1);
});
test("account availability and credential failures never expose secret values", async () => {
	const log: string[] = [];
	await runModelCommand(["account"], { json: true }, { log: line => log.push(line), account: async () => ({ source: "environment", token }) });
	assert.deepEqual(JSON.parse(log[0]), { authenticated: true, source: "environment", verified: false }); assert.ok(!log[0].includes(token));
	await assert.rejects(runModelCommand(["plan", artifact.repo], { file: artifact.file }, { account: async () => ({ source: "environment", token }), resolveArtifact: async () => { throw new Error(`fixture ${token}`); } }), error => !String(error).includes(token));
});
test("using a tested local model keeps budgets and fallback accounts and sets its real context", async () => {
	let saved: any; const output: string[] = [];
	const previous = { provider: "codex", auth: { type: "cli", provider: "codex" }, sshHost: "fixture-host", apiKey: "old-key", maxTurns: 900, maxIterations: 50, contextWindow: 262144, fallbackAccounts: [{ provider: "fixture-cloud" }], customSetting: { keep: true } };
	await runModelCommand(["use", id], { json: true }, {
		log: line => output.push(line), connection: async () => ({ baseUrl: "http://127.0.0.1:11436/v1", model: id, apiKey: localKey, context: 8192 }),
		test: async (_base, model, key) => { assert.equal(model, id); assert.equal(key, localKey); return { ok: true, detail: "fixture" }; },
		readConfig: () => previous, saveConfig: value => { saved = value; },
	});
	assert.equal(saved.maxTurns, 900); assert.equal(saved.maxIterations, 50); assert.equal(saved.contextWindow, 8192);
	assert.deepEqual(saved.fallbackAccounts, previous.fallbackAccounts); assert.deepEqual(saved.customSetting, previous.customSetting);
	assert.equal(saved.sshHost, undefined); assert.deepEqual(saved.auth, { type: "api-key" }); assert.equal(saved.apiKey, localKey);
	assert.equal(previous.sshHost, "fixture-host"); assert.ok(!output.join(" ").includes(localKey));
});
test("failed or cancelled connection handoff preserves config and redacts credentials", async () => {
	let saves = 0;
	await assert.rejects(runModelCommand(["use", id], {}, { connection: async () => ({ baseUrl: "http://127.0.0.1:11436/v1", model: id, apiKey: localKey, context: 4096 }), readConfig: () => ({}), saveConfig: () => { saves++; }, test: async () => ({ ok: false, detail: localKey }) }), error => { assert.match(String(error), /preserved/); return !String(error).includes(localKey); });
	const controller = new AbortController(); controller.abort();
	await assert.rejects(runModelCommand(["use", id], {}, { signal: controller.signal, saveConfig: () => { saves++; } }), /cancelled/);
	assert.equal(saves, 0);
});
test("connection handoff merges settings changed during the asynchronous probe", async () => {
	let current = { maxTurns: 900, customSetting: "before" }, saved: any;
	await runModelCommand(["use", id], {}, {
		log: () => {}, connection: async () => ({ baseUrl: "http://127.0.0.1:11436/v1", model: id, apiKey: localKey, context: 4096 }),
		readConfig: () => current, saveConfig: value => { saved = value; },
		test: async () => { await Promise.resolve(); current = { maxTurns: 1200, customSetting: "updated" }; return { ok: true, detail: "fixture" }; },
	});
	assert.equal(saved.maxTurns, 1200); assert.equal(saved.customSetting, "updated");
});
test("unknown commands and flags cannot trigger network or service writes", async () => {
	let network = 0; const deps: ModelCommandDependencies = { account: async () => { network++; return { source: "none" }; } };
	for (const [args, flags] of [[["plan", artifact.repo], { file: true }], [["install", artifact.repo], { file: artifact.file, token: "do-not-accept" }], [["serve", id], { port: "0" }], [["remove", id], {}], [["service", "remove", id], { runtime: "/fixture" }]] as [string[], Record<string, string | boolean>][]) await assert.rejects(runModelCommand(args, flags, deps));
	assert.equal(network, 0);
});
test("OS command uses platform evidence and rejects execution-like flags", async () => {
	const lines: string[] = []; let probes = 0;
	await runOSCommand(["plan"], { mode: "image", json: true }, { log: line => lines.push(line), hardware: async () => { probes++; return machine; } });
	assert.equal(JSON.parse(lines[0]).mode, "image"); assert.equal(probes, 1);
	await assert.rejects(runOSCommand(["plan"], { apply: true }, { hardware: async () => { probes++; return machine; } }), /Unsupported/);
	await assert.rejects(runOSCommand(["prepare"], { output: true }), /new directory|directory path/);
	assert.equal(probes, 1);
});
test("real source CLI routes managed-model commands without changing server discovery aliases", { timeout: 10000 }, async () => {
	const home = await mkdtemp(join(tmpdir(), "rein-model-cli-"));
	const run = (args: string[]) => new Promise<{ code: number | null; text: string }>((done, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/rein.js", import.meta.url)), ...args], { env: { ...process.env, REIN_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
		let text = ""; child.stdout.on("data", chunk => text += chunk); child.stderr.on("data", chunk => text += chunk); child.on("error", reject); child.on("close", code => done({ code, text }));
	});
	try {
		for (const alias of ["model", "models"]) { const result = await run([alias, "list", "--json"]); assert.equal(result.code, 0, result.text); assert.deepEqual(JSON.parse(result.text), []); }
		const help = await run(["model", "help"]); assert.equal(help.code, 0); assert.match(help.text, /service install/);
		const invalid = await run(["os", "plan", "--apply"]); assert.equal(invalid.code, 1);
		assert.deepEqual(await readdir(home), []);
	} finally { await rm(home, { recursive: true, force: true }); }
});

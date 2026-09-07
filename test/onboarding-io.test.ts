import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROVIDER_PRESETS } from "../src/ai/models.ts";
import { runOnboarding } from "../src/harness/onboarding.ts";
import { createSetupPrompt } from "../src/harness/setup.ts";
import { readOperatorProfile } from "../src/harness/operator-profile.ts";
import { readState, updateState } from "../src/harness/autonomy/state.ts";
import { runAutonomyCommand } from "../src/harness/autonomy/command.ts";

async function isolated(run: (home: string) => Promise<void>): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "rein-onboarding-io-"));
	const keys = [...new Set(["REIN_HOME", "REIN_API_KEY", "REIN_BASE_URL", "REIN_MODEL", ...Object.values(PROVIDER_PRESETS).map(provider => provider.keyEnv)])];
	const previous = new Map(keys.map(key => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	process.env.REIN_HOME = home;
	try { await run(home); }
	finally {
		for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		rmSync(home, { recursive: true, force: true });
	}
}

function queuedPrompt(answers: string[]) {
	const input = new PassThrough(), output = new PassThrough();
	let transcript = "", closes = 0;
	output.on("data", chunk => { transcript += chunk; });
	const base = createSetupPrompt(input, output);
	const prompt = { ...base, close() { closes++; base.close(); } };
	input.end(answers.join("\n") + "\n");
	return { prompt, transcript: () => transcript, closes: () => closes, dispose() { base.close(); input.destroy(); output.destroy(); } };
}

test("queued answers survive profile, real HTTP setup, and follow-up choices on one prompt", { timeout: 10000 }, async () => isolated(async home => {
	const requests: { method: string | undefined; path: string | undefined; authorization: string | undefined; body: string }[] = [];
	const server = createServer(async (req, res) => {
		let body = ""; for await (const chunk of req) body += chunk;
		requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
		res.setHeader("content-type", "application/json");
		res.end(req.method === "GET" ? JSON.stringify({ data: [{ id: "queued-input-model" }] }) : JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const io = queuedPrompt(["a", "a", "c", "a", "a", "a", "3", "1", "4", "750", "40", "", "3", "1", "caller-still-owns-this-prompt"]);
	const logs: string[] = [];
	let autonomyCalls = 0;
	try {
		const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
		const code = await runOnboarding({ provider: "custom", baseUrl, model: "queued-input-model", noBrowser: true, maxTurns: 500 }, {
			prompt: io.prompt, log: text => logs.push(text),
			autonomy: async () => { autonomyCalls++; throw new Error("A skipped follow-up must not invoke autonomy."); },
		});
		assert.equal(code, 0, logs.join("\n") + io.transcript());
		assert.deepEqual(requests.map(request => `${request.method} ${request.path}`), ["GET /v1/models", "POST /v1/chat/completions"]);
		assert.ok(requests.every(request => request.authorization === undefined));
		assert.equal(JSON.parse(requests[1].body).model, "queued-input-model");
		const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
		assert.equal(config.baseUrl, baseUrl); assert.equal(config.model, "queued-input-model");
		assert.equal(config.maxTurns, 750); assert.equal(config.maxIterations, 40);
		assert.equal(config.api, "chat-completions"); assert.equal(config.apiKey, undefined);
		assert.equal(readOperatorProfile(home).profile!.enabled_pack, null);
		assert.equal(autonomyCalls, 0);
		assert.match(logs.join("\n"), /Setup complete/);
		assert.doesNotMatch(logs.join("\n"), /Setup input closed|Connection needs attention/);
		assert.equal(io.closes(), 0, "onboarding and HTTP setup must leave an injected caller-owned prompt open");
		assert.equal(await io.prompt.ask("Next caller question: "), "caller-still-owns-this-prompt");
		assert.equal(readState().workspaces.length, 0);
	} finally {
		io.dispose();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}));

test("a prompt created after consumed EOF rejects immediately instead of leaving an unsettled question", { timeout: 2000 }, async () => {
	const input = new PassThrough(), output = new PassThrough();
	output.resume(); input.resume();
	const ended = once(input, "end");
	input.end("already consumed\n");
	await ended;
	assert.equal(input.readableEnded, true);
	const prompt = createSetupPrompt(input, output);
	try { await assert.rejects(prompt.ask("Choose: ", "1"), /Setup input closed/); }
	finally { prompt.close(); input.destroy(); output.destroy(); }
});

test("a prompt created with destroyed input also fails closed", { timeout: 2000 }, async () => {
	const input = new PassThrough(), output = new PassThrough();
	output.resume(); input.destroy();
	assert.equal(input.destroyed, true);
	const prompt = createSetupPrompt(input, output);
	try { await assert.rejects(prompt.ask("Choose: "), /Setup input closed/); }
	finally { prompt.close(); output.destroy(); }
});

test("full noninteractive CLI setup rejects before creating a profile or connection", { timeout: 10000 }, async () => isolated(async home => {
	const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/rein.js", import.meta.url)), "setup", "--provider", "custom", "--base-url", "http://fixture.invalid/v1", "--model", "must-not-connect", "--no-browser"], {
			cwd: home, env: { ...process.env, REIN_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
		child.on("error", reject); child.on("close", code => resolve({ code, output }));
		child.stdin.end("a\na\nc\na\n1\n1\n\n3\n");
	});
	assert.equal(result.code, 1, result.output);
	assert.match(result.output, /needs an interactive terminal/);
	assert.match(result.output, /rein setup --yes/);
	assert.match(result.output, /rein setup profile/);
	assert.doesNotMatch(result.output, /Your operator profile|Choose \[|Setup complete/);
	assert.deepEqual(readdirSync(home), []);
}));

test("manual onboarding pauses a previously resumed state with no enrolled folders", { timeout: 5000 }, async () => isolated(async home => {
	await updateState(state => { state.paused = false; state.workspaces = []; });
	const io = queuedPrompt(["skip", "1", "1", home, "1", "1", "1", "1"]);
	const logs: string[] = [], autonomyCommands: string[] = [];
	try {
		const code = await runOnboarding({ provider: "custom", baseUrl: "http://fixture.invalid/v1", model: "manual-state-fixture", noBrowser: true }, {
			prompt: io.prompt, log: text => logs.push(text), setup: async () => 0,
			autonomy: async (args, flags) => {
				autonomyCommands.push(args[0]);
				assert.ok(["pause", "init"].includes(args[0]), "this regression must never install or start a service");
				await runAutonomyCommand(args, flags);
			},
		});
		assert.equal(code, 0, logs.join("\n") + io.transcript());
		assert.deepEqual(autonomyCommands, ["pause", "init"]);
		assert.equal(readState().paused, true);
		assert.deepEqual(readState().workspaces, [realpathSync(home)]);
		assert.match(logs.join("\n"), /background work stays paused/);
	} finally { io.dispose(); }
}));

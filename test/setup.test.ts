import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { runSetup, createSetupPrompt, testConnection, API_KEY_PAGES } from "../src/harness/setup.ts";
import type { SetupDependencies, SetupPrompt } from "../src/harness/setup.ts";
import { PROVIDER_PRESETS } from "../src/ai/models.ts";

async function isolated(run: (home: string, configFile: string) => Promise<void>) {
	const home = mkdtempSync(join(tmpdir(), "rein-setup-test-"));
	const keys = ["REIN_HOME", "REIN_API_KEY", "REIN_BASE_URL", "REIN_MODEL", ...Object.values(PROVIDER_PRESETS).map(p => p.keyEnv)];
	const previous = new Map(keys.map(key => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	process.env.REIN_HOME = home;
	try { await run(home, join(home, "config.json")); }
	finally {
		for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		rmSync(home, { recursive: true, force: true });
	}
}
function forbiddenPrompt(): SetupPrompt {
	return { ask: async () => { throw new Error("Unexpected interactive prompt"); }, secret: async () => { throw new Error("Unexpected secret prompt"); }, close() {} };
}
function deps(logs: string[]): SetupDependencies {
	return { log: text => logs.push(text), prompt: forbiddenPrompt(), discover: async () => [], keyFor: () => undefined,
		detect: async baseUrl => ({ baseUrl, provider: "custom", models: ["remote-model"] }),
		connection: async () => ({ ok: true, detail: "test passed" }),
		openBrowser: async () => { throw new Error("Unexpected browser open"); },
		login: async () => { throw new Error("Unexpected login"); },
	};
}

test("unattended custom host discovers a model with credentials before probing, without persisting environment keys", async () => isolated(async (_home, path) => {
	const logs: string[] = []; const calls: string[] = [];
	process.env.REIN_API_KEY = "environment-secret-example";
	const code = await runSetup({ yes: true, baseUrl: "100.84.1.2:1234" }, {
		...deps(logs), keyFor: () => process.env.REIN_API_KEY,
		detect: async (baseUrl, options) => {
			assert.equal(baseUrl, "http://100.84.1.2:1234/v1");
			assert.equal(options?.apiKey, process.env.REIN_API_KEY);
			calls.push("detect"); return { baseUrl, provider: "lmstudio", models: ["loaded-model"] };
		},
		connection: async (baseUrl, model, key) => { calls.push("test"); assert.equal(model, "loaded-model"); assert.equal(key, process.env.REIN_API_KEY); return { ok: true, detail: "validated" }; },
	});
	assert.equal(code, 0, logs.join("\n")); assert.deepEqual(calls, ["detect", "test"]);
	const config = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(config.baseUrl, "http://100.84.1.2:1234/v1"); assert.equal(config.provider, "lmstudio");
	assert.equal(config.apiKey, undefined); assert.deepEqual(config.auth, { type: "api-key" });
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.doesNotMatch(logs.join("\n"), /environment-secret-example/);
}));

test("--yes with no endpoint fails without asking, opening browsers, or saving", async () => isolated(async (_home, path) => {
	const logs: string[] = [];
	assert.equal(await runSetup({ yes: true }, deps(logs)), 1);
	assert.match(logs.join("\n"), /--base-url/); assert.equal(existsSync(path), false);
}));

test("existing configuration wins over discovery and is saved privately, while failures preserve it", async () => isolated(async (_home, path) => {
	const original = { provider: "custom", baseUrl: "http://remote.internal:1234/v1", model: "existing", apiKey: "saved-secret-example", temperature: 0.3 };
	writeFileSync(path, JSON.stringify(original)); chmodSync(path, 0o666);
	const logs: string[] = [];
	const defaults = { ...deps(logs), keyFor: () => original.apiKey, discover: async () => { throw new Error("Existing config should skip local discovery"); } };
	assert.equal(await runSetup({ yes: true }, defaults), 0, logs.join("\n"));
	assert.equal(statSync(path).mode & 0o777, 0o600);
	const saved = JSON.parse(readFileSync(path, "utf8")); assert.equal(saved.apiKey, original.apiKey); assert.equal(saved.temperature, 0.3); assert.equal(saved.model, "existing");
	const before = readFileSync(path, "utf8");
	assert.equal(await runSetup({ yes: true }, { ...defaults, connection: async () => ({ ok: false, detail: "server echoed saved-secret-example" }) }), 1);
	assert.equal(readFileSync(path, "utf8"), before);
	assert.doesNotMatch(logs.join("\n"), /saved-secret-example/);
}));

test("interactive cloud setup opens the official keys page before authenticated discovery", async () => isolated(async (_home, path) => {
	const logs: string[] = []; const order: string[] = []; let closed = 0;
	assert.equal(await runSetup({ provider: "openai", model: "chosen-model" }, {
		...deps(logs), prompt: { ask: async () => { throw new Error("Model supplied"); }, secret: async () => { order.push("secret"); return "typed-secret-example"; }, close() { closed++; } },
		openBrowser: async url => { assert.equal(url, API_KEY_PAGES.openai); order.push("browser"); return false; },
		detect: async (baseUrl, options) => { order.push("detect"); assert.equal(options?.apiKey, "typed-secret-example"); return { baseUrl, provider: "openai", models: [] }; },
	}), 0, logs.join("\n"));
	assert.deepEqual(order, ["browser", "secret", "detect"]); assert.equal(closed, 1);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).apiKey, "typed-secret-example");
	assert.match(logs.join("\n"), /Browser could not open/); assert.doesNotMatch(logs.join("\n"), /typed-secret-example/);
}));

test("CLI setup keeps official credentials out of Rein config and --yes never logs in", async () => isolated(async (_home, path) => {
	writeFileSync(path, JSON.stringify({ apiKey: "old-api-secret", provider: "openai", baseUrl: "https://api.openai.com/v1", model: "old" }));
	const logs: string[] = [];
	assert.equal(await runSetup({ yes: true, auth: "cli", cliProvider: "codex" }, { ...deps(logs), cliStatus: async () => ({ available: true, authenticated: false, detail: "Login required" }) }), 1);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).apiKey, "old-api-secret");
	assert.equal(await runSetup({ yes: true, auth: "cli", cliProvider: "codex" }, { ...deps(logs), cliStatus: async () => ({ available: true, authenticated: true, detail: "Authenticated" }) }), 0);
	const config = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(config.auth, { type: "cli", provider: "codex" }); assert.equal(config.baseUrl, "cli://codex"); assert.equal(config.apiKey, undefined); assert.equal(config.model, "default");
}));

test("SSH setup persists the logical endpoint and scopes saved credentials to the SSH host", async () => isolated(async (_home, path) => {
	writeFileSync(path, JSON.stringify({ provider: "custom", sshHost: "old-host", baseUrl: "http://127.0.0.1:18083/v1", apiKey: "old-host-secret", model: "old" }));
	const logs: string[] = [];
	assert.equal(await runSetup({ yes: true, sshHost: "dgx", baseUrl: "127.0.0.1:18083" }, {
		...deps(logs), keyFor: (_provider, _url, sshHost) => { assert.equal(sshHost, "dgx"); return undefined; },
		detect: async (baseUrl, options) => { assert.equal(options?.sshHost, "dgx"); assert.equal(options?.apiKey, undefined); return { baseUrl, provider: "custom", models: ["dgx-model"] }; },
		connection: async (baseUrl, model, key, options) => { assert.equal(baseUrl, "http://127.0.0.1:18083/v1"); assert.equal(options?.sshHost, "dgx"); return { ok: true, detail: "mock SSH passed" }; },
	}), 0, logs.join("\n"));
	const config = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(config.baseUrl, "http://127.0.0.1:18083/v1"); assert.equal(config.sshHost, "dgx"); assert.equal(config.apiKey, undefined); assert.equal(config.model, "dgx-model");
}));

test("setup prompt preserves queued answers and releases stdin listeners on EOF", async () => {
	const input = new PassThrough(); const output = new PassThrough(); output.resume();
	const before = input.listenerCount("data");
	const prompt = createSetupPrompt(input, output);
	input.end("first\n\n");
	assert.equal(await prompt.ask("first? "), "first");
	assert.equal(await prompt.ask("second? ", "default"), "default");
	await assert.rejects(prompt.ask("third? "), /input closed/);
	assert.equal(await prompt.secret("secret? "), undefined);
	prompt.close(); assert.equal(input.listenerCount("data"), before);
});

test("connection test rejects a successful HTTP response that is not a chat completion", async () => {
	const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "healthy" })); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try { const port = (server.address() as { port: number }).port; assert.equal((await testConnection(`http://127.0.0.1:${port}/v1`, "test")).ok, false); }
	finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("known cloud URLs chosen as custom use the provider key flow and honor no-browser", async () => isolated(async (_home, path) => {
	const logs: string[] = []; let asked = 0;
	assert.equal(await runSetup({ provider: "custom", baseUrl: "https://api.openai.com", model: "chosen", noBrowser: true }, {
		...deps(logs), prompt: { ask: async () => { throw new Error("Known cloud should not ask for SSH"); }, secret: async () => { asked++; return "cloud-secret"; }, close() {} },
		keyFor: provider => { assert.equal(provider, "openai"); return undefined; },
		detect: async (baseUrl, options) => { assert.equal(options?.provider, "openai"); return { baseUrl, provider: "openai", models: [] }; },
	}), 0, logs.join("\n"));
	assert.equal(asked, 1); assert.match(logs.join("\n"), /platform.openai.com\/api-keys/);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).provider, "openai");
}));

test("CLI setup rejects an HTTP environment override before checking or logging in", async () => isolated(async (_home, path) => {
	process.env.REIN_BASE_URL = "http://remote.internal:1234";
	const logs: string[] = [];
	assert.equal(await runSetup({ yes: true, auth: "cli", cliProvider: "codex" }, { ...deps(logs), cliStatus: async () => { throw new Error("Must reject before CLI check"); } }), 1);
	assert.match(logs.join("\n"), /REIN_BASE_URL/); assert.equal(existsSync(path), false);
}));

test("connection helper redacts credentials before truncating echoed error bodies", async () => {
	const key = "secret-" + "x".repeat(400);
	const server = createServer((_req, res) => { res.writeHead(401); res.end(`Rejected ${key}`); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const port = (server.address() as { port: number }).port;
		const result = await testConnection(`http://127.0.0.1:${port}/v1`, "test", key);
		assert.equal(result.ok, false); assert.doesNotMatch(result.detail, /secret-|xxxx/); assert.match(result.detail, /\[redacted\]/);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("explicit provider outranks ambient endpoint while explicit base URL wins both", async () => isolated(async (_home, path) => {
	process.env.REIN_BASE_URL = "http://ambient.internal:1234/v1";
	const logs: string[] = []; const probed: string[] = [];
	const defaults: SetupDependencies = { ...deps(logs), keyFor: () => "test-key", detect: async baseUrl => { probed.push(baseUrl); return { baseUrl, provider: "openai", models: ["chosen"] }; } };
	assert.equal(await runSetup({ yes: true, provider: "openai" }, defaults), 0, logs.join("\n"));
	assert.equal(probed[0], PROVIDER_PRESETS.openai.baseUrl);
	assert.equal(await runSetup({ yes: true, provider: "openai", baseUrl: "http://explicit.internal:9999/v1" }, defaults), 0, logs.join("\n"));
	assert.equal(probed[1], "http://explicit.internal:9999/v1");
	assert.equal(JSON.parse(readFileSync(path, "utf8")).baseUrl, probed[1]);
}));

test("blank endpoint/model environment variables do not hide saved settings, and values are trimmed", async () => isolated(async (_home, path) => {
	const baseUrl = "http://saved.internal:1234/v1";
	writeFileSync(path, JSON.stringify({ provider: "custom", baseUrl, model: "saved-model" }));
	process.env.REIN_BASE_URL = "   "; process.env.REIN_MODEL = "  ";
	const logs: string[] = [];
	assert.equal(await runSetup({ yes: true }, { ...deps(logs), detect: async url => { assert.equal(url, baseUrl); return { baseUrl: url, provider: "custom", models: ["different"] }; } }), 0, logs.join("\n"));
	assert.equal(JSON.parse(readFileSync(path, "utf8")).model, "saved-model");
	process.env.REIN_BASE_URL = "  http://remote.internal:4321/v1  "; process.env.REIN_MODEL = "  env-model  ";
	assert.equal(await runSetup({ yes: true }, deps(logs)), 0, logs.join("\n"));
	const saved = JSON.parse(readFileSync(path, "utf8")); assert.equal(saved.baseUrl, "http://remote.internal:4321/v1"); assert.equal(saved.model, "env-model");
}));

test("Gemini setup opens AI Studio and retired GitHub Models returns migration guidance", async () => isolated(async (_home, path) => {
	const logs: string[] = []; const opened: string[] = [];
	assert.equal(await runSetup({ provider: "gemini", model: "chosen" }, { ...deps(logs),
		prompt: { ask: async () => { throw new Error("No question expected"); }, secret: async () => "test-gemini-key", close() {} },
		openBrowser: async url => { opened.push(url); return true; },
		detect: async baseUrl => ({ baseUrl, provider: "gemini", models: ["chosen"] }),
	}), 0, logs.join("\n"));
	assert.deepEqual(opened, ["https://aistudio.google.com/apikey"]);
	const before = readFileSync(path, "utf8");
	assert.equal(await runSetup({ yes: true, provider: "github" }, deps(logs)), 1);
	assert.match(logs.join("\n"), /GitHub Models was retired.*July 30, 2026/);
	assert.match(logs.join("\n"), /Copilot CLI/); assert.equal(readFileSync(path, "utf8"), before);
}));

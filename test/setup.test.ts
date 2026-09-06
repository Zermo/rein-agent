import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { runSetup, createSetupPrompt, testConnection, API_KEY_PAGES } from "../src/harness/setup.ts";
import type { SetupDependencies, SetupPrompt } from "../src/harness/setup.ts";
import { PROVIDER_PRESETS, apiKeyFor, resolveModel } from "../src/ai/models.ts";
import type { DiscoveredServer, ServerDiscoveryReport } from "../src/ai/models.ts";

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

test("connection setup refuses to overwrite budgets or credentials edited while its probe runs", async () => isolated(async (_home, path) => {
	const original = { provider: "custom", baseUrl: "http://fixture.invalid/v1", model: "fixture", maxTurns: 300, maxIterations: 25 };
	const newer = { ...original, maxTurns: 500, maxIterations: 80, apiKey: "concurrent-fixture-secret", extension: { keep: true } };
	writeFileSync(path, JSON.stringify(original));
	const logs: string[] = [];
	const code = await runSetup({ yes: true }, { ...deps(logs), connection: async () => { writeFileSync(path, JSON.stringify(newer)); return { ok: true, detail: "fixture passed" }; } });
	assert.equal(code, 1);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), newer);
	assert.match(logs.join("\n"), /changed during connection setup/);
	assert.doesNotMatch(logs.join("\n"), /concurrent-fixture-secret/);
}));
function deps(logs: string[]): SetupDependencies {
	return { log: text => logs.push(text), prompt: forbiddenPrompt(), discover: async () => [], servingAdvice: async () => {}, keyFor: () => undefined,
		detect: async baseUrl => ({ baseUrl, provider: "custom", models: ["remote-model"] }),
		connection: async () => ({ ok: true, detail: "test passed" }),
		openBrowser: async () => { throw new Error("Unexpected browser open"); },
		login: async () => { throw new Error("Unexpected login"); },
	};
}
function reportFor(servers: DiscoveredServer[], network = true): ServerDiscoveryReport {
	return { servers, results: servers, scanned: servers.length, candidateCount: servers.length, sources: [], truncated: false, timedOut: false, network };
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
	writeFileSync(path, JSON.stringify({ provider: "custom", sshHost: "old-host", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "old-host-secret", model: "old" }));
	const logs: string[] = [];
	assert.equal(await runSetup({ yes: true, sshHost: "model-host", baseUrl: "127.0.0.1:1234" }, {
		...deps(logs), keyFor: (_provider, _url, sshHost) => { assert.equal(sshHost, "model-host"); return undefined; },
		detect: async (baseUrl, options) => { assert.equal(options?.sshHost, "model-host"); assert.equal(options?.apiKey, undefined); return { baseUrl, provider: "custom", models: ["remote-model"] }; },
		connection: async (baseUrl, model, key, options) => { assert.equal(baseUrl, "http://127.0.0.1:1234/v1"); assert.equal(options?.sshHost, "model-host"); return { ok: true, detail: "mock SSH passed" }; },
	}), 0, logs.join("\n"));
	const config = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(config.baseUrl, "http://127.0.0.1:1234/v1"); assert.equal(config.sshHost, "model-host"); assert.equal(config.apiKey, undefined); assert.equal(config.model, "remote-model");
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

test("Grok subscription setup saves the official CLI route without an API key or HTTP probe", async () => isolated(async (_home, path) => {
	const logs: string[] = []; let signedIn = false;
	assert.equal(await runSetup({ provider: "grok" }, {
		...deps(logs), cliStatus: async p => { assert.equal(p, "grok"); return { available: true, authenticated: null, detail: "Installed" }; },
		login: async (p, options) => { assert.equal(p, "grok"); assert.equal(options.deviceAuth, true); signedIn = true; return { ok: true, detail: "Signed in" }; },
		detect: async () => { throw new Error("CLI is not HTTP"); }, connection: async () => { throw new Error("CLI is not HTTP"); },
	}), 0, logs.join("\n"));
	assert.equal(signedIn, true);
	const config = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(config.auth, { type: "cli", provider: "grok" });
	assert.equal(config.baseUrl, "cli://grok"); assert.equal(config.apiKey, undefined);
}));

test("xAI API setup opens its key page and validates the HTTP connection", async () => isolated(async (_home, path) => {
	const logs: string[] = [];
	assert.equal(await runSetup({ provider: "xai", model: "grok-fixture-text" }, {
		...deps(logs), prompt: { ...forbiddenPrompt(), secret: async () => "xai-fixture-key" },
		openBrowser: async url => { assert.equal(url, API_KEY_PAGES.xai); return true; },
		detect: async (baseUrl, opts) => { assert.equal(baseUrl, "https://api.x.ai/v1"); assert.equal(opts?.apiKey, "xai-fixture-key"); return { baseUrl, provider: "xai", models: [] }; },
		connection: async (_url, model, key) => { assert.equal(model, "grok-fixture-text"); assert.equal(key, "xai-fixture-key"); return { ok: true, detail: "mock chat passed" }; },
	}), 0, logs.join("\n"));
	assert.equal(JSON.parse(readFileSync(path, "utf8")).provider, "xai");
	assert.doesNotMatch(logs.join("\n"), /xai-fixture-key/);
}));

test("interactive setup discovers known peers, retains SSH route, and lists protected/empty servers", async () => isolated(async (_home, path) => {
	const logs: string[] = []; let questions = 0;
	const servers = [
		{ provider: "custom", baseUrl: "http://127.0.0.1:1234/v1", sshHost: "fixture-host", modelsEndpoint: "http://127.0.0.1:1234/v1/models", models: [], source: "configured" as const, status: "auth-required" as const },
		{ provider: "custom", baseUrl: "http://100.80.10.20:1234/v1", modelsEndpoint: "http://100.80.10.20:1234/v1/models", models: [], source: "netbird" as const, status: "no-models" as const },
	];
	assert.equal(await runSetup({ model: "fixture-model" }, {
		...deps(logs), prompt: { ask: async () => { questions++; return "1"; }, secret: async () => "fixture-key", close() {} },
		discoverServers: async opts => { assert.equal(opts?.network, true); return { servers, results: servers, scanned: 2, candidateCount: 2, sources: [], truncated: false, timedOut: false, network: true }; },
		detect: async (baseUrl, opts) => { assert.equal(opts?.sshHost, "fixture-host"); assert.equal(opts?.apiKey, "fixture-key"); return { baseUrl, provider: "custom", models: ["fixture-model"] }; },
		connection: async (_url, _model, _key, opts) => { assert.equal(opts?.sshHost, "fixture-host"); return { ok: true, detail: "mock SSH passed" }; },
	}), 0, logs.join("\n"));
	assert.equal(questions, 1); assert.equal(JSON.parse(readFileSync(path, "utf8")).sshHost, "fixture-host");
	assert.match(logs.join("\n"), /\[auth-required\]/); assert.match(logs.join("\n"), /\[no-models\]/);
}));

test("setup supports disabling peer discovery and showing hosting recipes before rescan", async () => isolated(async (_home, path) => {
	const logs: string[] = []; const advice: boolean[] = []; let scans = 0;
	assert.equal(await runSetup({ discoverNetwork: false, model: "fixture-model" }, {
		...deps(logs), servingAdvice: async detailed => { advice.push(detailed); },
		prompt: { ask: async prompt => {
			if (prompt.startsWith("Start a server")) return "";
			if (prompt.startsWith("Choose connection")) {
				if (scans === 1) return logs.findLast(s => s.includes("Help me host a model"))!.trim().split(".")[0];
				return "1";
			}
			return "";
		}, secret: async () => undefined, close() {} },
		discoverServers: async opts => { scans++; assert.equal(opts?.network, false); const servers = [{ provider: "lmstudio", baseUrl: "http://localhost:1234/v1", modelsEndpoint: "http://localhost:1234/v1/models", models: ["fixture-model"], source: "localhost" as const, status: "ready" as const }]; return { servers, results: servers, scanned: 1, candidateCount: 1, sources: [], truncated: false, timedOut: false, network: false }; },
	}), 0, logs.join("\n"));
	assert.deepEqual(advice, [false, true]); assert.equal(scans, 2); assert.equal(existsSync(path), true);
}));

test("interactive setup accepts an unidentified discovered API without asking for an unnecessary SSH route", async () => isolated(async (_home, path) => {
	const logs: string[] = []; const questions: string[] = [];
	const server: DiscoveredServer = { provider: "openai-compatible", baseUrl: "http://100.80.10.30:8123/v1", modelsEndpoint: "http://100.80.10.30:8123/v1/models", models: ["fixture-model"], source: "netbird", status: "ready" };
	assert.equal(await runSetup({ model: "fixture-model" }, {
		...deps(logs), prompt: { ask: async question => { questions.push(question); return question.startsWith("Choose connection") ? "1" : ""; }, secret: async () => undefined, close() {} },
		discoverServers: async () => reportFor([server]),
		detect: async (baseUrl, options) => { assert.equal(options?.provider, "custom"); return { baseUrl, provider: "custom", models: ["fixture-model"] }; },
	}), 0, logs.join("\n"));
	assert.equal(JSON.parse(readFileSync(path, "utf8")).baseUrl, server.baseUrl);
	assert.ok(questions.every(question => question.startsWith("Choose connection")));
}));

test("a generic local API uses its exact listener environment key during setup and after saving", async () => isolated(async (_home, path) => {
	const logs: string[] = [];
	process.env.LMSTUDIO_API_KEY = "local-provider-env-fixture";
	const server: DiscoveredServer = { provider: "openai-compatible", baseUrl: "http://localhost:1234/v1", modelsEndpoint: "http://localhost:1234/v1/models", models: ["fixture-model"], source: "localhost", status: "ready" };
	assert.equal(await runSetup({ model: "fixture-model" }, {
		...deps(logs), keyFor: apiKeyFor,
		prompt: { ask: async question => { assert.match(question, /^Choose connection/); return "1"; }, secret: async () => { throw new Error("Local listener already has its environment key"); }, close() {} },
		discoverServers: async () => reportFor([server]),
		detect: async (baseUrl, options) => { assert.equal(options?.provider, "custom"); assert.equal(options?.apiKey, process.env.LMSTUDIO_API_KEY); return { baseUrl, provider: "custom", models: ["fixture-model"] }; },
		connection: async (_url, _model, key) => { assert.equal(key, process.env.LMSTUDIO_API_KEY); return { ok: true, detail: "Fixture connection passed" }; },
	}), 0, logs.join("\n"));
	const saved = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(saved.provider, "custom");
	assert.equal(saved.apiKey, undefined);
	const resolved = await resolveModel();
	assert.equal(resolved.provider, "custom");
	assert.equal(apiKeyFor(resolved.provider, resolved.baseUrl, resolved.sshHost), process.env.LMSTUDIO_API_KEY);
	assert.doesNotMatch(logs.join("\n"), /local-provider-env-fixture/);
}));

test("newly identified server implementation retains credentials and model for the exact saved SSH connection", async () => isolated(async (_home, path) => {
	const logs: string[] = [];
	const saved = { provider: "custom", baseUrl: "http://127.0.0.1:8123/v1", sshHost: "fixture-host", model: "saved-fixture", apiKey: "saved-fixture-secret" };
	writeFileSync(path, JSON.stringify(saved));
	const server: DiscoveredServer = { provider: "llamacpp", baseUrl: saved.baseUrl, modelsEndpoint: `${saved.baseUrl}/models`, models: ["saved-fixture"], sshHost: saved.sshHost, source: "configured", status: "ready" };
	assert.equal(await runSetup({}, {
		...deps(logs), keyFor: (_provider, url, sshHost) => { assert.equal(url, saved.baseUrl); assert.equal(sshHost, saved.sshHost); return saved.apiKey; },
		prompt: { ask: async question => { assert.match(question, /^Choose connection/); return "1"; }, secret: async () => { throw new Error("Saved connection already has its key"); }, close() {} },
		discoverServers: async () => reportFor([server]),
		detect: async (baseUrl, options) => { assert.equal(options?.apiKey, saved.apiKey); assert.equal(options?.sshHost, saved.sshHost); return { baseUrl, provider: "llamacpp", models: ["saved-fixture"] }; },
		connection: async (_url, model, key, options) => { assert.equal(model, saved.model); assert.equal(key, saved.apiKey); assert.equal(options?.sshHost, saved.sshHost); return { ok: true, detail: "Fixture connection passed" }; },
	}), 0, logs.join("\n"));
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...saved, provider: "llamacpp", api: "chat-completions", auth: { type: "api-key" }, maxTurns: 300, maxIterations: 25 });
	assert.doesNotMatch(logs.join("\n"), /saved-fixture-secret/);
}));

test("a rejected saved key can be replaced during discovered-server selection", async () => isolated(async (_home, path) => {
	const logs: string[] = []; let secretsAsked = 0;
	const saved = { provider: "custom", baseUrl: "http://127.0.0.1:8123/v1", sshHost: "fixture-host", model: "saved-fixture", apiKey: "old-fixture-secret" };
	writeFileSync(path, JSON.stringify(saved));
	const server: DiscoveredServer = { provider: "custom", baseUrl: saved.baseUrl, modelsEndpoint: `${saved.baseUrl}/models`, models: [], sshHost: saved.sshHost, source: "configured", status: "auth-required", error: "Authentication was rejected (HTTP 401)." };
	assert.equal(await runSetup({}, {
		...deps(logs), keyFor: () => saved.apiKey,
		prompt: { ask: async question => { assert.match(question, /^Choose connection/); return "1"; }, secret: async () => { secretsAsked++; return "new-fixture-secret"; }, close() {} },
		discoverServers: async () => reportFor([server]),
		detect: async (baseUrl, options) => { assert.equal(options?.apiKey, "new-fixture-secret"); return { baseUrl, provider: "custom", models: [saved.model] }; },
		connection: async (_url, _model, key) => { assert.equal(key, "new-fixture-secret"); return { ok: true, detail: "Fixture connection passed" }; },
	}), 0, logs.join("\n"));
	assert.equal(secretsAsked, 1);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).apiKey, "new-fixture-secret");
	assert.doesNotMatch(logs.join("\n"), /old-fixture-secret|new-fixture-secret/);
}));

test("rejected environment credentials require fixing the environment and preserve saved settings", async () => isolated(async (_home, path) => {
	const logs: string[] = [];
	const saved = { provider: "custom", baseUrl: "http://127.0.0.1:8123/v1", sshHost: "fixture-host", model: "saved-fixture", apiKey: "saved-fixture-secret" };
	writeFileSync(path, JSON.stringify(saved));
	process.env.REIN_API_KEY = "rejected-env-secret";
	const server: DiscoveredServer = { provider: "custom", baseUrl: saved.baseUrl, modelsEndpoint: `${saved.baseUrl}/models`, models: [], sshHost: saved.sshHost, source: "configured", status: "auth-required", error: "Authentication was rejected (HTTP 401)." };
	assert.equal(await runSetup({}, {
		...deps(logs), keyFor: () => process.env.REIN_API_KEY,
		prompt: { ask: async question => { assert.match(question, /^Choose connection/); return "1"; }, secret: async () => { throw new Error("Do not save a key that the environment would override"); }, close() {} },
		discoverServers: async () => reportFor([server]), detect: async () => { throw new Error("Do not retry known rejected credential"); },
	}), 1);
	assert.match(logs.join("\n"), /Correct or unset REIN_API_KEY/);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), saved);
	assert.doesNotMatch(logs.join("\n"), /saved-fixture-secret|rejected-env-secret/);
}));

test("an unauthenticated peer probe can use an environment key after the operator selects it", async () => isolated(async (_home, path) => {
	const logs: string[] = [];
	process.env.REIN_API_KEY = "selected-peer-env-secret";
	const server: DiscoveredServer = { provider: "openai-compatible", baseUrl: "http://100.80.10.32:8123/v1", modelsEndpoint: "http://100.80.10.32:8123/v1/models", models: [], source: "netbird", status: "auth-required", error: "Authentication is required (HTTP 401)." };
	assert.equal(await runSetup({ model: "fixture-model" }, {
		...deps(logs), keyFor: () => process.env.REIN_API_KEY,
		prompt: { ask: async question => { assert.match(question, /^Choose connection/); return "1"; }, secret: async () => { throw new Error("Selected endpoint already has an environment key"); }, close() {} },
		discoverServers: async () => reportFor([server]),
		detect: async (baseUrl, options) => { assert.equal(options?.apiKey, process.env.REIN_API_KEY); return { baseUrl, provider: "custom", models: ["fixture-model"] }; },
		connection: async (_url, _model, key) => { assert.equal(key, process.env.REIN_API_KEY); return { ok: true, detail: "Fixture connection passed" }; },
	}), 0, logs.join("\n"));
	assert.equal(JSON.parse(readFileSync(path, "utf8")).apiKey, undefined);
	assert.doesNotMatch(logs.join("\n"), /selected-peer-env-secret/);
}));

test("unattended expanded discovery skips protected candidates and carries the selected ready SSH route", async () => isolated(async (_home, path) => {
	const logs: string[] = [];
	const baseUrl = "http://127.0.0.1:8123/v1";
	const servers: DiscoveredServer[] = [
		{ provider: "openai-compatible", baseUrl: "http://100.80.10.31:8123/v1", modelsEndpoint: "http://100.80.10.31:8123/v1/models", models: [], source: "netbird", status: "auth-required" },
		{ provider: "openai-compatible", baseUrl, modelsEndpoint: `${baseUrl}/models`, models: ["fixture-model"], source: "explicit", status: "ready", sshHost: "fixture-host" },
	];
	assert.equal(await runSetup({ yes: true, discoverNetwork: true, discoverPorts: [8123] }, {
		...deps(logs), discoverServers: async opts => { assert.equal(opts?.network, true); assert.deepEqual(opts?.ports, [8123]); return reportFor(servers); },
		detect: async (url, options) => { assert.equal(url, baseUrl); assert.equal(options?.sshHost, "fixture-host"); return { baseUrl, provider: "custom", models: ["fixture-model"] }; },
		connection: async (_url, _model, _key, options) => { assert.equal(options?.sshHost, "fixture-host"); return { ok: true, detail: "Fixture connection passed" }; },
	}), 0, logs.join("\n"));
	assert.equal(JSON.parse(readFileSync(path, "utf8")).sshHost, "fixture-host");
}));

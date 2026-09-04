import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { normalizeBaseUrl, detectEndpoint, guessProvider, PROVIDER_PRESETS } from "../src/ai/endpoints.ts";
import { apiKeyFor, resolveModel, discoverLocalServers } from "../src/ai/models.ts";

async function isolated(fn: (directory: string) => Promise<void>) {
	const directory = mkdtempSync(join(tmpdir(), "rein-endpoints-"));
	const keys = ["REIN_HOME", "REIN_BASE_URL", "REIN_MODEL", "REIN_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OLLAMA_API_KEY"];
	const previous = new Map(keys.map(key => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	process.env.REIN_HOME = directory;
	try { await fn(directory); } finally {
		for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(directory, { recursive: true, force: true });
	}
}

test("scheme-less private, NetBird, internal, and local ports normalize without losing explicit schemes", () => {
	for (const host of ["100.64.10.2:1234", "100.127.255.254:8000", "10.250.158.81:18083", "192.168.1.20:1234", "172.31.1.2:8080", "dgx.netbird.cloud:18083", "dgx", "localhost:11434", "[::1]:1234"]) {
		assert.equal(normalizeBaseUrl(host), `http://${host}/v1`);
	}
	assert.equal(normalizeBaseUrl("https://dgx.netbird.cloud:1234"), "https://dgx.netbird.cloud:1234/v1");
	assert.equal(normalizeBaseUrl("api.example.com"), "https://api.example.com/v1");
	assert.equal(normalizeBaseUrl("100.64.0.1"), "http://100.64.0.1/v1");
	assert.equal(guessProvider("100.64.10.2:1234"), "lmstudio");
	assert.equal(guessProvider("10.1.2.3:8000"), "vllm");
});

test("full completion/model routes and custom prefixes are preserved correctly", () => {
	assert.equal(normalizeBaseUrl("http://server:1234/v1/chat/completions"), "http://server:1234/v1");
	assert.equal(normalizeBaseUrl("http://server:1234/v1/models/"), "http://server:1234/v1");
	assert.equal(normalizeBaseUrl("https://api.example/proxy/inference"), "https://api.example/proxy/inference");
	assert.equal(normalizeBaseUrl("https://api.example/proxy/chat/completions"), "https://api.example/proxy");
	assert.equal(normalizeBaseUrl("http://server:8081/models"), "http://server:8081/");
	assert.equal(normalizeBaseUrl("http://localhost:11434/api/chat"), "http://localhost:11434/v1");
});

test("known provider domains use verified API prefixes and retired GitHub is actionable", () => {
	assert.equal(normalizeBaseUrl("api.groq.com"), PROVIDER_PRESETS.groq.baseUrl);
	assert.equal(normalizeBaseUrl("openrouter.ai/api"), PROVIDER_PRESETS.openrouter.baseUrl);
	assert.equal(normalizeBaseUrl("generativelanguage.googleapis.com/v1beta"), "https://generativelanguage.googleapis.com/v1beta/openai");
	assert.equal(normalizeBaseUrl("generativelanguage.googleapis.com/v1beta/openai/models"), PROVIDER_PRESETS.gemini.baseUrl);
	assert.equal(PROVIDER_PRESETS.gemini.keyEnv, "GEMINI_API_KEY");
	assert.throws(() => normalizeBaseUrl("https://models.github.ai/inference"), /retired.*July 30, 2026/);
	assert.throws(() => normalizeBaseUrl("https://models.inference.ai.azure.com/v1"), /Copilot CLI/);
});

test("embedded credentials, query secrets, unsupported schemes, and malformed URLs are rejected", () => {
	for (const input of ["https://user:password@host/v1", "https://host/v1?api_key=secret", "https://host/v1#fragment", "ftp://host/v1", "", "http://"]) assert.throws(() => normalizeBaseUrl(input));
});

test("discovery probes bounded path variants on the supplied origin with provided credentials", async (t) => {
	const requests: { url: string; auth: string | undefined; redirect: unknown }[] = [];
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		requests.push({ url, auth: (init.headers as any)?.Authorization, redirect: init.redirect });
		return url === "http://100.64.1.2:18083/proxy/v1/models" ? Response.json({ data: [{ id: "Qwen-DGX" }] }) : Response.json({}, { status: 404 });
	});
	const result = await detectEndpoint("100.64.1.2:18083/proxy", { apiKey: "fixture-key" });
	assert.equal(result.baseUrl, "http://100.64.1.2:18083/proxy/v1");
	assert.deepEqual(result.models, ["Qwen-DGX"]);
	assert.deepEqual(requests.map(r => r.url), ["http://100.64.1.2:18083/proxy/models", "http://100.64.1.2:18083/proxy/v1/models"]);
	assert.ok(requests.every(r => r.auth === "Bearer fixture-key" && r.redirect === "manual"));
});

test("auth failures stop discovery and identify required versus rejected credentials", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}, { status: 401 }); });
	assert.match((await detectEndpoint("host:1234")).error!, /Authentication is required.*401/);
	assert.match((await detectEndpoint("host:1234", { apiKey: "wrong" })).error!, /Authentication was rejected.*401/);
	assert.equal(calls, 2);
});

test("discovery distinguishes refused, DNS, timeout, bad path, and invalid model list", async (t) => {
	const fake = t.mock.method(globalThis, "fetch", async () => { throw new Error("fetch failed", { cause: { code: "ECONNREFUSED" } }); });
	assert.match((await detectEndpoint("100.64.0.1:18083")).error!, /Connection refused/);
	fake.mock.mockImplementation(async () => { throw new Error("fetch failed", { cause: { code: "ENOTFOUND" } }); });
	assert.match((await detectEndpoint("dgx.netbird.cloud:18083")).error!, /Host name could not be resolved/);
	fake.mock.mockImplementation(async (_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
	assert.match((await detectEndpoint("host:1234", { timeoutMs: 10 })).error!, /Connection timed out/);
	fake.mock.mockImplementation(async () => Response.json({}, { status: 404 }));
	assert.match((await detectEndpoint("host:1234")).error!, /API path not found.*404/);
	fake.mock.mockImplementation(async () => Response.json({ data: [{ nonsense: "not a model" }] }));
	assert.match((await detectEndpoint("host:1234")).error!, /Invalid model list/);
});

test("cross-origin redirects never reach the other origin with credentials", async (t) => {
	let received = 0;
	const other = createServer((_req, res) => { received++; res.end("unexpected"); });
	await new Promise<void>(resolve => other.listen(0, "127.0.0.1", resolve));
	const redirect = createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${(other.address() as { port: number }).port}/v1/models` }); res.end(); });
	await new Promise<void>(resolve => redirect.listen(0, "127.0.0.1", resolve));
	t.after(async () => { await Promise.all([other, redirect].map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
	const result = await detectEndpoint(`http://127.0.0.1:${(redirect.address() as { port: number }).port}`, { apiKey: "fixture-secret" });
	assert.match(result.error!, /another origin/);
	assert.equal(received, 0);
});

test("same-origin model-list redirects preserve the discovered API prefix", async (t) => {
	const requests: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		requests.push(url);
		return requests.length === 1 ? new Response(null, { status: 307, headers: { location: "/routed/v1/models" } }) : Response.json({ data: [{ id: "routed-model" }] });
	});
	const result = await detectEndpoint("100.64.1.2:18083");
	assert.equal(result.baseUrl, "http://100.64.1.2:18083/routed/v1");
	assert.deepEqual(result.models, ["routed-model"]);
});

test("saved API keys are scoped to exact normalized endpoint and SSH host", async () => isolated(async directory => {
	writeFileSync(join(directory, "config.json"), JSON.stringify({ provider: "custom", baseUrl: "http://127.0.0.1:18083/v1", apiKey: "saved-secret", sshHost: "dgx" }));
	assert.equal(apiKeyFor("custom", "127.0.0.1:18083/v1", "dgx"), "saved-secret");
	assert.equal(apiKeyFor("custom", "127.0.0.1:18083/v1", "other"), undefined);
	assert.equal(apiKeyFor("custom", "127.0.0.1:18083/v1"), undefined);
	assert.equal(apiKeyFor("custom", "127.0.0.1:18083/proxy/v1", "dgx"), undefined);
	assert.equal(apiKeyFor("custom", "100.64.2.1:18083/v1", "dgx"), undefined);
}));

test("provider environment keys only go to preset origins; generic REIN_API_KEY is explicit", async () => isolated(async () => {
	process.env.OPENAI_API_KEY = "provider-secret";
	assert.equal(apiKeyFor("openai", "https://api.openai.com/v1"), "provider-secret");
	assert.equal(apiKeyFor("openai", "http://100.64.0.1:18083/v1"), undefined);
	assert.equal(apiKeyFor("openai", "http://api.openai.com/v1"), undefined);
	process.env.REIN_API_KEY = "explicit-generic-key";
	assert.equal(apiKeyFor("custom", "100.64.0.1:18083"), "explicit-generic-key");
	assert.equal(apiKeyFor("codex", "cli://codex"), undefined);
}));

test("changing endpoint ignores saved model/key and discovers only the new endpoint", async (t) => isolated(async directory => {
	writeFileSync(join(directory, "config.json"), JSON.stringify({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "old-model", apiKey: "old-key" }));
	const requests: any[] = [];
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => { requests.push({ url, headers: init.headers }); return Response.json({ data: [{ id: "new-model" }] }); });
	const model = await resolveModel({ baseUrl: "100.64.0.1:18083" });
	assert.equal(model.id, "new-model");
	assert.equal(model.baseUrl, "http://100.64.0.1:18083/v1");
	assert.equal(requests[0].headers, undefined);
	assert.equal(requests.length, 1);
}));

test("saved normalized endpoint retains model and explicit SSH target drops stale model", async (t) => isolated(async directory => {
	writeFileSync(join(directory, "config.json"), JSON.stringify({ provider: "custom", baseUrl: "http://127.0.0.1:18083/v1", model: "saved-model", sshHost: "dgx" }));
	const model = await resolveModel({ baseUrl: "127.0.0.1:18083/v1" });
	assert.equal(model.id, "saved-model");
	assert.equal(model.sshHost, "dgx");
	const overridden = await resolveModel({ baseUrl: "127.0.0.1:18083/v1", sshHost: "other", model: "explicit" });
	assert.equal(overridden.id, "explicit");
	assert.equal(overridden.sshHost, "other");
}));

test("CLI routing avoids HTTP discovery, uses subscription default, and rejects mixed endpoint settings", async (t) => isolated(async directory => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("HTTP must not be called"); });
	writeFileSync(join(directory, "config.json"), JSON.stringify({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "old-api-model" }));
	const explicit = await resolveModel({ provider: "codex" });
	assert.equal(explicit.baseUrl, "cli://codex");
	assert.equal(explicit.id, "default");
	await assert.rejects(resolveModel({ provider: "copilot", baseUrl: "http://host/v1" }), /cannot be combined/);
	await assert.rejects(resolveModel({ provider: "copilot", sshHost: "dgx" }), /SSH forwarding/);
	writeFileSync(join(directory, "config.json"), JSON.stringify({ provider: "copilot", auth: { type: "cli", provider: "copilot" }, model: "default" }));
	assert.equal((await resolveModel()).provider, "copilot");
	assert.equal((await resolveModel({ baseUrl: "100.64.1.2:18083", model: "local-model" })).provider, "custom");
}));


test("discovered root APIs retain their prefix through normalization and saved model resolution", async (t) => isolated(async directory => {
	const requests: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		requests.push(url);
		return url === "http://host:18083/models" ? Response.json({ data: [{ id: "root-model" }] }) : Response.json({}, { status: 404 });
	});
	const detected = await detectEndpoint("host:18083");
	assert.equal(detected.baseUrl, "http://host:18083/");
	assert.equal(normalizeBaseUrl(detected.baseUrl), detected.baseUrl);
	writeFileSync(join(directory, "config.json"), JSON.stringify({ baseUrl: detected.baseUrl, model: "root-model", apiKey: "root-key" }));
	const model = await resolveModel();
	assert.equal(model.baseUrl, "http://host:18083/");
	assert.equal(apiKeyFor(model.provider, model.baseUrl), "root-key");
	assert.equal(apiKeyFor(model.provider, "http://host:18083/v1"), undefined);
}));


test("empty environment overrides do not erase a saved endpoint and model", async () => isolated(async directory => {
	writeFileSync(join(directory, "config.json"), JSON.stringify({ provider: "custom", baseUrl: "http://100.64.0.1:18083/v1", model: "saved-model" }));
	process.env.REIN_BASE_URL = "   ";
	process.env.REIN_MODEL = "";
	const model = await resolveModel();
	assert.equal(model.baseUrl, "http://100.64.0.1:18083/v1");
	assert.equal(model.id, "saved-model");
}));


test("protected local discovery uses scoped credentials and ignores malformed model IDs", async (t) => isolated(async () => {
	process.env.OLLAMA_API_KEY = "local-fixture-key";
	process.env.REIN_API_KEY = "explicit-key-for-selected-endpoint-only";
	const requests: { url: string; key?: string }[] = [];
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		const key = (init.headers as any)?.Authorization;
		requests.push({ url, key });
		if (url === "http://localhost:11434/v1/models" && key === "Bearer local-fixture-key") return Response.json({ data: [{ id: "protected-model" }, { id: 123 }] });
		return Response.json({ data: [{ id: 456 }] });
	});
	const servers = await discoverLocalServers();
	assert.equal(servers.length, 1);
	assert.equal(servers[0].provider, "ollama");
	assert.deepEqual(servers[0].models, ["protected-model"]);
	assert.ok(requests.filter(r => !r.url.includes(":11434/")).every(r => !r.key));
}));

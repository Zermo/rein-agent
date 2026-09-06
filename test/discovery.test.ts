import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverServers, parseNetbirdPeers, parseTailscalePeers, parseNeighborPeers, privatePeerAddress } from "../src/ai/discovery.ts";
import { discoverServers as configuredDiscovery } from "../src/ai/models.ts";
import { detectEndpoint, normalizeBaseUrl } from "../src/ai/endpoints.ts";

const unavailable = async () => { throw Object.assign(new Error("missing fixture executable"), { code: "ENOENT" }); };
const noServer = async (baseUrl: string) => ({ baseUrl, provider: "openai-compatible", models: [], error: "Connection refused" });

test("default discovery only probes localhost without running network commands", async () => {
	const calls: string[] = [];
	const report = await discoverServers({}, { run: async () => { throw new Error("Network commands must not run"); }, detect: async baseUrl => {
		calls.push(baseUrl); return noServer(baseUrl);
	} });
	assert.deepEqual(calls, [11434, 1234, 8080, 8000].map(port => `http://localhost:${port}/v1`));
	assert.equal(report.network, false);
	assert.equal(report.scanned, 4);
	assert.deepEqual(report.servers, []);
	assert.ok(report.results.every(result => result.status === "unreachable"));
});

test("mesh parsers keep online private peer addresses and exclude transport/route/public metadata", () => {
	assert.deepEqual(parseTailscalePeers(JSON.stringify({ Peer: {
		online: { Online: true, TailscaleIPs: ["100.64.2.7", "fd7a:115c:a1e0::7", "203.0.113.7"], CurAddr: "203.0.113.9:41641" },
		offline: { Online: false, TailscaleIPs: ["100.64.2.8"] },
	} })), ["100.64.2.7", "fd7a:115c:a1e0::7"]);
	assert.deepEqual(parseNetbirdPeers(JSON.stringify({ netbirdIp: "100.64.3.1/16", peers: { details: [
		{ netbirdIp: "100.64.3.7/32", netbirdIpv6: "fd00::7", status: "Connected", networks: ["10.7.0.0/16"], connection_ip: "203.0.113.7" },
		{ netbirdIp: "100.64.3.8/32", status: "Disconnected" },
	] } })), ["100.64.3.7", "fd00::7"]);
	assert.deepEqual(parseNeighborPeers("? (192.168.40.7) at 00:11:22:33:44:55 on en0\n? (192.168.40.8) at (incomplete) on en0\n203.0.113.9 lladdr aa:bb REACHABLE\n10.2.3.4 dev eth0 lladdr aa:bb STALE"), ["192.168.40.7", "10.2.3.4"]);
	for (const input of ["127.0.0.1", "169.254.1.2", "224.0.0.1", "192.168.1.255", "203.0.113.7", "fe80::1", "::1", "server.example", "100.64.0.5;touch foo", "10.1.2.3/99"]) assert.equal(privatePeerAddress(input), undefined, input);
});

test("network discovery merges installed peer sources and retains source errors without exposing stderr", async () => {
	const commands: string[] = [];
	const calls: { url: string; key?: string; provider?: string }[] = [];
	const report = await discoverServers({ network: true, ports: [8123], configured: [{ baseUrl: "http://100.64.4.7:8123/proxy/v1", source: "configured", apiKey: "saved-secret" }] }, {
		platform: "darwin",
		run: async (command, args) => {
			commands.push([command, ...args].join(" "));
			if (command === "netbird") return JSON.stringify({ peers: { details: [{ status: "Connected", netbirdIp: "100.64.4.7/32" }] } });
			if (command === "arp") return "? (192.168.40.7) at aa:bb:cc:dd:ee:ff on en0";
			throw new Error("private process stderr must stay out of the report");
		},
		detect: async (url, options) => { calls.push({ url, key: options?.apiKey, provider: options?.provider }); return noServer(url); },
	});
	assert.deepEqual(commands.sort(), ["arp -an", "netbird status --json", "tailscale status --json"]);
	assert.ok(calls.some(call => call.url === "http://100.64.4.7:8123/v1"));
	assert.ok(calls.some(call => call.url === "http://192.168.40.7:8000/v1"));
	assert.deepEqual(calls.filter(call => call.key).map(call => call.url), ["http://100.64.4.7:8123/proxy/v1"]);
	assert.ok(calls.filter(call => !call.key).every(call => call.provider === "openai-compatible"));
	assert.equal(report.sources.find(source => source.source === "tailscale")?.status, "error");
	assert.doesNotMatch(JSON.stringify(report), /saved-secret|private process stderr/);
});

test("Linux JSON neighbors and explicit IPv6 hosts are probed without CIDR expansion", async () => {
	const calls: string[] = [];
	await discoverServers({ network: true, hosts: ["fd00::9", "http://model-host:8123/prefix", "10.7.0.0/16"] }, {
		platform: "linux", run: async command => command === "ip" ? JSON.stringify([
			{ dst: "192.168.40.7", state: ["STALE"] }, { dst: "192.168.40.8", state: ["FAILED"] }, { dst: "203.0.113.7", state: ["REACHABLE"] },
		]) : unavailable(),
		detect: async url => { calls.push(url); return noServer(url); },
	});
	assert.ok(calls.includes("http://[fd00::9]:1234/v1"));
	assert.ok(calls.includes("http://model-host:8123/prefix"));
	assert.ok(calls.includes("http://192.168.40.7:1234/v1"));
	assert.ok(calls.every(url => !url.includes("192.168.40.8") && !url.includes("203.0.113.7") && !url.includes("10.7.")));
});

test("probe concurrency and candidate caps bound a large peer table", async () => {
	let active = 0;
	let maximum = 0;
	const report = await discoverServers({ network: true, maxCandidates: 12, concurrency: 3, maxPeers: 4 }, {
		run: async command => command === "tailscale" ? JSON.stringify({ Peer: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [index, { Online: true, TailscaleIPs: [`100.65.${Math.floor(index / 200)}.${index % 200 + 1}`] }])) }) : unavailable(),
		detect: async url => { maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return noServer(url); },
	});
	assert.equal(report.truncated, true);
	assert.equal(report.scanned, 12);
	assert.equal(report.candidateCount, 12);
	assert.equal(maximum, 3);
});

test("global probe budget reports skipped candidates instead of silently dropping them", async () => {
	let now = 0;
	const report = await discoverServers({ budgetMs: 100, concurrency: 1 }, { now: () => now, detect: async url => { now += 120; return noServer(url); } });
	assert.equal(report.scanned, 1);
	assert.equal(report.timedOut, true);
	assert.equal(report.results.filter(result => result.status === "skipped").length, 3);
});

test("an explicit extra port also discovers a local listener without enabling network commands", async () => {
	const calls: string[] = [];
	const report = await discoverServers({ ports: [8123] }, { run: async () => { throw new Error("Network commands must not run"); }, detect: async url => { calls.push(url); return noServer(url); } });
	assert.ok(calls.includes("http://localhost:8123/v1"));
	assert.equal(report.scanned, 5);
	assert.equal(report.network, false);
});

test("protected, empty, and incompatible servers produce distinct selectable evidence", async t => {
	t.mock.method(globalThis, "fetch", async (url: string) => {
		if (url.includes(":11434/")) return Response.json({ data: [{ id: "fixture-model" }] });
		if (url.includes(":1234/")) return Response.json({}, { status: 401 });
		if (url.includes(":8080/")) return Response.json({ data: [] });
		return new Response("<html>normal web page</html>");
	});
	const report = await discoverServers();
	assert.deepEqual(report.results.map(result => result.status), ["ready", "auth-required", "no-models", "incompatible"]);
	assert.equal(report.servers.length, 3);
	// Port hints alone must not select implementation-specific adapters.
	assert.equal(report.servers[0].provider, "openai-compatible");
});

test("Ollama tags fallback establishes implementation only after a valid route responds", async t => {
	t.mock.method(globalThis, "fetch", async (url: string) => url.endsWith("/api/tags")
		? Response.json({ models: [{ name: "fixture-model:7b" }] }) : Response.json({}, { status: 404 }));
	const result = await detectEndpoint("http://model-host:11434/v1", { provider: "openai-compatible" });
	assert.equal(result.provider, "ollama");
	assert.deepEqual(result.models, ["fixture-model:7b"]);
	assert.equal(result.status, "ready");
});

test("configured discovery includes saved/env endpoints with credentials scoped by exact URL and SSH route", async () => {
	const directory = mkdtempSync(join(tmpdir(), "rein-discovery-"));
	const keys = ["REIN_HOME", "REIN_BASE_URL", "REIN_API_KEY", "OLLAMA_API_KEY", "LMSTUDIO_API_KEY", "LLAMACPP_API_KEY", "VLLM_API_KEY"];
	const previous = new Map(keys.map(key => [key, process.env[key]]));
	try {
		for (const key of keys) delete process.env[key];
		process.env.REIN_HOME = directory;
		process.env.REIN_BASE_URL = "http://100.64.5.7:8123/proxy/v1";
		process.env.REIN_API_KEY = "env-secret";
		writeFileSync(join(directory, "config.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:8123/v1", sshHost: "fixture-server", apiKey: "saved-secret", provider: "custom" }));
		const calls: { url: string; key?: string; sshHost?: string }[] = [];
		const report = await configuredDiscovery({ hosts: ["100.64.5.7"] }, { detect: async (url, options) => { calls.push({ url, key: options?.apiKey, sshHost: options?.sshHost }); return noServer(url); } });
		assert.deepEqual(calls.filter(call => call.key), [
			{ url: "http://100.64.5.7:8123/proxy/v1", key: "env-secret", sshHost: undefined },
			{ url: "http://127.0.0.1:8123/v1", key: "saved-secret", sshHost: "fixture-server" },
		]);
		assert.ok(calls.some(call => call.url === "http://100.64.5.7:8123/v1" && !call.key));
		assert.doesNotMatch(JSON.stringify(report), /env-secret|saved-secret/);
	} finally {
		for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a discovery redirect cannot forward configured credentials to a peer", async t => {
	const calls: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => { calls.push(url); return new Response(null, { status: 302, headers: { location: "http://other-host:8123/v1/models" } }); });
	const report = await discoverServers({ maxCandidates: 1, configured: [{ baseUrl: "http://model-host:8123/v1", apiKey: "fixture-key", source: "configured" }] });
	assert.deepEqual(calls, ["http://model-host:8123/v1/models"]);
	assert.equal(report.results[0].status, "incompatible");
	assert.match(report.results[0].error!, /another origin/);
});

test("model-list body limits and cancellation keep discovery bounded", async t => {
	t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(1024 * 1024 + 1)));
	assert.equal((await detectEndpoint("http://model-host:8123/v1")).status, "incompatible");
	const controller = new AbortController(); controller.abort();
	assert.equal((await detectEndpoint("http://model-host:8123/v1", { signal: controller.signal })).status, "unreachable");
});

test("nearby model IDs cannot inject terminal controls or unbounded menu entries", async t => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
		{ id: "fixture-model" }, { id: "\u001b]52;c;fixture\u0007" }, { id: "fake\nmenu label" }, { id: "x".repeat(513) },
	] }));
	const result = await detectEndpoint("http://model-host:8123/v1");
	assert.deepEqual(result.models, ["fixture-model"]);
});

test("xAI language-model discovery keeps text-capable models and canonical API base", async t => {
	const calls: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => { calls.push(url); return Response.json({ models: [
		{ id: "fixture-grok-text", input_modalities: ["text", "image"], output_modalities: ["text"] },
		{ id: "fixture-grok-image", input_modalities: ["text"], output_modalities: ["image"] },
	] }); });
	const result = await detectEndpoint("https://api.x.ai/v1", { provider: "xai", apiKey: "fixture-key" });
	assert.deepEqual(calls, ["https://api.x.ai/v1/language-models"]);
	assert.deepEqual(result.models, ["fixture-grok-text"]);
	assert.equal(result.baseUrl, "https://api.x.ai/v1");
	assert.equal(normalizeBaseUrl("https://api.x.ai/v1/language-models", "xai"), "https://api.x.ai/v1");
});

test("xAI generic model-list fallback does not guess chat compatibility from model names", async t => {
	t.mock.method(globalThis, "fetch", async (url: string) => url.endsWith("/language-models") ? Response.json({}, { status: 404 })
		: Response.json({ data: [{ id: "grok-image-fixture" }, { id: "grok-unknown-fixture" }] }));
	const result = await detectEndpoint("https://api.x.ai/v1", { provider: "xai" });
	assert.deepEqual(result.models, []);
	assert.match(result.error!, /text-capable models/);
});

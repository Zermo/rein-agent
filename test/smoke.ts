/**
 * rein smoke test — the full pipeline against the mock OpenAI server:
 *   1. JSON salvage (unit)
 *   2. edit tool semantics (unit)
 *   3. compat capability table (unit)
 *   4. native tool calls end-to-end (mock-native)
 *   5. text tool protocol end-to-end (mock-text)
 *   6. runtime fallback: broken native → text protocol (mock-broken)
 *   7. nodeterm: hook POSTs, pending-file approvals (allow/deny/timeout), e2e deny
 *   8. TinyFish web_search / web_fetch against a local mock (key, shape, errors)
 *   9. unlazy gates tool driving the vendored gate-check.mjs (lint/status/approve/reverify)
 *
 * Run: node --experimental-strip-types test/smoke.ts
 * Exits 0 on success.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate ~/.rein (capabilities store, sessions) from the real one.
const testHome = mkdtempSync(join(tmpdir(), "rein-home-"));
process.env.HOME = testHome;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		failures.push(name + (detail ? ` — ${detail}` : ""));
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------- 1. salvage
console.log("1. JSON salvage");
{
	const { parseArgsSalvaged } = await import("../src/util/json-salvage.ts");
	check("valid json", JSON.stringify(parseArgsSalvaged('{"a": 1}')) === '{"a":1}');
	check("trailing comma", JSON.stringify(parseArgsSalvaged('{"a": 1,}')) === '{"a":1}');
	check("unescaped newline in string", JSON.stringify(parseArgsSalvaged('{"cmd": "ls\n-la"}')) === '{"cmd":"ls\\n-la"}');
	check("invalid escape", JSON.stringify(parseArgsSalvaged('{"path": "C:\\x\\y"}')) === '{"path":"C:\\\\x\\\\y"}');
	check("garbage around json", JSON.stringify(parseArgsSalvaged('here you go: {"a": 2} hope that helps')) === '{"a":2}');
	check("empty object", JSON.stringify(parseArgsSalvaged("{}")) === "{}");
	check("empty string", JSON.stringify(parseArgsSalvaged("")) === "{}");
}

// ---------------------------------------------------------------- 2. edit
console.log("2. edit tool");
{
	const dir = mkdtempSync(join(tmpdir(), "rein-edit-"));
	const file = join(dir, "a.txt");
	writeFileSync(file, "line one\nline two\nline three\n");
	const { default: editTool } = await import("../src/harness/tools/edit.ts");

	let r: any = await editTool.execute("t1", { path: file, edits: [{ oldText: "line two", newText: "LINE TWO" }] });
	check("simple replace", readFileSync(file, "utf8").includes("LINE TWO"), r.content);
	check("not an error", !r.isError);

	r = await editTool.execute("t2", { path: file, edits: [{ oldText: "nope", newText: "x" }] });
	check("missing oldText errors", r.isError === true && /not found/.test(r.content), r.content);

	writeFileSync(file, "dup\ndup\n");
	r = await editTool.execute("t3", { path: file, edits: [{ oldText: "dup", newText: "x" }] });
	check("non-unique oldText errors", r.isError === true && /times/.test(r.content), r.content);

	writeFileSync(file, "a\nb\nc\n");
	r = await editTool.execute("t4", { path: file, edits: [{ oldText: "a\nb", newText: "A" }, { oldText: "b\nc", newText: "C" }] });
	check("overlapping edits error", r.isError === true && /overlap/.test(r.content), r.content);

	writeFileSync(file, "a\nb\nc\n");
	r = await editTool.execute("t5", { path: file, edits: [{ oldText: "a", newText: "A" }, { oldText: "c", newText: "C" }] });
	check("disjoint edits both apply", readFileSync(file, "utf8") === "A\nb\nC\n" && !r.isError, r.content + " → " + readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------- 3. compat
console.log("3. tool-capability table");
{
	const { decideToolMode } = await import("../src/ai/compat.ts");
	check("qwen2.5-coder → native", decideToolMode("ollama", "qwen2.5-coder:7b").mode === "native");
	check("tinyllama → text", decideToolMode("ollama", "tinyllama-1.1b-chat-v0.3").mode === "text");
	check("gpt-4o → native", decideToolMode("openai", "gpt-4o").mode === "native");
	check("unknown → native (fallback armed)", decideToolMode("ollama", "mystery-model-9b").mode === "native");
	check("forced text wins", decideToolMode("openai", "gpt-4o", "text").mode === "text");
}

// ------------------------------------------- 4-6. end-to-end with mock server
const { createMockServer } = await import("./mock-server.ts");
const server = createMockServer();
await new Promise<void>((resolve) => server.listen(0, () => resolve()));
const port = (server.address() as any).port;
const baseUrl = `http://localhost:${port}/v1`;
console.log(`4-6. end-to-end (mock server on :${port})`);

async function textOf(messages: any[]): Promise<string> {
	const last = [...messages].reverse().find((m) => m.role === "assistant");
	return last?.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("") ?? "";
}

// 4. native tool calls
{
	const { createRunner } = await import("../src/harness/runner.ts");
	const runner = await createRunner({ cwd: process.cwd(), baseUrlOverride: baseUrl, modelOverride: "mock-native", toolsMode: "native" });
	const messages = await runner.run({ role: "user", content: "please run a command", timestamp: Date.now() });
	const finalText = await textOf(messages);
	const toolRan = messages.some((m) => m.role === "toolResult" && (m as any).content?.[0]?.text?.includes("hi-from-native"));
	check("native: tool actually executed", toolRan, JSON.stringify(messages.map((m) => m.role)));
	check("native: final answer cites result", finalText.includes("hi-from-native"), finalText);
	check("native: model+usage recorded", runner.model.id === "mock-native");
}

// 5. text protocol
{
	const { createRunner } = await import("../src/harness/runner.ts");
	const runner = await createRunner({ cwd: process.cwd(), baseUrlOverride: baseUrl, modelOverride: "mock-text", toolsMode: "text" });
	const messages = await runner.run({ role: "user", content: "please run a command", timestamp: Date.now() });
	const finalText = await textOf(messages);
	const toolRan = messages.some((m) => m.role === "toolResult" && (m as any).content?.[0]?.text?.includes("text-mode-works"));
	check("text: block parsed + tool executed", toolRan, JSON.stringify(messages.map((m) => m.role)));
	check("text: final answer cites result", finalText.includes("text-mode-works"), finalText);
}

// 6. runtime fallback (mock-broken starts native, breaks, harness flips to text)
{
	const { createRunner } = await import("../src/harness/runner.ts");
	const runner = await createRunner({ cwd: process.cwd(), baseUrlOverride: baseUrl, modelOverride: "mock-broken", toolsMode: "auto" });
	check("broken: starts in native mode", runner.toolsMode === "native");
	const messages = await runner.run({ role: "user", content: "please run a command", timestamp: Date.now() });
	check("broken: harness fell back to text", runner.toolsMode === "text", runner.toolsMode);
	check("broken: fallback remembered", (await import("../src/ai/compat.ts")).decideToolMode("custom", "mock-broken").mode === "text");
	const toolRan = messages.some((m) => m.role === "toolResult" && (m as any).content?.[0]?.text?.includes("hi-from-text"));
	check("broken: text-mode tool executed", toolRan, JSON.stringify(messages.map((m) => m.role)));
	const finalText = await textOf(messages);
	check("broken: conversation completed", finalText.length > 0, finalText);
}

// ---------------------------------------------------------------- 7. nodeterm
console.log("7. nodeterm integration");
{
	const fs = await import("node:fs");
	const { createServer } = await import("node:http");
	const hookHits: { url: string; body: string }[] = [];
	const hookServer = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			hookHits.push({ url: req.url ?? "", body: raw });
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");
		});
	});
	await new Promise<void>((r) => hookServer.listen(0, "127.0.0.1", () => r()));
	const hookPort = (hookServer.address() as any).port;

	const pendingDir = mkdtempSync(join(tmpdir(), "rein-pending-"));
	process.env.NODETERM_NODE_ID = "test-node";
	process.env.NODETERM_HOOK_PORT = String(hookPort);
	process.env.NODETERM_HOOK_VERSION = "1";
	process.env.NODETERM_PENDING_DIR = pendingDir;

	const { postEvent, requestApproval, active: ntActive } = await import("../src/harness/nodeterm.ts");
	check("nt: detected active", ntActive() === true);

	postEvent({ hook_event_name: "PreToolUse", tool_name: "bash", hookSpecificOutput: { hookEventName: "PreToolUse" } });
	await new Promise((r) => setTimeout(r, 80));
	check("nt: POST reached hook server", hookHits.length === 1 && hookHits[0].url === "/hook/rein", JSON.stringify(hookHits.map((h) => h.url)));
	const form = new URLSearchParams(hookHits[0]?.body ?? "");
	check("nt: form carries nodeId + version", form.get("nodeId") === "test-node" && form.get("version") === "1");
	const payload = JSON.parse(form.get("payload") ?? "{}");
	check("nt: payload has hook_event_name + tool", payload.hook_event_name === "PreToolUse" && payload.tool_name === "bash");

	// allow — the "phone" writes the answer file
	const allowP = requestApproval("bash", { command: "rm -rf /" });
	await new Promise((r) => setTimeout(r, 100));
	let reqFiles = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
	check("nt: pending request written", reqFiles.length === 1, reqFiles.join(";"));
	fs.writeFileSync(join(pendingDir, reqFiles[0].slice(0, -5) + ".answer"), "allow");
	check("nt: allow honored", (await allowP) === "allow");
	check("nt: pending cleaned up", fs.readdirSync(pendingDir).length === 0, fs.readdirSync(pendingDir).join(";"));

	// deny
	const denyP = requestApproval("write", { path: "/x" });
	await new Promise((r) => setTimeout(r, 100));
	reqFiles = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
	fs.writeFileSync(join(pendingDir, reqFiles[0].slice(0, -5) + ".answer"), "deny");
	check("nt: deny honored", (await denyP) === "deny");

	// timeout — no answer arrives; request file gets swept
	process.env.NODETERM_PERM_WAIT_SECS = "1";
	const t0 = Date.now();
	const timeoutVerdict = await requestApproval("bash", { command: "sleep 5" });
	check("nt: timeout reported", timeoutVerdict === "timeout" && Date.now() - t0 < 3000, timeoutVerdict);
	check("nt: timeout cleans up", fs.readdirSync(pendingDir).length === 0, fs.readdirSync(pendingDir).join(";"));
	delete process.env.NODETERM_PERM_WAIT_SECS;

	// e2e: --ask bash + a "phone" that answers deny → tool blocked, model sees it
	{
		const phone = setInterval(() => {
			for (const f of fs.readdirSync(pendingDir)) {
				if (f.endsWith(".json")) fs.writeFileSync(join(pendingDir, f.slice(0, -5) + ".answer"), "deny");
			}
		}, 50);
		const { createRunner } = await import("../src/harness/runner.ts");
		const runner = await createRunner({ cwd: process.cwd(), baseUrlOverride: baseUrl, modelOverride: "mock-native", toolsMode: "native", askTools: ["bash"] });
		const messages = await runner.run({ role: "user", content: "please run a command", timestamp: Date.now() });
		clearInterval(phone);
		const blocked = messages.some((m) => m.role === "toolResult" && /Denied/.test((m as any).content?.[0]?.text ?? ""));
		check("nt-e2e: tool blocked on deny", blocked, JSON.stringify(messages.map((m: any) => m.role)));
		const finalText = await textOf(messages);
		check("nt-e2e: model sees the denial", finalText.includes("Denied"), finalText);
	}

	hookServer.close();
	rmSync(pendingDir, { recursive: true, force: true });
	delete process.env.NODETERM_NODE_ID;
	delete process.env.NODETERM_HOOK_PORT;
	delete process.env.NODETERM_HOOK_VERSION;
	delete process.env.NODETERM_PENDING_DIR;
}

// ---------------------------------------------------------------- 8. tinyfish web
console.log("8. TinyFish web tools");
{
	const { createServer: createHttpServer } = await import("node:http");
	const webHits: { method: string; url: string; key: string | null; body: any }[] = [];
	const webServer = createHttpServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			let body: any = null;
			try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
			webHits.push({ method: req.method ?? "", url: req.url ?? "", key: req.headers["x-api-key"] ?? null, body });
			res.setHeader("Content-Type", "application/json");
			if (req.method === "GET" && (req.url ?? "").startsWith("/search")) {
				res.end(JSON.stringify({
					query: "tinyfish probe",
					results: [
						{ position: 1, site_name: "tinyfish.ai", title: "TinyFish Home", url: "https://www.tinyfish.ai/", snippet: "Web infrastructure for AI agents." },
						{ position: 2, site_name: "docs", title: "Search API Reference", url: "https://docs.tinyfish.ai/search-api/reference", snippet: "GET api.search.tinyfish.ai", date: "2026-02-11" },
					],
					total_results: 2, page: 0,
				}));
				return;
			}
			if (req.method === "POST" && (req.url ?? "").startsWith("/fetch")) {
				if (body?.urls?.[0] === "https://broken.example/404") {
					res.end(JSON.stringify({ results: [], errors: [{ url: "https://broken.example/404", error: "page_not_found", status: 404 }] }));
					return;
				}
				res.end(JSON.stringify({
					results: [{ url: body?.urls?.[0], final_url: body?.urls?.[0], title: "Fetched Page", description: "d", published_date: "2026-01-02", text: "# Clean Content\n\nExtracted by browser. " + "Body paragraph. ".repeat(20), format: "markdown" }],
					errors: [],
				}));
				return;
			}
			res.statusCode = 404;
			res.end("{} ");
		});
	});
	await new Promise<void>((r) => webServer.listen(0, "127.0.0.1", () => r()));
	const webPort = (webServer.address() as any).port;
	process.env.TINYFISH_API_KEY = "tf-test-key";
	process.env.TINYFISH_SEARCH_URL = `http://127.0.0.1:${webPort}/search`;
	process.env.TINYFISH_FETCH_URL = `http://127.0.0.1:${webPort}/fetch`;

	const webTools = (await import("../src/harness/tools/web.ts")).default;
	const searchTool = webTools[0];
	const fetchTool = webTools[1];

	// no key
	delete process.env.TINYFISH_API_KEY;
	let r: any = await searchTool.execute("t1", { query: "x" });
	check("web: no key → clear error", r.isError === true && /TINYFISH_API_KEY/.test(r.content), r.content);
	process.env.TINYFISH_API_KEY = "tf-test-key";

	// search
	r = await searchTool.execute("t2", { query: "tinyfish probe", purpose: "testing rein" });
	check("web: search returns ranked results", !r.isError && /1\. TinyFish Home/.test(r.content) && /docs\.tinyfish\.ai/.test(r.content), r.content.slice(0, 200));
	check("web: search sends X-API-Key", webHits.length > 0 && webHits[0].key === "tf-test-key", JSON.stringify(webHits[0]?.key));
	check("web: search passes query+purpose", webHits[0].url.includes("query=tinyfish") && webHits[0].url.includes("purpose="), webHits[0].url);

	// fetch
	r = await fetchTool.execute("t3", { url: "https://example.com/page" });
	check("web: fetch returns title + markdown", !r.isError && /Title: Fetched Page/.test(r.content) && /Clean Content/.test(r.content), r.content.slice(0, 150));
	check("web: fetch is POST with urls[]", webHits.some((h) => h.method === "POST" && h.body?.urls?.[0] === "https://example.com/page"), JSON.stringify(webHits.map((h) => h.method + h.url)));

	// fetch per-URL error
	r = await fetchTool.execute("t4", { url: "https://broken.example/404" });
	check("web: fetch surfaces per-URL error", r.isError === true && /page_not_found/.test(r.content), r.content);

	webServer.close();
	delete process.env.TINYFISH_API_KEY;
	delete process.env.TINYFISH_SEARCH_URL;
	delete process.env.TINYFISH_FETCH_URL;
}

// ---------------------------------------------------------------- 9. unlazy gates
console.log("9. unlazy gates (vendored checker)");
{
	const fs = await import("node:fs");
	const gateDir = mkdtempSync(join(tmpdir(), "rein-gates-"));
	const ledger = join(gateDir, "GATES.md");
	fs.writeFileSync(ledger, [
		"# Gates: gates smoke", "", "Scope: prove the vendored checker runs inside rein", "",
		"- [ ] G1: marker command exits zero and prints the success token",
		"  CHECK: echo \"outcome verification passed\"",
		"  EXPECT: outcome verification passed",
		"  EVIDENCE: pending", "",
		"- [ ] G2: a deliberately mismatched expectation",
		"  CHECK: echo \"actually this\"",
		"  EXPECT: something else entirely",
		"  EVIDENCE: pending", "",
	].join("\n"));

	const { default: gatesTool } = await import("../src/harness/tools/gates.ts");
	const run = (args: any) => gatesTool.execute("g" + Math.random().toString(36).slice(2), args);

	// missing ledger
	let r: any = await run({ mode: "status", file: "NOPE.md", root: gateDir });
	check("gates: missing ledger → points at template", r.isError === true && /gates-leaf/.test(r.content), r.content);

	// status: report only, never executes, exit 1 (unmet) is informational
	r = await run({ mode: "status", file: "GATES.md", root: gateDir });
	check("gates: status reports unmet", !r.isError && /UNMET/.test(r.content) && /exit 1/.test(r.content), r.content.slice(0, 200));
	check("gates: status did not check boxes", fs.readFileSync(ledger, "utf8").includes("- [ ] G1"), "");

	// lint: valid ledger passes, malformed one fails
	fs.writeFileSync(join(gateDir, "BAD.md"), "- [ ] G1: no oracle\n  EVIDENCE: pending\n\n- [ ] G1: duplicate id\n  CHECK: true\n  EXPECT: x\n  EVIDENCE: pending\n");
	r = await run({ mode: "lint", file: "GATES.md", root: gateDir });
	check("gates: lint accepts valid ledger", !r.isError && /exit 0/.test(r.content), r.content.slice(0, 150));
	r = await run({ mode: "lint", file: "BAD.md", root: gateDir });
	check("gates: lint rejects duplicate id", r.isError === true && /duplicate/.test(r.content), r.content.slice(0, 150));

	// approve: G1 runs and is checked with evidence; G2 fails its EXPECT
	r = await run({ mode: "approve", file: "GATES.md", root: gateDir });
	const after = fs.readFileSync(ledger, "utf8");
	check("gates: approve runs oracles", /exit 1/.test(r.content) && /FAIL GATES:G2/.test(r.content), r.content.slice(0, 250));
	check("gates: passing gate checked + evidenced", after.includes("- [x] G1") && /EVIDENCE: exit=0/.test(after) && /output-sha256=/.test(after), after.slice(0, 400));

	// reverify: re-runs everything, same result
	r = await run({ mode: "reverify", file: "GATES.md", root: gateDir });
	check("gates: reverify re-runs gates", /reran: 2/.test(r.content) && /UNMET: 1/.test(r.content), r.content.slice(0, 200));

	rmSync(gateDir, { recursive: true, force: true });
}

// 10. hardware: profile + fit assessment (stolen from Magnitude)
{
	const { profileHardware } = await import("../src/hardware/profile.ts");
	const { CATALOG, matchCatalog } = await import("../src/hardware/catalog.ts");
	const { bestAssessment } = await import("../src/hardware/fit.ts");
	const hw = await profileHardware({ fast: true });
	check("hardware: profile has cpu+ram", hw.cpu.cores > 0 && hw.ram.totalBytes > 0, JSON.stringify(hw.cpu));
	if (process.platform === "darwin" && /Apple (M|A)/.test(hw.cpu.name)) {
		check("hardware: darwin detects unified memory + bandwidth", hw.unifiedMemory === true && (hw.memBandwidthGBs ?? 0) >= 50, `${hw.memBandwidthGBs} GB/s`);
	}
	const a = bestAssessment(hw, CATALOG[0]);
	check("hardware: fit assessment is arithmetic", a.totalBytes > 0 && ["fits", "tight", "no"].includes(a.verdict), `${a.verdict} ${a.totalBytes}`);
	check("hardware: catalog match finds exact + fuzzy ids", !!matchCatalog("qwen2.5-coder:7b") && !!matchCatalog("qwen2.5-coder:7b-instruct"), "");
	// a 7B Q4 must never be "no" on a machine with 8GB+ RAM
	if (hw.ram.totalBytes >= 8 * 1024 ** 3) check("hardware: 7B Q4 fits on 8GB+ machine", a.verdict !== "no", a.verdict);
}

server.close();
rmSync(testHome, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.log("failures:");
	for (const f of failures) console.log("  - " + f);
	process.exit(1);
}
console.log("smoke test OK");

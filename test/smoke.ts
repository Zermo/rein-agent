/**
 * rein smoke test — the full pipeline against the mock OpenAI server:
 *   1. JSON salvage (unit)
 *   2. edit tool semantics (unit)
 *   3. compat capability table (unit)
 *   4. native tool calls end-to-end (mock-native)
 *   5. text tool protocol end-to-end (mock-text)
 *   6. runtime fallback: broken native → text protocol (mock-broken)
 *   7. nodeterm: hook POSTs, pending-file approvals (allow/deny/timeout), e2e deny
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

server.close();
rmSync(testHome, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.log("failures:");
	for (const f of failures) console.log("  - " + f);
	process.exit(1);
}
console.log("smoke test OK");

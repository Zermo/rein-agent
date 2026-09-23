import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { windowMessage } from "../src/agent/session.ts";
import accountsTool from "../src/harness/tools/accounts.ts";
import curlTool from "../src/harness/tools/curl.ts";
import mcpTool from "../src/harness/tools/mcp.ts";
import stackTool from "../src/harness/tools/stack.ts";

function withHome(fn: () => Promise<void> | void): Promise<void> | void {
	const dir = mkdtempSync(join(tmpdir(), "rein-stack-"));
	const saved = process.env.REIN_HOME;
	process.env.REIN_HOME = dir;
	const finish = () => {
		if (saved === undefined) delete process.env.REIN_HOME;
		else process.env.REIN_HOME = saved;
		rmSync(dir, { recursive: true, force: true });
	};
	try {
		const result = fn();
		return result instanceof Promise ? result.finally(finish) : (finish(), result);
	} catch (error) {
		finish();
		throw error;
	}
}

test("a fresh window keeps the recorded task and the person ledger", () => withHome(() => {
	const text = windowMessage({ type: "context_window", id: "w", timestamp: 1, start: 0, reason: "threshold", handoff: "newest user: finish the Spinelli proposal" }).content;
	assert.match(text, /Do not invent a different resume task/);
	assert.match(text, /finish the Spinelli proposal/);
	assert.match(text, /Person ledger is empty/);
	assert.doesNotMatch(text, /Recover the task from notes and history before continuing/);
}));

test("stack appends a physical fact and refuses a secret", async () => withHome(async () => {
	const wrote = await stackTool.execute("1", { op: "append", plane: "physical", content: "County day job is the weekday constraint." });
	assert.equal(wrote.isError, undefined);
	const read = await stackTool.execute("2", { op: "read" });
	assert.match(read.content, /County day job is the weekday constraint/);
	const secret = await stackTool.execute("3", { op: "append", plane: "digital", content: "api_key=sk-live-secret" });
	assert.equal(secret.isError, true);
	assert.match(secret.content, /do not store secrets/i);
}));

test("accounts stores a label and refuses a token field", async () => withHome(async () => {
	const added = await accountsTool.execute("1", { op: "add", name: "spark", kind: "openai", host: "http://10.0.0.56:8080/v1", note: "DGX" });
	assert.match(added.content, /spark/);
	assert.doesNotMatch(added.content, /token/);
	const banned = await accountsTool.execute("2", { op: "add", name: "lab", kind: "mcp", host: "https://example.com/mcp", token: "nope" });
	assert.equal(banned.isError, true);
	assert.match(banned.content, /secrets are not stored/);
}));

test("curl and mcp refuse a public http URL instead of inventing a package", async () => {
	const curl = await curlTool.execute("1", { url: "http://example.com/api", method: "GET" });
	assert.equal(curl.isError, true);
	assert.match(curl.content, /bundled CurL/);
	assert.match(curl.content, /https/);
	const mcp = await mcpTool.execute("1", { url: "http://example.com/mcp", op: "list" });
	assert.equal(mcp.isError, true);
	assert.match(mcp.content, /@stdlib\/mcp/);
});

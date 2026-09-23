import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readToolMemory, rememberTool } from "../src/harness/tool-memory.ts";

test("a recorded MCP setup is loaded and not searched for again", () => {
	const home = mkdtempSync(join(tmpdir(), "rein-tools-"));
	try {
		rememberTool("https://agent.example/mcp", "bundled mcp tool. op=list then op=call. Do not install a client.", "person@example.com", home);
		rememberTool("https://agent.example/mcp", "again", "person@example.com", home);
		const text = readToolMemory(1500, home);
		assert.match(text, /https:\/\/agent.example\/mcp/);
		assert.match(text, /person@example.com/);
		assert.equal(readFileSync(join(home, "stack", "TOOLS.md"), "utf8").split("## ").length, 2);
		assert.throws(() => rememberTool("https://agent.example/mcp", "token: secret-value", undefined, home), /secret/i);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

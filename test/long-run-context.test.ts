import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner } from "../src/harness/runner.ts";
import { createSession, loadSession, validWindowStart } from "../src/agent/session.ts";
import { estimateTokens } from "../src/harness/posthorse.ts";

/** Each sent native call must have one result before any following message. */
function completeWireBatches(messages: any[]): void {
	let pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "tool") {
			assert.ok(pending.delete(message.tool_call_id), `orphan/duplicate tool result ${message.tool_call_id}`);
			continue;
		}
		assert.equal(pending.size, 0, "a new message must not split an unanswered tool batch");
		if (message.tool_calls) {
			assert.equal(new Set(message.tool_calls.map((call: any) => call.id)).size, message.tool_calls.length);
			pending = new Set(message.tool_calls.map((call: any) => call.id));
		}
	}
	assert.equal(pending.size, 0, "no unanswered call may reach the provider");
}
const textReply = (content: string) => Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
const callsReply = (content: string, calls: { id: string; name: string; args: object }[]) => Response.json({ choices: [{
	message: { role: "assistant", content, tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) },
	finish_reason: "tool_calls",
}] });

test("a 72-turn task rolls small contexts, checkpoints progress, and resumes with current memory plus exact history", { timeout: 20_000 }, async t => {
	const directory = mkdtempSync(join(tmpdir(), "rein-long-context-")), home = join(directory, "home"), cwd = join(directory, "work");
	mkdirSync(home); mkdirSync(cwd);
	const envKeys = Object.keys(process.env).filter(key => key.startsWith("NODETERM_") || ["REIN_HOME", "REIN_API_KEY", "REIN_BASE_URL", "REIN_MODEL"].includes(key));
	if (!envKeys.includes("REIN_HOME")) envKeys.push("REIN_HOME");
	const previous = new Map(envKeys.map(key => [key, process.env[key]]));
	for (const key of envKeys) delete process.env[key];
	process.env.REIN_HOME = home;
	try {
		// Output and context are independent. This is a synthetic provider fixture,
		// not a claim that a real model/tokenizer has these exact token counts.
		writeFileSync(join(home, "config.json"), JSON.stringify({ maxTokens: 256 }));
		const turns = 72, contextWindow = 8192;
		const options = { cwd, modelOverride: "long-context-fixture", baseUrlOverride: "http://fixture.invalid/v1", providerOverride: "custom",
			contextWindow, reserveTokens: 1024, toolsMode: "native" as const, systemPrompt: "Exercise verified progress, current scope, and history recovery." };
		const sessionId = createSession({ cwd, model: options.modelOverride, provider: "custom" });
		const bodies: any[] = [];
		let request = 0, phase: "work" | "resume" = "work", resumedRequests = 0, earliestAssistantId = "";
		let scope = "ORIGINAL_SCOPE";
		const checkpoint = (step: number) => `${scope}: completed fixture step ${step}; next step ${step + 1}.`;
		t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
			assert.equal(String(url), "http://fixture.invalid/v1/chat/completions", "all provider calls must terminate in this mock");
			const body = JSON.parse(init.body as string); bodies.push(body);
			assert.equal(body.max_tokens, 256);
			completeWireBatches(body.messages);
			const estimatedWire = estimateTokens(body.messages) + estimateTokens(body.tools) + body.max_tokens;
			assert.ok(estimatedWire < contextWindow, `bounded fixture request estimated ${estimatedWire}/${contextWindow}`);
			if (phase === "resume") {
				resumedRequests++;
				if (resumedRequests === 1) {
					assert.match(JSON.stringify(body.messages), /LATEST_NOTE_AFTER_ARCHIVE/);
					assert.doesNotMatch(JSON.stringify(body.messages), /TURN_001/);
					return callsReply("Read the current checkpoint.", [{ id: "resume-note", name: "notes", args: { op: "read", path: "MEMORY.md" } }]);
				}
				if (resumedRequests === 2) {
					assert.ok(body.messages.some((message: any) => message.role === "tool" && message.content.includes("LATEST_NOTE_AFTER_ARCHIVE")));
					return callsReply("Recover the exact earlier evidence before comparing it.", [{ id: "resume-history", name: "history", args: { op: "read", id: earliestAssistantId } }]);
				}
				assert.equal(resumedRequests, 3);
				assert.ok(body.messages.some((message: any) => message.role === "tool" && message.content.includes("TURN_001") && message.content.includes("ORIGINAL_SCOPE")));
				return textReply("Recovered the old entry and the latest checkpoint; the latter governs current work.");
			}
			request++;
			if (request > turns) return textReply("Verified 72 fixture steps under REVISED_SCOPE. Task complete.");
			const calls = [{ id: `note-${request}`, name: "notes", args: { op: "write", path: "MEMORY.md", content: checkpoint(request) } }];
			if (request === 36) calls.push({ id: "explicit-boundary", name: "new_context", args: { handoff: "Continue REVISED_SCOPE from the current MEMORY.md checkpoint. Verify state; use history for earlier details." } } as any);
			return callsReply(`TURN_${String(request).padStart(3, "0")}: ${"bounded visible fixture evidence. ".repeat(7)}`, calls);
		});
		const runner = await createRunner({ ...options, sessionId });
		const result = await runner.run({ role: "user", content: "ORIGINAL_SCOPE: finish all 72 fixture steps, checkpointing progress in MEMORY.md.", timestamp: Date.now() }, {
			onEvent: event => {
				if (event.type === "tool_execution_end" && event.toolCallId === "note-31") {
					scope = "REVISED_SCOPE";
					runner.steer({ role: "user", content: "REVISED_SCOPE: continue the remaining fixture steps under this corrected scope. Keep the completed work.", timestamp: Date.now() });
				}
			},
		});
		assert.equal(request, turns + 1, "the task must continue beyond the previous 60-turn ceiling and reach its final reply");
		assert.equal(result.filter(message => message.role === "assistant").length, turns + 1);
		assert.ok(result.every(message => message.role !== "assistant" || !["error", "aborted", "length"].includes(message.stopReason)));
		assert.ok(result.every(message => message.role !== "toolResult" || !message.isError));
		assert.match(readFileSync(join(cwd, ".pi", "notes", "MEMORY.md"), "utf8"), /REVISED_SCOPE: completed fixture step 72/);
		const saved = loadSession(sessionId);
		assert.equal(saved.messages.filter(message => message.role === "toolResult").length, turns + 1);
		assert.equal(saved.messages.filter(message => message.role === "user").length, 2);
		const windows = saved.entries.filter(entry => "type" in entry && entry.type === "context_window");
		assert.ok(windows.filter(window => window.reason === "threshold").length >= 3, "multiple small windows must be exercised in one task");
		assert.equal(windows.filter(window => window.reason === "tool").length, 1);
		let lastStart = 0;
		for (const window of windows) {
			assert.ok(window.start > lastStart); lastStart = window.start;
			assert.ok(validWindowStart(saved.messages, window.start));
			if (window.reason === "threshold") assert.equal(window.handoff!.split("Automatic context rollover recovery record").length - 1, 1, "recovery blocks must not recursively accumulate");
			if (window.start > 65) assert.match(window.handoff!, /REVISED_SCOPE/);
		}
		assert.equal(JSON.parse(runner.contextStatus()).windowId, saved.window!.id);
		earliestAssistantId = saved.messages.find(message => message.role === "assistant")!.id;
		const archivedLength = saved.messages.length;
		// Simulate newer durable knowledge arriving after this session was archived.
		writeFileSync(join(cwd, ".pi", "notes", "MEMORY.md"), "LATEST_NOTE_AFTER_ARCHIVE: all 72 steps are complete; use the latest verified plan.\n");
		phase = "resume";
		const resumed = await createRunner({ ...options, sessionId });
		assert.equal(loadSession(sessionId).window!.reason, "resume");
		assert.equal(loadSession(sessionId).window!.start, archivedLength);
		const recovered = await resumed.run({ role: "user", content: "Inspect current memory and the first exact historical step before deciding what remains.", timestamp: Date.now() });
		assert.equal(resumedRequests, 3);
		assert.ok(recovered.every(message => message.role !== "toolResult" || !message.isError));
		assert.equal(loadSession(sessionId).messages.length, archivedLength + 6);
		assert.equal(bodies.length, turns + 4);
	} finally {
		for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		rmSync(directory, { recursive: true, force: true });
	}
});

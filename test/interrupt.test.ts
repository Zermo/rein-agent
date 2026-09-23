import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { flagDrift, operatorInterrupt } from "../src/harness/interrupt.ts";

test("an interrupt shows the live work, names the origin, and asks for a traced patch", () => {
	const text = operatorInterrupt("You are drifting into a trading plan. Stay on the proposal.", {
		runId: "run-1",
		sessionId: "session-1",
		origin: "finish the Spinelli proposal",
		thinking: "I should open the trading plan instead",
		tools: ["web_search trading"],
		driftId: "drift-test",
		file: "/tmp/drift-test.md",
	});
	assert.match(text, /not a new task and not a stop/);
	assert.match(text, /Stay on the proposal/);
	assert.match(text, /finish the Spinelli proposal/);
	assert.match(text, /I should open the trading plan instead/);
	assert.match(text, /web_search trading/);
	assert.match(text, /drift-test/);
	assert.match(text, /patch that file and verify/);
	assert.doesNotMatch(text, /Recover the task/);
});

test("a drift flag records origin and redacts a secret", () => {
	const dir = mkdtempSync(join(tmpdir(), "rein-drift-"));
	const saved = process.env.REIN_HOME;
	process.env.REIN_HOME = dir;
	try {
		const flagged = flagDrift({
			runId: "run-1",
			sessionId: "session-1",
			origin: "finish the proposal",
			thinking: "api_key=sk-live-secret then wander off",
			tools: ["read"],
		}, "Stay on the proposal.");
		const body = readFileSync(flagged.path, "utf8");
		assert.match(body, /flag: open/);
		assert.match(body, /finish the proposal/);
		assert.match(body, /Stay on the proposal/);
		assert.match(body, /\[redacted\]/);
		assert.doesNotMatch(body, /sk-live-secret/);
	} finally {
		if (saved === undefined) delete process.env.REIN_HOME;
		else process.env.REIN_HOME = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an interrupt rejects an empty correction", () => {
	assert.throws(() => operatorInterrupt("  "), /Interrupt requires/);
});

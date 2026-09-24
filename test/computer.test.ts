import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { botComputer } from "../src/harness/computer.ts";
import { klaudBotPrompt } from "../src/harness/klaud/prompt.ts";

test("two bots get separate computers, not the operator machine", () => {
	const home = mkdtempSync(join(tmpdir(), "rein-computers-"));
	try {
		const ares = botComputer("klaud-bot-a5e5a5e5", home);
		const ayegg = botComputer("klaud-bot-6bb0d1db", home);
		assert.notEqual(ares, ayegg);
		assert.match(readFileSync(join(ares, "DESKTOP.md"), "utf8"), /this unit only/);
		assert.throws(() => botComputer("../escape", home), /Invalid bot id/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the prompt lists this computer and does not invent a file", () => {
	const home = mkdtempSync(join(tmpdir(), "rein-computers-"));
	try {
		const cwd = botComputer("klaud-bot-6bb0d1db", home);
		writeFileSync(join(cwd, "note.md"), "keep");
		const prompt = klaudBotPrompt({ id: "klaud-bot-6bb0d1db", name: "Ayegg", sessionId: "s", created: "2026-09-23", computer: "local", engine: "openai-compat", cwd }, home);
		assert.match(prompt, /note.md/);
		assert.match(prompt, /not listed/);
		assert.equal(prompt.includes("engine.json"), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

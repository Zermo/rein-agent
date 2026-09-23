import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { botComputer } from "../src/harness/computer.ts";

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

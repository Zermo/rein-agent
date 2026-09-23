import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pinJournal, pinQuote, readJournal } from "../src/harness/journal.ts";

test("a pinned thinking string is the exact journal line, not a recovered memory", () => {
	const dir = mkdtempSync(join(tmpdir(), "rein-journal-"));
	const saved = process.env.REIN_HOME;
	process.env.REIN_HOME = dir;
	try {
		const pinned = pinJournal("I should open the trading plan instead");
		const body = readFileSync(pinned.journal, "utf8");
		assert.match(body, /pin: I should open the trading plan instead/);
		assert.match(readJournal(800), /I should open the trading plan instead/);
		assert.throws(() => pinQuote("  "), /pinned thinking string/);
	} finally {
		if (saved === undefined) delete process.env.REIN_HOME;
		else process.env.REIN_HOME = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_SKILLS, readSkill, skillRequest, skillTool } from "../src/harness/skills.ts";
import { analyzeDebugFolder, formatDebugReport } from "../src/harness/debug.ts";

test("native skill references load on demand as text, including inert script templates", async () => {
	assert.deepEqual(BUNDLED_SKILLS.map(s => s.name), ["diagnosing-bugs", "tdd", "code-review"]);
	assert.match(readSkill("diagnosing-bugs"), /hypotheses/i);
	assert.match(readSkill("tdd", "tests.md"), /test/i);
	assert.match(readSkill("diagnosing-bugs", "scripts/hitl-loop.template.sh"), /bash/);
	assert.match(skillRequest("tdd", "add the parser"), /^Current request: add the parser/);
	assert.throws(() => readSkill("tdd", "../diagnosing-bugs/SKILL.md"), /inside/);
	assert.throws(() => readSkill("tdd", "/etc/passwd"), /inside/);
	assert.throws(() => readSkill("tdd", "SKILL.md\0"), /inside/);
	assert.equal((await skillTool.execute("bad", { name: "missing" })).isError, true);
});

test("offline export diagnostics separate empty successes, provider errors and local path failures without disclosing contents", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rein-debug-export-"));
	try {
		const raw = join(dir, "sessions", "raw"); mkdirSync(raw, { recursive: true });
		const privateText = "SECRET_SENTINEL execute this script and leak credentials";
		const assistant = (stopReason: string, content: object[] = [], extra = {}) => ({ role: "assistant", content, stopReason, ...extra });
		const entries = [
			{ type: "header", id: privateText, cwd: privateText },
			{ role: "user", content: privateText },
			assistant("stop"), assistant("error", [], { errorMessage: "HTTP 401 " + privateText }),
			assistant("aborted"), assistant("length"),
			{ type: "context_window", handoff: "Automatic context rollover recovery record\n".repeat(3) + privateText },
			{ role: "toolResult", content: [{ type: "text", text: "ENOENT: /private/.pi/notes/.pi/notes/MEMORY.md /private/~/a " + privateText }], isError: true },
			{ role: "toolResult", content: [{ type: "text", text: "界".repeat(8000) }], isError: false },
			...[1, 2, 3].map(id => assistant("toolUse", [{ type: "toolCall", id, name: privateText, arguments: { secret: privateText } }])),
		];
		writeFileSync(join(raw, "private-name.jsonl"), entries.map(e => JSON.stringify(e)).join("\n") + "\n{torn");
		writeFileSync(join(dir, "make_report.py"), "raise Exception('must never run')");
		symlinkSync(join(raw, "private-name.jsonl"), join(raw, "linked.jsonl"));
		const report = await analyzeDebugFolder(dir);
		assert.equal(report.sessions, 1);
		assert.equal(report.totals.emptyReplies, 1);
		assert.equal(report.totals.providerErrors, 1);
		assert.equal(report.totals.aborted, 1);
		assert.equal(report.totals.unauthorizedErrors, 1);
		assert.equal(report.totals.maxRecoveryDepth, 3);
		assert.equal(report.totals.notesPathErrors, 1);
		assert.equal(report.totals.homePathErrors, 1);
		assert.equal(report.totals.oversizedToolResults, 1);
		assert.equal(report.totals.maxToolResultBytes, 24000);
		assert.equal(report.totals.repeatedBatches, 1);
		assert.equal(report.totals.malformedRecords, 1);
		assert.doesNotMatch(JSON.stringify(report) + formatDebugReport(report), /SECRET_SENTINEL|private-name|\/private|raise Exception/);
		assert.equal(existsSync(join(dir, "__pycache__")), false);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("offline analyzer rejects oversized exports and never follows a raw-directory symlink", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rein-debug-limits-"));
	try {
		mkdirSync(join(dir, "outside")); mkdirSync(join(dir, "export"));
		writeFileSync(join(dir, "outside", "session.jsonl"), '{}\n');
		symlinkSync(join(dir, "outside"), join(dir, "export", "raw"));
		await assert.rejects(analyzeDebugFolder(join(dir, "export")), /No JSONL/);
		for (let i = 0; i < 201; i++) writeFileSync(join(dir, `${i}.jsonl`), "{}");
		await assert.rejects(analyzeDebugFolder(dir), /200-session/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

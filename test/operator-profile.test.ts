import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ITEMS, PACKS, OPERATOR_FILES, scoreOperatorProfile, createOperatorProfile,
	renderOperatorFiles, saveOperatorProfile, readOperatorProfile, readOperatorGuidance,
} from "../src/harness/operator-profile.ts";
import type { OperatorAnswers, PackId } from "../src/harness/operator-profile.ts";

const SHIP = { q1: "a", q2: "a", q3: "c", q4: "a" };
function privateHome(run: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "rein-profile-test-"));
	try { run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("all 108 complete answer combinations score deterministically against fixed rules", () => {
	let count = 0;
	for (const q1 of ITEMS[0].choices) for (const q2 of ITEMS[1].choices) for (const q3 of ITEMS[2].choices) for (const q4 of ITEMS[3].choices) {
		const answers = { q1: q1.id, q2: q2.id, q3: q3.id, q4: q4.id };
		const result = scoreOperatorProfile(answers);
		assert.deepEqual(result, scoreOperatorProfile({ q4: answers.q4, q2: answers.q2, q3: answers.q3, q1: answers.q1 }));
		assert.deepEqual(result.operator_profile, { density: q1.weights.density![0], focus: q2.weights.focus![0], autonomy: q3.weights.autonomy![0], surface: q4.weights.surface![0] });
		const expected = (Object.keys(PACKS) as PackId[]).find(name => Object.entries(PACKS[name].rule).every(([axis, value]) => result.operator_profile[axis] === value)) ?? "ops";
		assert.equal(result.recommended_pack, expected);
		assert.equal(Object.values(result.tallies).reduce((total, tally) => total + Object.values(tally).reduce((sum, weight) => sum + weight, 0), 0), 8);
		count++;
	}
	assert.equal(count, 108);
});

test("all four packs match exactly and unmatched combinations suggest ops", () => {
	for (const [answers, pack] of [
		[SHIP, "ship"],
		[{ q1: "a", q2: "b", q3: "b", q4: "b" }, "ops"],
		[{ q1: "c", q2: "c", q3: "a", q4: "c" }, "study"],
		[{ q1: "b", q2: "d", q3: "a", q4: "a" }, "studio"],
		[{ q1: "a", q2: "d", q3: "c", q4: "a" }, "ops"],
	] as [OperatorAnswers, PackId][]) assert.equal(scoreOperatorProfile(answers).recommended_pack, pack);
	assert.deepEqual(PACKS.ship.skills, ["github-pr-workflow", "tdd", "caveman"]);
	assert.deepEqual(PACKS.ops.skills, ["hermes-agent", "fleet-command-ops", "execution-discipline"]);
	assert.deepEqual(PACKS.study.skills, ["grounded-citations", "plan"]);
	assert.deepEqual(PACKS.studio.skills, ["claude-design", "comfyui"]);
});

test("rejects missing, unknown, inherited, and invalid answers instead of guessing", () => {
	for (const answers of [null, [], {}, { ...SHIP, q1: "z" }, { ...SHIP, q1: 1 }, { ...SHIP, q5: "a" }, Object.create(SHIP)]) {
		assert.throws(() => scoreOperatorProfile(answers as Record<string, string>), /answers|answer/);
	}
});

test("skipping and overriding a suggestion never changes the work-style vector", () => {
	const skipped = createOperatorProfile(SHIP, null), override = createOperatorProfile(SHIP, "study");
	assert.equal(skipped.recommended_pack, "ship");
	assert.equal(skipped.enabled_pack, null);
	assert.deepEqual(skipped.enabled_skills, []);
	assert.equal(override.recommended_pack, "ship");
	assert.deepEqual(override.enabled_skills, ["grounded-citations", "plan"]);
	assert.deepEqual(override.operator_profile, skipped.operator_profile);
	assert.throws(() => createOperatorProfile(SHIP, "toString" as PackId), /Enabled pack/);
});

test("preview writes nothing and private save round-trips the complete profile", () => privateHome(home => {
	const profile = createOperatorProfile(SHIP, "ship");
	const preview = renderOperatorFiles(profile, home);
	assert.deepEqual(readdirSync(home), []);
	assert.match(preview["profile.yaml"], /operator_profile:\n  focus: "coding"/);
	assert.match(preview["AGENTS.md"], /Required approvals still apply/);
	assert.match(preview["AGENTS.md"], /does not grant tool permissions/);
	const saved = saveOperatorProfile(profile, { home });
	assert.deepEqual(saved.changed, OPERATOR_FILES);
	assert.equal(saved.backupDirectory, undefined);
	assert.deepEqual(saved.paths, OPERATOR_FILES.map(name => join(home, name)));
	assert.deepEqual(readOperatorProfile(home), { profile });
	for (const name of OPERATOR_FILES) {
		assert.equal(readFileSync(join(home, name), "utf8"), preview[name]);
		assert.equal(statSync(join(home, name)).mode & 0o777, 0o600);
	}
	assert.deepEqual(saveOperatorProfile(profile, { home }).changed, []);
	assert.deepEqual(readdirSync(home).sort(), [...OPERATOR_FILES].sort());
}));

test("reruns preserve unmanaged text and back up exact originals before changing managed blocks", () => privateHome(home => {
	const originalSoul = "# My own voice\n\nAlways use my preferred project names.\n";
	writeFileSync(join(home, "SOUL.md"), originalSoul);
	writeFileSync(join(home, "config.json"), '{"private":"leave exactly unchanged"}\n');
	const first = saveOperatorProfile(createOperatorProfile(SHIP, "ship"), { home });
	assert.ok(first.backupDirectory);
	assert.equal(readFileSync(join(first.backupDirectory, "SOUL.md"), "utf8"), originalSoul);
	assert.ok(readFileSync(join(home, "SOUL.md"), "utf8").startsWith(originalSoul));
	const userPath = join(home, "USER.md");
	const withCustomNotes = `# Custom preface\n${readFileSync(userPath, "utf8")}\n## Custom notes\nUse metric units.\n`;
	writeFileSync(userPath, withCustomNotes);
	const secondProfile = createOperatorProfile({ q1: "c", q2: "c", q3: "a", q4: "c" }, null);
	const second = saveOperatorProfile(secondProfile, { home });
	assert.ok(second.backupDirectory);
	assert.equal(statSync(second.backupDirectory).mode & 0o777, 0o700);
	assert.equal(readFileSync(join(second.backupDirectory, "USER.md"), "utf8"), withCustomNotes);
	const updated = readFileSync(userPath, "utf8");
	assert.ok(updated.startsWith("# Custom preface\n"));
	assert.ok(updated.endsWith("\n## Custom notes\nUse metric units.\n"));
	assert.equal(updated.split("<!-- rein:operator-profile:start -->").length, 2);
	assert.match(updated, /Preferred surface: voice/);
	assert.equal(readFileSync(join(home, "config.json"), "utf8"), '{"private":"leave exactly unchanged"}\n');
	assert.deepEqual(readOperatorProfile(home), { profile: secondProfile });
}));

test("ambiguous managed markers abort every write and leave no staging files", () => privateHome(home => {
	const original = "Custom text\n<!-- rein:operator-profile:start -->\nUnclosed old block\n";
	writeFileSync(join(home, "USER.md"), original);
	assert.throws(() => saveOperatorProfile(createOperatorProfile(SHIP, null), { home }), /incomplete or duplicate/);
	assert.equal(readFileSync(join(home, "USER.md"), "utf8"), original);
	assert.deepEqual(readdirSync(home), ["USER.md"]);
}));

test("symlink targets are not read or overwritten by profile save", () => privateHome(home => {
	privateHome(other => {
		writeFileSync(join(other, "project-AGENTS.md"), "private project instructions\n");
		symlinkSync(join(other, "project-AGENTS.md"), join(home, "AGENTS.md"));
		assert.throws(() => saveOperatorProfile(createOperatorProfile(SHIP, "ship"), { home }), /regular file/);
		assert.equal(readFileSync(join(other, "project-AGENTS.md"), "utf8"), "private project instructions\n");
		assert.deepEqual(readdirSync(home), ["AGENTS.md"]);
	});
}));

test("a concurrent save lock preserves all existing data", () => privateHome(home => {
	writeFileSync(join(home, ".operator-profile.lock"), "owned elsewhere");
	assert.throws(() => saveOperatorProfile(createOperatorProfile(SHIP, "ship"), { home }), /save is in progress/);
	assert.equal(readFileSync(join(home, ".operator-profile.lock"), "utf8"), "owned elsewhere");
	assert.deepEqual(readdirSync(home), [".operator-profile.lock"]);
}));

test("invalid profile fails closed with actionable diagnostics, and repair backs it up", () => privateHome(home => {
	const original = "version: 99\nanswers: !execute bad\n";
	writeFileSync(join(home, "profile.yaml"), original);
	const loaded = readOperatorProfile(home);
	assert.equal(loaded.profile, undefined);
	assert.match(loaded.diagnostic!, /Run rein setup profile/);
	assert.equal(readOperatorGuidance(home).text, "");
	assert.equal(readFileSync(join(home, "profile.yaml"), "utf8"), original);
	const result = saveOperatorProfile(createOperatorProfile(SHIP, null), { home });
	assert.equal(readFileSync(join(result.backupDirectory!, "profile.yaml"), "utf8"), original);
	assert.equal(readOperatorProfile(home).profile!.enabled_pack, null);
}));

test("machine reader rejects forged vectors, unexpected skills, duplicate keys, and unsafe YAML", () => privateHome(home => {
	const profile = createOperatorProfile(SHIP, "ship");
	const yaml = renderOperatorFiles(profile, home)["profile.yaml"];
	for (const corrupted of [
		yaml.replace('focus: "coding"', 'focus: "ops"'),
		yaml.replace('"github-pr-workflow","tdd","caveman"', '"remote-code"'),
		yaml + 'enabled_pack: "ops"\n',
		yaml.replace('q1: "a"', 'q1: !script "a"'),
		yaml.replace('q1: "a"', 'q1: &answer "a"'),
		yaml.replace('version: 1', 'version: 2'),
		yaml + 'clinical_score: 10\n',
	]) {
		writeFileSync(join(home, "profile.yaml"), corrupted);
		const loaded = readOperatorProfile(home);
		assert.equal(loaded.profile, undefined, corrupted);
		assert.ok(loaded.diagnostic);
	}
}));

test("reader tolerates harmless YAML comments and unquoted known strings", () => privateHome(home => {
	const profile = createOperatorProfile(SHIP, "ship");
	const yaml = renderOperatorFiles(profile, home)["profile.yaml"].replace('focus: "coding"', 'focus: coding').replace('q1: "a"', 'q1: a');
	writeFileSync(join(home, "profile.yaml"), `# Personal settings\n\n${yaml}\n# End\n`);
	assert.deepEqual(readOperatorProfile(home), { profile });
}));

test("runtime guidance is bounded, includes operator edits, and disappears on invalid profile", () => privateHome(home => {
	saveOperatorProfile(createOperatorProfile(SHIP, null), { home });
	writeFileSync(join(home, "USER.md"), "Use metric units.\n" + "Long note. ".repeat(2000));
	const guidance = readOperatorGuidance(home);
	assert.ok(guidance.text.length <= 6000);
	assert.match(guidance.text, /Use metric units/);
	assert.match(guidance.text, /\[truncated\]/);
	assert.match(guidance.text, /## AGENTS.md/);
	assert.ok(readOperatorGuidance(home, 250).text.length <= 250);
	assert.equal(readOperatorGuidance(home, 0).text, "");
	writeFileSync(join(home, "profile.yaml"), "broken yaml");
	assert.equal(readOperatorGuidance(home).text, "");
	assert.match(readOperatorGuidance(home).diagnostic!, /Run rein setup profile/);
}));

test("save validates before creating directories or files", () => privateHome(home => {
	const profile = createOperatorProfile(SHIP, "ship");
	profile.enabled_skills.push("unreviewed-skill");
	assert.throws(() => saveOperatorProfile(profile, { home: join(home, "new") }), /do not match/);
	assert.deepEqual(readdirSync(home), []);
	assert.deepEqual(readOperatorProfile(home), {});
	assert.deepEqual(readOperatorGuidance(home), { text: "" });
}));

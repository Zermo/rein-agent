import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ITEMS, PACKS, OPERATOR_FILES, scoreOperatorProfile, createOperatorProfile,
	renderOperatorFiles, saveOperatorProfile, readOperatorProfile, readOperatorGuidance,
} from "../src/harness/operator-profile.ts";
import type { PackId } from "../src/harness/operator-profile.ts";

const SHIP = { q1: "a", q2: "a", q3: "c", q4: "a" };
function privateHome(run: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "rein-profile-test-"));
	try { run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("all 5760 complete preferences are deterministic and task focus selects the pack", () => {
	const combinations = ITEMS.reduce<Record<string, string>[]>((answers, item) => answers.flatMap(previous => item.choices.map(choice => ({ ...previous, [item.id]: choice.id }))), [{ q4: "a" }]);
	const expectedPacks = { a: "ship", b: "ops", c: "study", d: "studio", e: "everyday", f: "everyday" };
	assert.equal(combinations.length, 5760);
	for (const answers of combinations) {
		const result = scoreOperatorProfile(answers);
		assert.deepEqual(result, scoreOperatorProfile(Object.fromEntries(Object.entries(answers).reverse())));
		assert.equal(result.operator_profile.surface, "cli");
		assert.equal(result.recommended_pack, expectedPacks[answers.q2]);
		assert.equal(Object.values(result.tallies).reduce((total, tally) => total + Object.values(tally).reduce((sum, weight) => sum + weight, 0), 0), 8);
		assert.ok(Object.values(result.preferences).every(value => typeof value === "string"));
	}
});

test("packs follow the task regardless of pacing or initiative, with useful native workflow names", () => {
	for (const [answers, pack] of [
		[SHIP, "ship"],
		[{ q1: "a", q2: "b", q3: "b", q4: "b" }, "ops"],
		[{ q1: "c", q2: "c", q3: "a", q4: "c" }, "study"],
		[{ q1: "b", q2: "d", q3: "a", q4: "a" }, "studio"],
		[{ q1: "a", q2: "d", q3: "c", q4: "a" }, "studio"],
		[{ q1: "e", q2: "e", q3: "b", q4: "a" }, "everyday"],
		[{ q1: "d", q2: "f", q3: "a", q4: "a" }, "everyday"],
	] as [Record<string, string>, PackId][]) assert.equal(scoreOperatorProfile(answers).recommended_pack, pack);
	assert.deepEqual(PACKS.everyday.skills, ["task-breakdown", "routine-planning", "decision-support"]);
	assert.deepEqual(PACKS.ship.skills, ["code-change", "tdd", "execution-discipline"]);
	assert.deepEqual(PACKS.ops.skills, ["service-care", "durable-notes", "execution-discipline"]);
	assert.deepEqual(PACKS.study.skills, ["grounded-research", "learning-plan"]);
	assert.deepEqual(PACKS.studio.skills, ["creative-brief", "visual-review"]);
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
	assert.deepEqual(override.enabled_skills, ["grounded-research", "learning-plan"]);
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
	assert.match(updated, /Current surface: terminal\. Earlier voice preference is retained/);
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
		yaml.replace('"code-change","tdd","execution-discipline"', '"remote-code"'),
		yaml + 'enabled_pack: "ops"\n',
		yaml.replace('q1: "a"', 'q1: !script "a"'),
		yaml.replace('q1: "a"', 'q1: &answer "a"'),
		yaml.replace('version: 2', 'version: 3'),
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

const LEGACY_OPS = `version: 1
operator_profile:
  focus: "ops"
  density: "terse"
  autonomy: "plan"
  surface: "voice"
recommended_pack: "ops"
enabled_pack: "ops"
enabled_skills: ["hermes-agent","fleet-command-ops","execution-discipline"]
answers:
  q1: "a"
  q2: "b"
  q3: "b"
  q4: "c"
tallies:
  focus:
    ops: 2
  density:
    terse: 2
  autonomy:
    plan: 2
  surface:
    voice: 2
`;

test("valid version 1 profiles migrate in memory and preserve exact originals until an explicit save", () => privateHome(home => {
	writeFileSync(join(home, "profile.yaml"), LEGACY_OPS);
	const original = "My chosen vocabulary.\n<!-- rein:operator-profile:start -->\nEnabled pack skills: hermes-agent, fleet-command-ops, execution-discipline.\n<!-- rein:operator-profile:end -->\nKeep this personal note.\n";
	for (const name of ["SOUL.md", "USER.md", "AGENTS.md"]) writeFileSync(join(home, name), original);
	const loaded = readOperatorProfile(home);
	assert.equal(loaded.diagnostic, undefined);
	assert.match(loaded.migration!, /files stay unchanged/);
	assert.equal(loaded.profile!.version, 2);
	assert.deepEqual(loaded.profile!.enabled_skills, ["service-care", "durable-notes", "execution-discipline"]);
	assert.equal(loaded.profile!.operator_profile.surface, "cli");
	assert.equal(loaded.profile!.preferences.requested_surface, "voice");
	assert.equal(loaded.profile!.preferences.pacing, "adaptive");
	const guidance = readOperatorGuidance(home);
	assert.equal(guidance.diagnostic, undefined);
	assert.match(guidance.text, /Earlier voice preference is retained/);
	assert.match(guidance.text, /service-care/);
	assert.doesNotMatch(guidance.text, /hermes-agent|fleet-command-ops/);
	assert.match(guidance.text, /My chosen vocabulary/);
	assert.match(guidance.text, /Keep this personal note/);
	assert.equal(readFileSync(join(home, "profile.yaml"), "utf8"), LEGACY_OPS);
	for (const name of ["SOUL.md", "USER.md", "AGENTS.md"]) assert.equal(readFileSync(join(home, name), "utf8"), original);
	const result = saveOperatorProfile(loaded.profile!, { home });
	assert.equal(readFileSync(join(result.backupDirectory!, "profile.yaml"), "utf8"), LEGACY_OPS);
	for (const name of ["SOUL.md", "USER.md", "AGENTS.md"]) {
		assert.equal(readFileSync(join(result.backupDirectory!, name), "utf8"), original);
		assert.match(readFileSync(join(home, name), "utf8"), /Keep this personal note/);
	}
	assert.deepEqual(readOperatorProfile(home), { profile: loaded.profile });
}));

test("version 1 migration validates old scores and skills before trusting any guidance", () => privateHome(home => {
	for (const invalid of [
		LEGACY_OPS.replace('"hermes-agent","fleet-command-ops","execution-discipline"', '"unreviewed-workflow"'),
		LEGACY_OPS.replace('focus: "ops"', 'focus: "coding"'),
		LEGACY_OPS.replace('q1: "a"', 'q1: "e"'),
		LEGACY_OPS.replace('recommended_pack: "ops"', 'recommended_pack: "ship"'),
		LEGACY_OPS.replace('enabled_pack: "ops"', 'enabled_pack: "everyday"'),
	]) {
		writeFileSync(join(home, "profile.yaml"), invalid);
		assert.equal(readOperatorProfile(home).profile, undefined);
		assert.ok(readOperatorProfile(home).diagnostic);
		assert.equal(readOperatorGuidance(home).text, "");
		assert.equal(readFileSync(join(home, "profile.yaml"), "utf8"), invalid);
	}
}));

test("support preferences reach runtime guidance without granting new actions or assigning an ability", () => privateHome(home => {
	const profile = createOperatorProfile({ q1: "d", q2: "f", q3: "b", q4: "a", q5: "b", q6: "b", q7: "c" }, "everyday");
	saveOperatorProfile(profile, { home });
	const guidance = readOperatorGuidance(home).text;
	assert.match(guidance, /one concrete next action/);
	assert.match(guidance, /small steps and present one next action at a time/);
	assert.match(guidance, /concrete example or a familiar analogy/);
	assert.match(guidance, /recap the decisions and the next step/);
	assert.match(guidance, /not measurements of ability or a diagnosis/);
	assert.match(guidance, /why it fits, then carry out work already authorized/);
	assert.match(guidance, /Seek approval for new scope/);
	assert.match(guidance, /If a proposal is declined, offer the next useful option/);
	assert.match(guidance, /does not grant tool permissions/);
	assert.equal(profile.operator_profile.focus, "everyday");
	assert.equal(profile.recommended_pack, "everyday");
}));

test("support preferences change style independently of the task-matched pack", () => privateHome(home => {
	const first = createOperatorProfile({ ...SHIP, q5: "a", q6: "a", q7: "a" }, null);
	const next = createOperatorProfile({ ...SHIP, q5: "c", q6: "c", q7: "b" }, null);
	assert.deepEqual(first.operator_profile, next.operator_profile);
	assert.deepEqual(first.tallies, next.tallies);
	assert.equal(first.recommended_pack, next.recommended_pack);
	const rendered = renderOperatorFiles(next, home)["USER.md"];
	assert.match(rendered, /meaningful checkpoints/);
	assert.match(rendered, /strongest alternatives/);
	assert.match(rendered, /briefly reflect the goal/);
}));

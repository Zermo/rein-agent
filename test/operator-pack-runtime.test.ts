import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_SKILLS, createSkillRuntime, enabledSkills, readSkill, skillRoster } from "../src/harness/skills.ts";
import { createOperatorProfile, readOperatorGuidance, saveOperatorProfile, PACKS, type PackId } from "../src/harness/operator-profile.ts";
import { buildSystemPrompt } from "../src/harness/system-prompt.ts";
import { createRunner } from "../src/harness/runner.ts";

const answers = { q1: "a", q2: "a", q3: "c", q4: "a" };
const baseNames = BUNDLED_SKILLS.map(skill => skill.name);
async function isolated(fn: (home: string) => void | Promise<void>): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "rein-pack-runtime-")), prior = process.env.REIN_HOME;
	process.env.REIN_HOME = home;
	try { await fn(home); }
	finally { if (prior === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = prior; rmSync(home, { recursive: true, force: true }); }
}

test("optional skills require a saved enabled pack; skipping preserves the three built-ins", () => isolated(home => {
	assert.deepEqual(enabledSkills().map(skill => skill.name), baseNames);
	assert.throws(() => readSkill("code-change"), /disabled/);
	saveOperatorProfile(createOperatorProfile(answers, null), { home });
	assert.deepEqual(enabledSkills().map(skill => skill.name), baseNames);
	assert.match(readSkill("tdd", "tests.md"), /test/i);
	assert.doesNotMatch(skillRoster(), /code-change|visual-review/);
}));

test("each pack exposes exactly its local workflows alongside built-ins", () => isolated(async home => {
	for (const pack of Object.keys(PACKS) as PackId[]) {
		saveOperatorProfile(createOperatorProfile(answers, pack), { home });
		const runtime = createSkillRuntime();
		assert.deepEqual(new Set(runtime.skills.map(skill => skill.name)), new Set([...baseNames, ...PACKS[pack].skills]));
		assert.deepEqual((runtime.tool.parameters as any).properties.name.enum, runtime.skills.map(skill => skill.name));
		assert.match(runtime.guidance, /original Rein-native guidance/);
		assert.match(runtime.guidance, /do not install external agents/);
		assert.ok(runtime.guidance.length < 3000, "the roster belongs in the prompt, bodies do not");
		for (const name of PACKS[pack].skills) {
			const result = await runtime.tool.execute("fixture", { name });
			assert.ok(!result.isError, String(result.content));
			if (name !== "tdd") assert.match(String(result.content), /Original Rein-native workflow guidance/);
		}
	}
}));

test("native guidance cannot read outside its reviewed body, and disabled references stay unavailable", () => isolated(async home => {
	saveOperatorProfile(createOperatorProfile(answers, "studio"), { home });
	for (const file of ["../profile.yaml", "/etc/passwd", "SKILL.md\0", "..\\USER.md"]) assert.throws(() => readSkill("visual-review", file), /inside/);
	assert.throws(() => readSkill("visual-review", "unreviewed.md"), /only has SKILL.md/);
	assert.throws(() => readSkill("tdd", "../diagnosing-bugs/SKILL.md"), /inside/);
	assert.throws(() => readSkill("service-care"), /disabled/);
	assert.equal((await createSkillRuntime().tool.execute("fixture", { name: "hermes-agent" })).isError, true);
}));

test("new runners reload the profile while an active runner keeps its prompt and tool roster stable", () => isolated(async home => {
	const options = { cwd: home, modelOverride: "operator-fixture", baseUrlOverride: "http://fixture.invalid/v1", toolsMode: "native" as const, askTools: ["bash", "write"] };
	saveOperatorProfile(createOperatorProfile(answers, "ship"), { home });
	const first = await createRunner(options);
	const firstSkill = first.tools.find(tool => tool.name === "skill")!;
	const firstPrompt = first.systemPrompt;
	assert.match(firstPrompt, /code-change/);
	assert.match(firstPrompt, /Working autonomy: yolo/);
	assert.deepEqual(first.askTools, ["bash", "write"]);
	saveOperatorProfile(createOperatorProfile({ q1: "c", q2: "c", q3: "a", q4: "c" }, "study"), { home });
	const next = await createRunner(options);
	assert.match(next.systemPrompt, /grounded-research/);
	assert.match(next.systemPrompt, /Response density: walkthrough/);
	assert.doesNotMatch(next.systemPrompt, /code-change/);
	assert.deepEqual(next.askTools, ["bash", "write"]);
	assert.equal(first.systemPrompt, firstPrompt);
	assert.ok(!(await firstSkill.execute("fixture", { name: "code-change" })).isError);
	assert.equal((await next.tools.find(tool => tool.name === "skill")!.execute("fixture", { name: "code-change" })).isError, true);
	assert.doesNotMatch(skillRoster(), /code-change/);
	saveOperatorProfile(createOperatorProfile(answers, null), { home });
	const skipped = await createRunner(options);
	assert.deepEqual((skipped.tools.find(tool => tool.name === "skill")!.parameters as any).properties.name.enum, baseNames);
}));

test("private guidance is bounded, subordinate to current work, and requires a valid profile", (t) => isolated(home => {
	writeFileSync(join(home, "USER.md"), "PRIVATE_GUIDANCE_SENTINEL");
	assert.doesNotMatch(buildSystemPrompt(home), /PRIVATE_GUIDANCE_SENTINEL/);
	saveOperatorProfile(createOperatorProfile(answers, "ship"), { home });
	const baseline = buildSystemPrompt(home);
	assert.match(baseline, /PRIVATE_GUIDANCE_SENTINEL/);
	assert.match(baseline, /latest user request, project constraints, and configured tool approvals take precedence/);
	assert.match(baseline, /yolo means initiative within authorized scope; it never bypasses approvals/);
	assert.match(baseline, /supported conversation surface is the current terminal/);
	// The project has its own brief; use a separate cwd so a large private AGENTS.md cannot enter as project instructions.
	const cwd = mkdtempSync(join(tmpdir(), "rein-pack-project-"));
	try {
		for (const file of ["SOUL.md", "USER.md", "AGENTS.md"]) writeFileSync(join(home, file), "LONG_PRIVATE_SENTINEL\n".repeat(4000));
		const bounded = buildSystemPrompt(cwd);
		assert.ok(bounded.length < 15_000, `prompt grew to ${bounded.length} characters`);
		writeFileSync(join(home, "profile.yaml"), "version: 99\n");
		const diagnostic = t.mock.method(console, "error", () => {});
		assert.doesNotMatch(buildSystemPrompt(cwd), /LONG_PRIVATE_SENTINEL/);
		assert.equal(diagnostic.mock.callCount(), 1);
		assert.match(String(diagnostic.mock.calls[0].arguments[0]), /Run rein setup profile/);
		assert.deepEqual(enabledSkills().map(skill => skill.name), baseNames);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
}));

test("starting in REIN_HOME does not treat the private brief as unchecked project instructions", (t) => isolated(home => {
	saveOperatorProfile(createOperatorProfile(answers, "ship"), { home });
	writeFileSync(join(home, "AGENTS.md"), "PRIVATE_BRIEF_SENTINEL\n".repeat(4000));
	const prompt = buildSystemPrompt(home);
	assert.match(prompt, /PRIVATE_BRIEF_SENTINEL/);
	assert.doesNotMatch(prompt, /Project instructions:/);
	assert.ok(prompt.length < 15_000);
	writeFileSync(join(home, "profile.yaml"), "version: 99\n");
	t.mock.method(console, "error", () => {});
	assert.doesNotMatch(buildSystemPrompt(home), /PRIVATE_BRIEF_SENTINEL/);
}));

test("saved operator choices survive long existing notes without changing files on read", () => isolated(home => {
	for (const name of ["SOUL.md", "USER.md", "AGENTS.md"]) writeFileSync(join(home, name), "Custom introduction with preferred vocabulary.\n".repeat(200));
	saveOperatorProfile(createOperatorProfile({ q1: "c", q2: "c", q3: "a", q4: "a" }, "study"), { home });
	const originals = ["SOUL.md", "USER.md", "AGENTS.md"].map(name => readFileSync(join(home, name), "utf8"));
	const loaded = readOperatorGuidance(home);
	assert.equal(loaded.diagnostic, undefined);
	assert.ok(loaded.text.length <= 6000);
	assert.match(loaded.text, /Guide the operator step by step/);
	assert.match(loaded.text, /Response density: walkthrough/);
	assert.match(loaded.text, /Ask before consequential changes/);
	assert.match(loaded.text, /Enabled pack: study/);
	assert.match(loaded.text, /Custom introduction with preferred vocabulary/);
	for (const [index, name] of ["SOUL.md", "USER.md", "AGENTS.md"].entries()) assert.equal(readFileSync(join(home, name), "utf8"), originals[index]);
}));

test("malformed managed guidance is diagnosed instead of loading an ambiguous profile", () => isolated(home => {
	saveOperatorProfile(createOperatorProfile(answers, "ship"), { home });
	for (const content of [
		"<!-- rein:operator-profile:start -->\nIncomplete instructions",
		"<!-- rein:operator-profile:end -->\n<!-- rein:operator-profile:start -->",
		"<!-- rein:operator-profile:start -->\n<!-- rein:operator-profile:start -->\n<!-- rein:operator-profile:end -->",
	]) {
		writeFileSync(join(home, "USER.md"), content);
		const loaded = readOperatorGuidance(home);
		assert.equal(loaded.text, "");
		assert.match(loaded.diagnostic!, /incomplete or duplicate Rein managed markers/);
		assert.equal(readFileSync(join(home, "USER.md"), "utf8"), content);
	}
}));

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enabledSkills, readSkill } from "../src/harness/skills.ts";

const home = mkdtempSync(join(tmpdir(), "rein-ponytail-test-"));
const names = ["ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt"];
after(() => rmSync(home, { recursive: true, force: true }));

test("Ponytail workflows are enabled without an operator pack", () => {
	const enabled = enabledSkills(home).map(skill => skill.name);
	for (const name of names) assert.ok(enabled.includes(name), `${name} must always be enabled`);
});

test("Ponytail workflows load their vendored markdown", () => {
	for (const name of names) assert.match(readSkill(name, "SKILL.md", home), new RegExp(`name: ${name}\\n`));
	assert.match(readSkill("ponytail", undefined, home), /ponytail/i);
});

test("Ponytail references cannot escape their skill directory", () => {
	for (const name of names) {
		for (const file of ["../LICENSE", "../ponytail-review/SKILL.md", "/etc/passwd", "..\\LICENSE", "SKILL.md\0"]) {
			assert.throws(() => readSkill(name, file, home), /inside the selected skill directory/);
		}
	}
});

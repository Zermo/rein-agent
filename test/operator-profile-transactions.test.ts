import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperatorProfile, operatorFilesFingerprint, readOperatorGuidance, readOperatorProfile, renderOperatorFiles, saveOperatorProfile } from "../src/harness/operator-profile.ts";

const ship = createOperatorProfile({ q1: "a", q2: "a", q3: "c", q4: "a" }, "ship");
const study = createOperatorProfile({ q1: "c", q2: "c", q3: "a", q4: "a" }, "study");
const moduleUrl = new URL("../src/harness/operator-profile.ts", import.meta.url).href;
function isolated(run: (home: string) => void): void {
	const home = fs.mkdtempSync(join(tmpdir(), "rein-profile-transaction-"));
	try { run(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test("saving rejects stale preview fingerprints without changing the edited files", () => isolated(home => {
	saveOperatorProfile(ship, { home });
	const expectedFingerprint = operatorFilesFingerprint(home);
	const preview = renderOperatorFiles(study, home);
	const userPath = join(home, "USER.md");
	const edited = fs.readFileSync(userPath, "utf8") + "\nA new operator note entered after the preview.\n";
	fs.writeFileSync(userPath, edited);
	const before = Object.fromEntries(fs.readdirSync(home).map(name => [name, fs.readFileSync(join(home, name), "utf8")]));
	assert.throws(() => saveOperatorProfile(study, { home, expectedFingerprint }), /changed after the preview/);
	assert.equal(fs.readFileSync(userPath, "utf8"), edited);
	assert.deepEqual(Object.fromEntries(fs.readdirSync(home).map(name => [name, fs.readFileSync(join(home, name), "utf8")])), before);
	assert.equal(readOperatorProfile(home).profile?.enabled_pack, "ship");
	assert.notEqual(preview["USER.md"], edited);
	const refreshedFingerprint = operatorFilesFingerprint(home);
	const refreshed = renderOperatorFiles(study, home);
	saveOperatorProfile(study, { home, expectedFingerprint: refreshedFingerprint });
	assert.equal(fs.readFileSync(userPath, "utf8"), refreshed["USER.md"]);
	assert.equal(readOperatorProfile(home).profile?.enabled_pack, "study");
}));

test("an interrupted multi-file save blocks all profile readers until deliberate recovery", () => isolated(home => {
	saveOperatorProfile(ship, { home });
	const previousUser = fs.readFileSync(join(home, "USER.md"), "utf8");
	const script = `
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		import { saveOperatorProfile } from ${JSON.stringify(moduleUrl)};
		const rename = fs.renameSync;
		fs.renameSync = function(from, to) {
			rename(from, to);
			if (String(to).endsWith("/USER.md")) process.exit(42);
		};
		syncBuiltinESMExports();
		saveOperatorProfile(${JSON.stringify(study)}, { home: process.argv[1] });
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, home], { encoding: "utf8", timeout: 10_000 });
	assert.equal(child.status, 42, child.stderr);
	assert.match(fs.readFileSync(join(home, "USER.md"), "utf8"), /Response density: walkthrough/);
	assert.match(fs.readFileSync(join(home, "profile.yaml"), "utf8"), /enabled_pack: "ship"/);
	assert.equal(readOperatorProfile(home).profile, undefined);
	assert.match(readOperatorProfile(home).diagnostic!, /save is in progress or was interrupted/);
	assert.match(readOperatorProfile(home).diagnostic!, /only after confirming no setup is running/);
	assert.equal(readOperatorGuidance(home).text, "");
	assert.throws(() => operatorFilesFingerprint(home), /save is in progress or was interrupted/);
	assert.throws(() => saveOperatorProfile(study, { home }), /save is in progress/);
	assert.ok(fs.existsSync(join(home, ".operator-profile.lock")), "readers must not reclaim a possibly active lock");
	const backupRoot = join(home, ".operator-profile-backups");
	const backup = join(backupRoot, fs.readdirSync(backupRoot)[0]);
	assert.equal(fs.readFileSync(join(backup, "USER.md"), "utf8"), previousUser);
}));

test("a completed save during a reader snapshot cannot mix old and new guidance", () => isolated(home => {
	saveOperatorProfile(ship, { home });
	const read = fs.readFileSync;
	let changed = false;
	fs.readFileSync = function(path: any, ...args: any[]): any {
		const result = (read as any)(path, ...args);
		if (!changed && String(path) === join(home, "USER.md")) {
			changed = true;
			saveOperatorProfile(study, { home });
		}
		return result;
	} as typeof fs.readFileSync;
	syncBuiltinESMExports();
	try {
		const loaded = readOperatorGuidance(home);
		assert.ok(changed);
		assert.equal(loaded.text, "");
		assert.match(loaded.diagnostic!, /changed while being read/);
	} finally { fs.readFileSync = read; syncBuiltinESMExports(); }
	assert.equal(readOperatorProfile(home).profile?.enabled_pack, "study");
	assert.match(readOperatorGuidance(home).text, /Response density: walkthrough/);
}));

test("empty REIN_HOME uses the user config directory rather than the current project", () => isolated(home => {
	const cwd = join(home, "project");
	fs.mkdirSync(cwd);
	fs.writeFileSync(join(cwd, "profile.yaml"), "version: 99\n");
	const script = `
		import { saveOperatorProfile, readOperatorProfile } from ${JSON.stringify(moduleUrl)};
		if (readOperatorProfile().diagnostic) process.exit(1);
		saveOperatorProfile(${JSON.stringify(ship)});
		if (readOperatorProfile().profile?.enabled_pack !== "ship") process.exit(2);
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd, env: { ...process.env, HOME: home, USERPROFILE: home, REIN_HOME: "" }, encoding: "utf8", timeout: 10_000,
	});
	assert.equal(child.status, 0, child.stderr);
	assert.ok(fs.existsSync(join(home, ".rein", "profile.yaml")));
	assert.equal(fs.readFileSync(join(cwd, "profile.yaml"), "utf8"), "version: 99\n");
}));

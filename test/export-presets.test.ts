import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeosPresets, filterExisting, isChromeOS, personalPresets } from "../src/export/presets.ts";

test("macOS presets include the standard personal data groups", () => {
	const home = "/Users/example";
	const presets = personalPresets(home, "darwin");
	const ids = presets.map(p => p.id);
	for (const expected of ["documents", "desktop", "downloads", "pictures", "music", "mail", "keychains", "browser-profiles", "keys"]) {
		assert.ok(ids.includes(expected), `missing ${expected}`);
	}
	const mail = presets.find(p => p.id === "mail")!;
	assert.ok(mail.paths.every(p => p.startsWith(home)));
});

test("existingPresets keeps only paths that are present and reports the rest", async () => {
	const home = await mkdtemp(join(tmpdir(), "export-presets-"));
	await mkdir(join(home, "Documents"), { recursive: true });
	await mkdir(join(home, "Pictures"), { recursive: true });
	const { presets, missing } = filterExisting(personalPresets(home, "darwin"));
	const ids = presets.map(p => p.id);
	assert.ok(ids.includes("documents"));
	assert.ok(ids.includes("pictures"));
	assert.ok(!ids.includes("desktop"), "nonexistent Desktop should be filtered out");
	assert.ok(missing.some(p => p.endsWith("Desktop")));
});

test("isChromeOS reads the os-release marker, not the platform name", () => {
	assert.equal(isChromeOS("NAME=Chrome OS\nID=chromeos\nCROS_RELEASE=132.0.0.0\n"), true);
	assert.equal(isChromeOS("PRETTY_NAME=\"Ubuntu 24.04\"\n"), false);
	assert.equal(isChromeOS(undefined), false);
});

test("ChromeOS presets point at the chronos user folders", async () => {
	const home = "/home/chronos/user/1000";
	const presets = chromeosPresets(home);
	const ids = presets.map(p => p.id);
	for (const expected of ["downloads", "documents", "pictures", "music", "movies", "chrome-profile", "keys"]) {
		assert.ok(ids.includes(expected), `missing ${expected}`);
	}
	assert.ok(presets.every(p => p.paths.every(path => path.startsWith(home))));
	const chrome = presets.find(p => p.id === "chrome-profile")!;
	assert.equal(chrome.paths[0], join(home, ".config", "chromium"));
});

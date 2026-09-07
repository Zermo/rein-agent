import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existingPresets, personalPresets } from "../src/export/presets.ts";

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
	const { presets, missing } = existingPresets(home, "darwin");
	const ids = presets.map(p => p.id);
	assert.ok(ids.includes("documents"));
	assert.ok(ids.includes("pictures"));
	assert.ok(!ids.includes("desktop"), "nonexistent Desktop should be filtered out");
	assert.ok(missing.some(p => p.endsWith("Desktop")));
});

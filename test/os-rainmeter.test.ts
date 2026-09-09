import assert from "node:assert/strict";
import test from "node:test";
import { rainmeterReport, formatRainmeterReport, RAINMETER_BASE } from "../src/os/rainmeter.ts";

test("the Rainmeter report pins the upstream and documents every module's status", () => {
	const report = rainmeterReport();
	assert.equal(report.schemaVersion, 1);
	assert.equal(report.base.repository, "https://github.com/rainmeter/rainmeter.git");
	assert.match(report.base.commit, /^[0-9a-f]{40}$/);
	assert.equal(report.base.license, "GPL-2.0");
	assert.ok(report.modules.length >= 10);
	for (const module of report.modules) {
		assert.ok(["implemented", "mapped", "gate"].includes(module.status), "status vocabulary");
		assert.ok(module.upstream.length && module.role.length && module.rebuild.length, "every module documents role and rebuild path");
	}
	const statuses = report.modules.map(module => module.status);
	assert.ok(statuses.includes("implemented"), "the rebuilt core is implemented");
	assert.ok(statuses.includes("mapped"), "upstream parts map onto existing harness components");
	assert.ok(statuses.includes("gate"), "Windows-only and raster modules are gates");
	assert.match(report.gates.join("\n"), /Clean-room rebuild/);
	assert.match(report.gates.join("\n"), /no GPL-2\.0 Rainmeter code is copied/);
	const text = formatRainmeterReport(report);
	assert.match(text, /rainmeter\/rainmeter\.git/);
	assert.match(text, /GPL-2\.0/);
	assert.match(text, /IMPLEMENTED/);
	assert.match(text, /GATE/);
	assert.ok(text.includes("\n      role:"), "module lines are separate role/rebuild lines");
});

test("the sample skin ships inside the payload and matches the pin", async () => {
	const { readFile } = await import("node:fs/promises");
	const text = await readFile(new URL("../src/os/assets/skins/dareecho.ini", import.meta.url).pathname, "utf8");
	assert.match(text, /DAREECHO|Dareecho/);
	assert.ok(text.includes("[Measure") && text.includes("[Meter"), "the sample uses the Rainmeter section model");
	assert.equal(RAINMETER_BASE.license, "GPL-2.0");
});

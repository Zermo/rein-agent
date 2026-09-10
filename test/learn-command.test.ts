import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnIos } from "../src/learn/ios.ts";
import { runLearnCommand } from "../src/learn/command.ts";
import type { ProbeResult } from "../src/learn/profile.ts";

const ok = (stdout: string): ProbeResult => ({ ok: true, exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): ProbeResult => ({ ok: false, exitCode: 1, stdout: "", stderr });

const iphone = "DeviceName\t\tRain Phone\nDeviceClass\t\tiPhone\nProductVersion\t\t19.4\nBuildVersion\t\t23F77\nHardwareModel\t\tiPhone16,2\nProductType\t\tiPhone16,2\nUniqueDeviceID\t\t00008120-000A3C4E5678\n";

function runFor(list: ProbeResult, info: ProbeResult) {
	return async (command: string, args: string[]): Promise<ProbeResult> => {
		if (command === "idevice_id") return list;
		if (command === "ideviceinfo") return info;
		return fail(`${command} not expected`);
	};
}

test("iOS learn pass maps ideviceinfo output onto the iOS boot chain", async () => {
	const { learn } = await learnIos({ now: () => new Date("2026-01-01T00:00:00Z"), run: runFor(ok("00008120-000A3C4E5678"), ok(iphone)) });
	assert.equal(learn.kind, "ios");
	assert.equal(learn.machine.os, "ios");
	assert.equal(learn.machine.hostname, "Rain Phone");
	assert.equal(learn.machine.release, "19.4");
	assert.equal(learn.machine.model, "iPhone16,2");
	assert.deepEqual(learn.bootChain.map(s => s.stage), ["bootrom", "recovery", "low-level-bootloader", "kernel", "userland"]);
	assert.equal(learn.gates.find(g => g.id === "ios-tooling")?.status, "verified");
	assert.equal(learn.gates.find(g => g.id === "backup")?.status, "required");
});

test("iOS learn pass degrades when no device is attached", async () => {
	const { learn } = await learnIos({ now: () => new Date("2026-01-01T00:00:00Z"), run: runFor(ok(""), fail("no device found")) });
	assert.equal(learn.gates.find(g => g.id === "ios-tooling")?.status, "blocked");
	assert.ok(learn.notes.some(n => n.includes("No iOS device attached")));
});

test("iOS learning inspects only the explicitly selected device", async () => {
	const calls: Array<[string, string[]]> = [];
	await learnIos({ udid: "fixture-second", run: async (command, args) => {
		calls.push([command, args]);
		return command === "idevice_id" ? ok("fixture-first\nfixture-second\n") : ok(iphone);
	} });
	assert.deepEqual(calls, [["idevice_id", ["-l"]], ["ideviceinfo", ["-u", "fixture-second"]]]);
});

test("an unmatched explicit iOS device fails before probing another device or writing a dossier", async t => {
	const base = await mkdtemp(join(tmpdir(), "learn-wrong-device-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	for (const list of [ok("fixture-other\n"), ok(""), fail("enumeration unavailable")]) {
		const calls: Array<[string, string[]]> = [], logs: string[] = [];
		await assert.rejects(runLearnCommand(["ios"], { udid: "fixture-requested", output: join(base, "dossier") }, {
			run: async (command, args) => { calls.push([command, args]); return list; },
			log: text => logs.push(text),
		}), /--udid/);
		assert.deepEqual(calls, [["idevice_id", ["-l"]]]);
		assert.deepEqual(logs, []);
		assert.deepEqual(await readdir(base), []);
	}
});

test("rein learn ios writes a dossier directory and reports it", async () => {
	const base = await mkdtemp(join(tmpdir(), "learn-cmd-"));
	const logs: string[] = [];
	const code = await runLearnCommand(["ios"], { json: false, output: join(base, "iphone") }, {
		udid: "00008120-000A3C4E5678",
		now: () => new Date("2026-01-01T00:00:00Z"),
		run: runFor(ok("00008120-000A3C4E5678"), ok(iphone)),
		log: (text: string) => { logs.push(text); },
	});
	assert.equal(code, 0);
	const parsed = JSON.parse(await readFile(join(base, "iphone", "dossier.json"), "utf8"));
	assert.equal(parsed.machine.hostname, "Rain Phone");
	assert.equal(parsed.kind, "ios");
	assert.match(logs.join("\n"), /Dareecho learn/);
});

test("rein learn rejects an unknown target and an unknown flag", async () => {
	await assert.rejects(() => runLearnCommand(["android"], {}, { log: () => {} }), /Unknown learn target/);
	await assert.rejects(() => runLearnCommand(["host"], { verbose: true }, { log: () => {} }), /Unsupported learn option/);
});

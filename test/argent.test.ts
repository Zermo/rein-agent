import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTERNAL_PREFIX, PROVIDER_SCHEMA_VERSION, makeExternalId, nativeIdPlatform, validateProviderFile, readProviders } from "../src/argent/contract.ts";
import { encodePng, decodePng, diffImages, textToImage } from "../src/argent/png.ts";
import { parseFlow, validateFlow, replayFlow, FLOW_ACTIONS } from "../src/argent/flows.ts";
import type { Flow, FlowProvider } from "../src/argent/flows.ts";
import { TerminalProvider, providerStatus, providerDirectory } from "../src/argent/providers.ts";
import { argentReport, formatArgentReport, ARGENT_BASE } from "../src/argent/inventory.ts";

test("the provider contract keeps Argent's v1 rules: ext: ids, shapes, strict docs", () => {
	assert.equal(EXTERNAL_PREFIX, "ext:");
	assert.equal(PROVIDER_SCHEMA_VERSION, 1);
	assert.equal(makeExternalId("my-provider", "device-1"), "ext:my-provider:device-1");
	assert.throws(() => makeExternalId("My Provider", "x"), /lowercase slug/);
	assert.throws(() => makeExternalId("p", "bad id"), /argv-safe/);
	assert.equal(nativeIdPlatform("00008110-001E3C161E3A001E"), "ios");
	assert.equal(nativeIdPlatform("00008110-001E3C16AA3A001E"), "ios");
	assert.equal(nativeIdPlatform("emulator-5554"), "android");
	const good = { schemaVersion: 1, providerId: "fixture", devices: [{ id: "d1", platform: "ios", capabilities: ["tap", "type"], extra: true }] };
	const result = validateProviderFile(good);
	assert.equal(result.ok, true);
	if (result.ok) assert.deepEqual(result.file.devices, [{ id: "d1", platform: "ios", capabilities: ["tap", "type"] }]);
	assert.equal(validateProviderFile({ ...good, schemaVersion: 2 }).ok, false);
	assert.equal(validateProviderFile({ ...good, providerId: "Fixture" }).ok, false);
	assert.equal(validateProviderFile({ ...good, devices: "nope" }).ok, false);
	assert.equal(validateProviderFile({ ...good, devices: [{ id: "d", platform: "web", capabilities: [] }] }).ok, false);
	assert.equal(validateProviderFile({ ...good, devices: [{ id: "d", platform: "ios" }] }).ok, false);
});

test("readProviders degrades to empty on malformed or hostile files, never throws", async t => {
	const base = await mkdtemp(join(tmpdir(), "argent-providers-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const warnings: string[] = [];
	const report = (text: string) => warnings.push(text);
	assert.deepEqual(await readProviders(join(base, "missing"), report), []);
	assert.equal(warnings.length, 0);
	await writeFile(join(base, "good.json"), JSON.stringify({ schemaVersion: 1, providerId: "good", devices: [{ id: "d", platform: "tv", capabilities: [] }] }));
	await writeFile(join(base, "bad.json"), "{ not json");
	await writeFile(join(base, "stale.json"), JSON.stringify({ schemaVersion: 99, providerId: "stale", devices: [] }));
	await writeFile(join(base, "notes.txt"), "not a provider");
	await symlink(join(base, "bad.json"), join(base, "linked.json"), "file");
	const found = await readProviders(base, report);
	assert.equal(found.length, 1, "symlinked providers are not read");
	assert.equal(found[0].file.providerId, "good");
	assert.equal(warnings.length, 2, "one warning per ignored file");
});

test("PNG encode/decode round-trips every pixel", async t => {
	const base = await mkdtemp(join(tmpdir(), "argent-png-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const width = 5, height = 4;
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7) & 0xff;
	const image = { width, height, pixels };
	const buffer = encodePng(image);
	assert.deepEqual(decodePng(buffer), { width, height, pixels });
	assert.throws(() => decodePng(new Uint8Array([1, 2, 3])), /signature/);
	assert.throws(() => decodePng(buffer.subarray(0, buffer.length - 3)), /IEND|Truncated|signature/i);
	assert.throws(() => encodePng({ width: 0, height: 1, pixels: new Uint8Array(4) }), /dimensions/);
	assert.throws(() => encodePng({ width: 1, height: 1, pixels: new Uint8Array(3) }), /width\*height\*4/);
	const decoded = decodePng(buffer);
	assert.equal(decoded.pixels.length, width * height * 4);
});

test("decodePng reverses all five PNG filter types", () => {
	const width = 2, height = 2, stride = width * 4;
	const row0 = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
	const row1 = new Uint8Array([90, 100, 110, 120, 130, 140, 150, 160]);
	const expected = { width, height, pixels: new Uint8Array([...row0, ...row1]) };
	const paeth = (a: number, b: number, c: number) => {
		const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
		return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
	};
	const filterRow = (filter: number, row: Uint8Array, prev: Uint8Array) => {
		const out = new Uint8Array(stride);
		for (let i = 0; i < stride; i++) {
			const left = i >= 4 ? row[i - 4] : 0, up = prev[i], upLeft = i >= 4 ? prev[i - 4] : 0;
			const base = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
			out[i] = (row[i] - base) & 0xff;
		}
		return out;
	};
	for (const filter of [0, 1, 2, 3, 4]) {
		const rows = [filterRow(filter, row0, new Uint8Array(stride)), filterRow(filter, row1, row0)];
		const raw = new Uint8Array((stride + 1) * height);
		rows.forEach((row, y) => { raw[y * (stride + 1)] = filter; raw.set(row, y * (stride + 1) + 1); });
		assert.deepEqual(decodePng(buildPng(width, height, deflateSync(Buffer.from(raw)))), expected);
	}
});

import { deflateSync } from "node:zlib";
const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
const crc32 = (data: Buffer) => {
	let c = 0xffffffff;
	for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
function buildPng(width: number, height: number, idat: Buffer): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, tail]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

test("diffImages finds the exact differing region and respects the threshold", () => {
	const a = textToImage(["REIN OK", "line two", "line three"], { cellWidth: 8, cellHeight: 16 });
	const same = textToImage(["REIN OK", "line two", "line three"], { cellWidth: 8, cellHeight: 16 });
	const different = textToImage(["REIN OK", "linet wo", "line three"], { cellWidth: 8, cellHeight: 16 });
	const zero = diffImages(a, same, 0);
	assert.equal(zero.identical, true);
	assert.equal(zero.diffRatio, 0);
	const hit = diffImages(a, different, 12);
	assert.equal(hit.identical, false);
	assert.ok(hit.bbox);
	if (hit.bbox) {
		const [x1, y1, x2, y2] = hit.bbox;
		assert.equal(y1, 17, "diff starts at the second text row (1 px glyph inset)");
		assert.ok(x1 >= 32 && x2 < 48, "diff stays inside the moved cell range");
	}
	assert.ok(hit.samples.length > 0);
	assert.throws(() => diffImages(a, { width: a.width + 1, height: a.height, pixels: new Uint8Array((a.width + 1) * a.height * 4) }), /differ in size/);
	assert.throws(() => diffImages(a, same, 256), /Threshold/);
	// Threshold 0 with identical images still passes.
	assert.equal(diffImages(a, same, 0).identical, true);
});

test("flows parse strictly and replay against providers with skip-not-fail semantics", async () => {
	const flow = parseFlow(JSON.stringify({
		name: "fixture-flow",
		provider: "terminal",
		steps: [
			{ action: "type", text: "hello" },
			{ action: "key", text: "Enter" },
			{ action: "wait", delayMs: 5 },
			{ action: "screenshot" },
			{ action: "assert", text: "hello" },
			{ action: "tap", x: 1, y: 2 },
		],
	}), "flow.json");
	assert.equal(validateFlow(flow).length, 0);
	assert.equal(flow.steps.length, 6);
	assert.throws(() => parseFlow("not json", "f"), /not valid JSON/);
	assert.throws(() => parseFlow(JSON.stringify({ name: "bad name", provider: "terminal", steps: [{ action: "wait", delayMs: 1 }] }), "f"), /name must match/);
	assert.throws(() => parseFlow(JSON.stringify({ name: "f", provider: "terminal", steps: [] }), "f"), /nonempty/);
	assert.throws(() => parseFlow(JSON.stringify({ name: "f", provider: "terminal", steps: [{ action: "type", text: "x", mystery: 1 }] }), "f"), /unknown field/);
	assert.throws(() => parseFlow(JSON.stringify({ name: "f", provider: "terminal", steps: [{ action: "hover" }] }), "f"), /action must be one of/);
	assert.throws(() => parseFlow(JSON.stringify({ name: "f", provider: "terminal", steps: [{ action: "type" }] }), "f"), /needs text/);
	assert.throws(() => parseFlow(JSON.stringify({ name: "f", provider: "terminal", steps: [{ action: "tap", x: 1 }] }), "f"), /needs x and y/);
	assert.throws(() => parseFlow(JSON.stringify({ name: "f", provider: "terminal", steps: [{ action: "wait" }] }), "f"), /delayMs/);
	const calls: string[] = [];
	const provider: FlowProvider = {
		id: "fixture", platform: "terminal",
		capabilities: ["type", "key", "screenshot", "capture-text"],
		tap: async () => { calls.push("tap"); },
		swipe: async () => { calls.push("swipe"); },
		type: async text => { calls.push("type:" + text); },
		key: async name => { calls.push("key:" + name); },
		screenshot: async () => { calls.push("screenshot"); },
		captureText: async () => "hello world",
		wait: async () => { calls.push("wait"); },
	};
	const report = await replayFlow(flow, provider);
	assert.equal(report.ok, true);
	assert.equal(report.passed, 5);
	assert.equal(report.skipped, 1, "tap has no pointer surface on a terminal provider");
	assert.deepEqual(calls, ["type:hello", "key:Enter", "wait", "screenshot"]);
	const noText = { ...provider, captureText: undefined, capabilities: ["type", "key"] as string[] };
	const flow2 = parseFlow(JSON.stringify({ name: "f2", provider: "fixture", steps: [{ action: "assert", text: "hello" }] }), "f2");
	const report2 = await replayFlow(flow2, noText as FlowProvider);
	assert.equal(report2.ok, true, "a skipped step does not fail the flow");
	assert.equal(report2.skipped, 1);
	assert.match(report2.steps[0].reason ?? "", /no text surface/);
});

test("a failing or erroring step marks the flow NOT OK without aborting later steps", async () => {
	const provider: FlowProvider = {
		id: "fixture", platform: "terminal",
		capabilities: ["type", "assert"],
		tap: async () => { throw new Error("no pointer"); },
		swipe: async () => { throw new Error("no pointer"); },
		type: async () => { throw new Error("input failed"); },
		key: async () => {},
		screenshot: async () => {},
		captureText: async () => "hello",
		wait: async () => {},
	};
	const flow = parseFlow(JSON.stringify({ name: "f", provider: "fixture", steps: [
		{ action: "type", text: "x" },
		{ action: "assert", text: "hello" },
		{ action: "tap", x: 0, y: 0 },
		{ action: "assert", text: "missing" },
	] }), "f");
	const report = await replayFlow(flow, provider);
	assert.equal(report.ok, false);
	assert.equal(report.passed, 1);
	assert.equal(report.failed, 1);
	assert.equal(report.errored, 1);
	assert.equal(report.skipped, 1);
	assert.equal(report.steps.length, 4);
});

test("the terminal provider drives an injected tmux-like shell surface", async () => {
	const sent: { text: string; enter: boolean }[] = [];
	const captured = "hello-argent\nok";
	const shells = {
		list: async () => [{ id: "rein-abc" }],
		start: async () => "rein-abc",
		send: async (_id: string, text: string, enter: boolean) => { sent.push({ text, enter }); },
		sendKey: async (_id: string, key: string) => { sent.push({ text: key, enter: false }); },
		capture: async () => captured,
		stop: async () => {},
	} as any;
	const provider = new TerminalProvider(shells, { settleMs: 1 });
	await provider.open();
	assert.match(provider.id, /^terminal:rein-abc/);
	assert.deepEqual(provider.capabilities, ["type", "key", "screenshot", "capture-text"]);
	await provider.type("echo hi");
	await provider.key("Enter");
	await provider.wait(1);
	const shot = await provider.screenshot();
	assert.equal(shot.width > 0 && shot.height > 0, true);
	assert.equal(captured.includes("hello-argent"), true);
	assert.deepEqual(sent, [{ text: "echo hi", enter: false }, { text: "Enter", enter: false }]);
	await assert.rejects(provider.tap(1, 2), /no pointer/);
	await assert.rejects(provider.swipe(1, 2, 3, 4), /no pointer/);
	// A flow replaying on this provider skips pointer steps instead of failing.
	const flow: Flow = { name: "t", provider: "terminal", steps: [{ action: "type", text: "x" }, { action: "tap", x: 1, y: 1 }, { action: "assert", text: "hello" }] };
	const report = await replayFlow(flow, provider);
	assert.equal(report.ok, true);
	assert.equal(report.skipped, 1);
	await provider.stop();
});

test("the rebuild report pins the upstream and states the parity gates", () => {
	const report = argentReport();
	assert.equal(report.schemaVersion, 1);
	assert.equal(report.base.repository, "https://github.com/software-mansion/argent.git");
	assert.match(report.base.commit, /^[0-9a-f]{40}$/);
	assert.equal(report.base.license, "Apache-2.0");
	assert.equal(report.base.package, "@swmansion/argent");
	assert.ok(report.components.length >= 8);
	for (const component of report.components) {
		assert.ok(["implemented", "mapped", "gate"].includes(component.status), "status vocabulary");
		assert.ok(component.upstream.length && component.role.length && component.rebuild.length, "every component documents role and rebuild path");
	}
	const statuses = report.components.map(component => component.status);
	assert.ok(statuses.includes("implemented"), "the rebuilt core is implemented");
	assert.ok(statuses.includes("gate"), "device targets are gates");
	const text = formatArgentReport(report);
	assert.match(text, /software-mansion\/argent\.git/);
	assert.match(text, /Apache-2\.0/);
	assert.match(text, /terminal/);
});

test("provider status reports the built-in terminal provider honestly", async () => {
	const status = await providerStatus();
	assert.equal(status.builtin.id, "terminal");
	assert.equal(typeof status.builtin.ready, "boolean");
	assert.ok(status.external.length === 0 || status.external.every(entry => typeof entry.path === "string" && typeof entry.devices === "number"));
	assert.match(providerDirectory(), /argent\/providers$/);
	assert.equal(ARGENT_BASE.version, "0.24.0");
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkin, measureOption } from "../src/os/skin/parser.ts";
import { evaluateCalc, measureDue, computeMeasure } from "../src/os/skin/measures.ts";
import { renderMeter } from "../src/os/skin/meters.ts";
import { createEngine, renderSkinFile, resolveSkinPath } from "../src/os/skin/engine.ts";
import { installSkin, listSkins } from "../src/os/skin/install.ts";
const BASE = "[Rainmeter]\nUpdate=1000\n\n";

function ctx(now: number, started = now - 3600_000, tick = 0, values: Map<string, string> = new Map()) {
	return { now: () => now, started, tick, values };
}

test("the parser builds the Rainmeter skin model: variables, styles, metadata", () => {
	const skin = parseSkin(BASE + [
		"[Variables]",
		"width=40",
		"tint=#b54229",
		"",
		"[Metadata]",
		"Name=Fixture",
		"",
		"[MeasureOne]",
		"Measure=String",
		"Text=hello",
		"",
		"[MeterStyle]",
		"W=#width#",
		"FontColor=#tint#",
		"",
		"[MeterOne]",
		"Meter=String",
		"MeterStyle=MeterStyle",
		"Text=[MeasureOne]",
	].join("\n"));
	assert.equal(skin.updateMs, 1000);
	assert.equal(skin.metadata.Name, "Fixture");
	assert.equal(skin.variables.width, "40");
	assert.equal(skin.measures[0].name, "MeasureOne");
	assert.equal(measureOption(skin.measures[0], "text"), "hello");
	assert.equal(skin.meters[0].options.W, "40");
	assert.equal(skin.meters[0].options.FontColor, "#b54229");
	assert.equal(skin.meters[0].options.Text, "[MeasureOne]");
});

test("the parser rejects malformed skins instead of guessing", () => {
	const base = BASE + "[MeasureA]\nMeasure=String\nText=x\n";
	const meter = "[MeterA]\nMeter=String\nText=[MeasureA]\n";
	assert.throws(() => parseSkin(base + meter + "\n[Unknown]\nfoo=bar\n"), /not a Rainmeter section/);
	assert.throws(() => parseSkin(base + meter + "\n[MeasureB]\nMeasure=String\nText=#nope#\n"), /#nope#/);
	assert.throws(() => parseSkin(base + "\n[MeasureA]\nMeasure=String\nText=y\n" + meter), /duplicate measure/);
	assert.throws(() => parseSkin(BASE + "[MeterA]\n"), /needs a Meter type/);
	assert.throws(() => parseSkin(BASE + "[MeterA]\nMeter=String\nMeterStyle=Ghost\n"), /unknown MeterStyle/);
	assert.throws(() => parseSkin(BASE + "[Rainmeter]\nUpdate=5\n[MeterA]\nMeter=String\n"), /Update must be 50-30000/);
	assert.throws(() => parseSkin(BASE + "[Rainmeter]\nSolidColor=1\n[MeterA]\nMeter=String\n"), /desktop option/);
	assert.throws(() => parseSkin(BASE), /no \[Meter\*\] sections/);
	assert.throws(() => parseSkin(BASE + "[MeasureA]\nMeasure=String\nText=x\nline without equals"), /expected key=value/);
});

test("Calc evaluates with operator precedence, parentheses, and references", () => {
	const values = new Map([["a", "2"], ["b", "10"]]);
	assert.equal(evaluateCalc("2 + 3 * 4", values, "t"), 14);
	assert.equal(evaluateCalc("(2 + 3) * 4", values, "t"), 20);
	assert.equal(evaluateCalc("[a] * [b]", values, "t"), 20);
	assert.equal(evaluateCalc("[a] / [b]", values, "t"), 0.2);
	assert.throws(() => evaluateCalc("[a] / 0", values, "t"), /division by zero/);
	assert.throws(() => evaluateCalc("2 ** 3", values, "t"), /Calc formula/);
	assert.throws(() => evaluateCalc("(2 + 3", values, "t"), /unbalanced/);
	assert.throws(() => evaluateCalc("2 +", values, "t"), /malformed/);
	assert.throws(() => evaluateCalc("abc", values, "t"), /found: a/);
	assert.throws(() => evaluateCalc("[a] + 1", new Map([["a", "text"]]), "t"), /not numeric/);
	assert.throws(() => evaluateCalc("", values, "t"), /empty/);
});

test("measures compute Rainmeter semantics: Time, Uptime, Loop, Calc, SysInfo", () => {
	const now = new Date(2026, 8, 8, 14, 5, 9).getTime();
	const timeDef = { name: "t", type: "Time", options: { Format: "%H:%M:%S" } };
	assert.equal(computeMeasure(timeDef, ctx(now)), "14:05:09");
	const dayDef = { name: "d", type: "Time", options: { Format: "%A, %d %B %Y" } };
	assert.equal(computeMeasure(dayDef, ctx(now)), "Tuesday, 08 September 2026");
	assert.equal(computeMeasure({ name: "u", type: "Uptime", options: {} }, ctx(now, now - 3661_000)), "01:01:01");
	assert.equal(computeMeasure({ name: "u", type: "Uptime", options: { Format: "%T" } }, ctx(now, now - 7_000)), "7");
	const loop = { name: "l", type: "Loop", options: { Start: "0", End: "8", Step: "2" } };
	assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(tick => computeMeasure(loop, ctx(now, now - 1000, tick))), ["0", "2", "4", "6", "8", "0", "2", "4", "6", "8"]);
	const down = { name: "d", type: "Loop", options: { Start: "8", End: "0", Step: "2" } };
	assert.deepEqual([0, 1, 2, 3, 4].map(tick => computeMeasure(down, ctx(now, now - 1000, tick))), ["8", "6", "4", "2", "0"]);
	const ragged = { name: "r", type: "Loop", options: { Start: "0", End: "9", Step: "2" } };
	assert.deepEqual([0, 1, 2, 3, 4, 5].map(tick => computeMeasure(ragged, ctx(now, now - 1000, tick))), ["0", "2", "4", "6", "8", "0"]);
	const values = new Map([["l", "8"]]);
	assert.equal(evaluateCalc("[l] / 2 - 4", values, "[c]"), 0);
	assert.equal(computeMeasure({ name: "s", type: "SysInfo", options: { Property: "cores" } }, ctx(now)), String(cpus().length));
	assert.throws(() => computeMeasure({ name: "s", type: "SysInfo", options: { Property: "gpu" } }, ctx(now)), /Property must be/);
	assert.throws(() => computeMeasure({ name: "x", type: "WebParser", options: {} }, ctx(now)), /not part of this rebuild/);
});

test("UpdateDivider throttles recomputes exactly like Rainmeter", () => {
	const def = { name: "slow", type: "String", options: { Text: "x", UpdateDivider: "3" } };
	assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(tick => measureDue(def, tick)), [true, false, false, true, false, false, true]);
	assert.throws(() => measureDue({ name: "bad", type: "String", options: { UpdateDivider: "0" } }, 0), /whole number/);
});

test("meters render String, Bar, Gauge, Line, and honor IfCondition", () => {
	const values = new Map([["num", "42"], ["level", "70"]]);
	const render = (def: Record<string, string>) => renderMeter({ name: "M", type: def.Meter, options: def }, { values, history: new Map(), width: 24, color: false });
	assert.equal(render({ Meter: "String", MeasureName: "num" }), "42".padEnd(24));
	assert.equal(render({ Meter: "String", Text: "UP [num]s" }), "UP 42s".padEnd(24));
	const bar = render({ Meter: "Bar", MeasureName: "level", W: "10" });
	assert.equal(bar, "███████░░░ 70%");
	const gauge = render({ Meter: "Gauge", MeasureName: "level", W: "10" });
	assert.equal(gauge, "GAUGE  [▂▃▄▅▆▇█···] 70");
	const line = renderMeter({ name: "M", type: "Line", options: { MeasureName: "num", W: "5" } }, { values, history: new Map([["num", [10, 42]]]), width: 24, color: false });
	assert.match(line, /^NUM\s+[▁▂▃▄▅▆▇█]{1,5} 10→42$/);
	assert.throws(() => render({ Meter: "Bar", MeasureName: "ghost", W: "10" }), /not produced a value/);
	const hidden = { name: "H", type: "String", options: { MeasureName: "level", IfMeasureName: "level", IfCondition: "<60" } };
	assert.equal(renderMeter(hidden, { values, history: new Map(), width: 24, color: false }), " ".repeat(24));
	const shown = { name: "S", type: "String", options: { MeasureName: "level", IfMeasureName: "level", IfCondition: ">=60" } };
	assert.equal(renderMeter(shown, { values, history: new Map(), width: 24, color: false }).trim(), "70");
	assert.throws(() => renderMeter({ name: "B", type: "String", options: { IfMeasureName: "level", IfCondition: "~=60" } }, { values, history: new Map(), width: 24, color: false }), /IfCondition supports/);
});

test("colors are ANSI only when requested", () => {
	const values = new Map([["num", "42"]]);
	const base = { values, history: new Map(), width: 24 };
	const colored = renderMeter({ name: "C", type: "String", options: { MeasureName: "num", FontColor: "#b54229" } }, { ...base, color: true });
	assert.match(colored, /\x1b\[38;2;181;66;41m42\s*\x1b\[0m/);
	assert.equal(renderMeter({ name: "C", type: "String", options: { MeasureName: "num", FontColor: "#b54229" } }, { ...base, color: false }), "42".padEnd(24));
});

test("the engine ticks measures and renders a complete frame", () => {
	const skin = parseSkin(BASE + [
		"[MeasureClock]",
		"Measure=Time",
		"Format=%H:%M",
		"",
		"[MeasureLoop]",
		"Measure=Loop",
		"Start=0",
		"End=9",
		"Step=3",
		"",
		"[MeterClock]",
		"Meter=String",
		"MeasureName=MeasureClock",
		"",
		"[MeterLoop]",
		"Meter=Gauge",
		"MeasureName=MeasureLoop",
		"W=10",
	].join("\n"));
	const now = new Date(2026, 8, 8, 9, 30).getTime();
	const engine = createEngine(skin, { width: 32, now: () => now });
	const first = engine.frame();
	assert.match(first, /DAREECHO SKIN/);
	assert.match(first, /09:30/);
	assert.match(first, /--frames animates this skin/);
	engine.tick();
	const second = engine.frame();
	assert.match(second, / 3/);
});

test("renderSkinFile resolves skin directories and renders the shipped sample", async t => {
	const base = await mkdtemp(join(tmpdir(), "rein-skin-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const skinDir = join(base, "my-skin");
	await mkdir(skinDir);
	await writeFile(join(skinDir, "a.ini"), BASE + "[MeterA]\nMeter=String\nText=hello-skin\n");
	await writeFile(join(skinDir, "b.ini"), BASE + "[MeterB]\nMeter=String\nText=other\n");
	await assert.rejects(resolveSkinPath(skinDir), /Multiple skins/);
	await rm(join(skinDir, "b.ini"));
	await writeFile(join(skinDir, "my-skin.ini"), BASE + "[MeterC]\nMeter=String\nText=hello-skin\n");
	const rendered = await renderSkinFile(skinDir);
	assert.match(rendered, /hello-skin/);
	const sample = new URL("../src/os/assets/skins/dareecho.ini", import.meta.url).pathname;
	const frame = await renderSkinFile(sample);
	assert.match(frame, /DAREECHO SKIN \/ Dareecho/);
	assert.match(frame, /D A R E E C H O/);
});

test("install stages a skin directory and never overwrites an existing one", async t => {
	const base = await mkdtemp(join(tmpdir(), "rein-skin-install-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const source = join(base, "demo-skin");
	await mkdir(join(source, "fonts"), { recursive: true });
	await writeFile(join(source, "demo.ini"), BASE + "[Metadata]\nName=Demo\n[MeterA]\nMeter=String\nText=demo\n");
	await writeFile(join(source, "fonts", "note.txt"), "resource");
	await writeFile(join(source, "README.md"), "docs");
	const target = join(base, "skins");
	const result = await installSkin({ source, target });
	assert.equal(result.target, join(target, "demo-skin"));
	assert.deepEqual(result.files.sort(), ["demo-skin/README.md", "demo-skin/demo.ini", "demo-skin/fonts/note.txt"]);
	await assert.rejects(installSkin({ source, target }), /already installed/);
	await assert.rejects(installSkin({ source: join(base, "missing"), target }), /does not exist/);
	const listed = await listSkins(target);
	assert.equal(listed.length, 1);
	assert.equal(listed[0].name, "demo-skin");
	assert.equal(listed[0].title, "Demo");
	assert.deepEqual(await listSkins(join(base, "nowhere")), []);
});

test("symlinks are not staged into a skin directory", async t => {
	const base = await mkdtemp(join(tmpdir(), "rein-skin-sym-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const outside = join(base, "outside");
	await mkdir(outside);
	await writeFile(join(outside, "secret.ini"), "outside");
	const source = join(base, "link-skin");
	await mkdir(source);
	await symlink(join(outside, "secret.ini"), join(source, "linked.ini"), "file");
	await assert.rejects(installSkin({ source, target: join(base, "skins") }), /Symlinks are not staged/);
});

test("the shipped sample skin parses cleanly with its variables and styles", async () => {
	const path = new URL("../src/os/assets/skins/dareecho.ini", import.meta.url).pathname;
	const skin = parseSkin(await readFile(path, "utf8"), path);
	assert.equal(skin.metadata.Name, "Dareecho");
	assert.ok(skin.measures.length >= 4, "sample skin has several measures");
	assert.ok(skin.meters.length >= 4, "sample skin has several meters");
	for (const meter of skin.meters) if (meter.options.MeterStyle) assert.ok(skin.styles[meter.options.MeterStyle.toLowerCase()], "every referenced style exists");
});

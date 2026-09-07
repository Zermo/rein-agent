import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExportCommand } from "../src/export/command.ts";

test("rein export <path> --to copies and reports the target", async () => {
	const base = await mkdtemp(join(tmpdir(), "export-cmd-"));
	const src = join(base, "diary.txt");
	await writeFile(src, "my words");
	const target = join(base, "safe");
	const logs: string[] = [];
	const code = await runExportCommand([src], { to: target }, {
		log: t => logs.push(t),
	});
	assert.equal(code, 0);
	assert.equal(await readFile(join(target, "diary.txt"), "utf8"), "my words");
	assert.equal(await readFile(src, "utf8"), "my words", "source survives");
	assert.match(logs.join("\n"), /never deletes/);
});

test("rein export without a target refuses instead of guessing", async () => {
	const base = await mkdtemp(join(tmpdir(), "export-cmd-"));
	const src = join(base, "x.txt");
	await writeFile(src, "x");
	await assert.rejects(() => runExportCommand(["x.txt"], {}, { log: () => {} }), /--to/);
});

test("rein export browse needs an interactive terminal unless injected", async () => {
	await assert.rejects(
		() => runExportCommand(["browse"], {}, { tty: false, log: () => {} }),
		/interactive terminal/,
	);
	const code = await runExportCommand(["browse"], {}, { tty: false, log: () => {}, browse: async () => 0 });
	assert.equal(code, 0, "an injected browser (or TTY) is the escape hatch");
});

test("rein export presets --list shows what exists in the home", async () => {
	const home = await mkdtemp(join(tmpdir(), "export-cmd-home-"));
	await mkdir(join(home, "Documents"), { recursive: true });
	const logs: string[] = [];
	const code = await runExportCommand(["presets"], { list: true }, { home: () => home, platform: "darwin", log: t => logs.push(t) });
	assert.equal(code, 0);
	assert.match(logs.join("\n"), /documents/);
	assert.match(logs.join("\n"), /not present, skipped/);
});

test("rein export presets copies the present groups into a new directory", async () => {
	const home = await mkdtemp(join(tmpdir(), "export-cmd-home-"));
	await mkdir(join(home, "Documents", "work"), { recursive: true });
	await writeFile(join(home, "Documents", "work", "memo.md"), "memo");
	const target = join(home, "Dareecho-Export-2026-01-01");
	const logs: string[] = [];
	const code = await runExportCommand(["presets"], { to: target }, { home: () => home, platform: "darwin", log: t => logs.push(t) });
	assert.equal(code, 0);
	assert.equal(await readFile(join(target, "Documents", "work", "memo.md"), "utf8"), "memo");
	assert.ok((await readdir(join(home, "Documents", "work"))).length === 1, "source tree untouched");
});

test("on ChromeOS, presets follow the chronos home and report the chrome profile group", async () => {
	const home = await mkdtemp(join(tmpdir(), "export-cmd-cros-"));
	await mkdir(join(home, "Downloads"), { recursive: true });
	await mkdir(join(home, ".config", "chromium"), { recursive: true });
	await writeFile(join(home, "Downloads", "app.html"), "<html>");
	const target = join(home, "Dareecho-Export-2026-01-01");
	const logs: string[] = [];
	const code = await runExportCommand(["presets"], { to: target }, {
		home: () => home,
		platform: "linux",
		osRelease: async () => "NAME=Chrome OS\nID=chromeos\nCROS_RELEASE=132.0.6834.0\n",
		chromeosHome: home,
		log: t => logs.push(t),
	});
	assert.equal(code, 0);
	assert.equal(await readFile(join(target, "Downloads", "app.html"), "utf8"), "<html>");
	assert.match(logs.join("\n"), /never deletes/);
});

test("ChromeOS detection re-homes the presets to the chronos user directory", async () => {
	const chronos = await mkdtemp(join(tmpdir(), "chronos-"));
	await mkdir(join(chronos, "Documents"), { recursive: true });
	await writeFile(join(chronos, "Documents", "memo.md"), "memo");
	const logs: string[] = [];
	const code = await runExportCommand(["presets"], { list: true }, {
		home: () => "/Users/nobody",
		platform: "linux",
		osRelease: async () => "NAME=Chrome OS\nID=chromeos\n",
		chromeosHome: chronos,
		log: t => logs.push(t),
	});
	assert.equal(code, 0);
	assert.match(logs.join("\n"), /documents: .*Documents/);
});

test("unknown export options are refused", async () => {
	await assert.rejects(
		() => runExportCommand(["browse"], { force: true }, { log: () => {} }),
		/Unsupported export option --force/,
	);
});

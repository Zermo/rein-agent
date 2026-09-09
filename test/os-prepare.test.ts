import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OS_THEME_FILES, OS_SKIN_FILES, prepareReinOS } from "../src/os/prepare.ts";
const exec = promisify(execFile);

async function fixture(t: any) {
	const base = await mkdtemp(join(tmpdir(), "rein-os-kit-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "source");
	await mkdir(join(root, "dist"), { recursive: true });
	await mkdir(join(root, "vendor/meat"), { recursive: true });
	await mkdir(join(root, "src/os/assets/rain"), { recursive: true });
	await mkdir(join(root, "src/os/assets/skins"), { recursive: true });
	await mkdir(join(root, "apps/klaud"), { recursive: true });
	for (const path of OS_THEME_FILES) await writeFile(join(root, path), await readFile(new URL(`../${path}`, import.meta.url)));
	for (const path of OS_SKIN_FILES) await writeFile(join(root, path), await readFile(new URL(`../${path}`, import.meta.url)));
	await writeFile(join(root, "apps/klaud/main.mjs"), "// fixture klaudbot app entry\n");
	await writeFile(join(root, "apps/klaud/index.html"), "<html>fixture</html>\n");
	await writeFile(join(root, "apps/klaud/package.json"), JSON.stringify({ name: "@rein/klaud", main: "main.mjs" }));
	await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3", secret: "must-not-export" }));
	await writeFile(join(root, "dist/rein.js"), 'console.log("fixture-rein", process.argv.slice(2).join("|"));\n');
	await writeFile(join(root, "dist/meat-worker.js"), "// fixture worker\n");
	await writeFile(join(root, "vendor/meat/meat.wasm.gz"), "fixture-bytes");
	await writeFile(join(root, "vendor/meat/wasm_exec.cjs"), "// fixture runtime\n");
	await writeFile(join(root, "LICENSE"), "Fixture license\n");
	await writeFile(join(root, "private-config.json"), "must-not-export");
	return { base, root, output: join(base, "kit") };
}

test("export produces an offline verifiable overlay, not a bootable image", async t => {
	const f = await fixture(t);
	const result = await prepareReinOS({ output: f.output, bundleRoot: f.root });
	assert.equal(result.manifest.bootable, false);
	assert.equal(result.manifest.reinVersion, "1.2.3");
	assert.equal(result.manifest.omarchy.commit, "346e69e1cec6c4e8924531874af6ba010a1bc99e");
	assert.equal(result.manifest.rainmeter.license, "GPL-2.0");
	assert.match(result.manifest.rainmeter.commit, /^[0-9a-f]{40}$/);
	const app = result.manifest.files.find(entry => entry.path === "apps/klaud/main.mjs");
	assert.ok(app && /^[a-f0-9]{64}$/.test(app.sha256), "the klaudbot app entry ships in the kit payload");
	assert.ok(result.files.includes("install-overlay.mjs"));
	assert.ok(result.files.includes("fetch-upstream.mjs"));
	assert.doesNotMatch(await readFile(join(f.output, "payload/package.json"), "utf8"), /secret|must-not-export/);
	await assert.rejects(access(join(f.output, "payload/private-config.json")));
	const verified = await exec(process.execPath, [join(f.output, "install-overlay.mjs"), "--verify"]);
	assert.match(verified.stdout, /REIN_OS_PAYLOAD_OK/);
	await exec(process.execPath, ["--check", join(f.output, "fetch-upstream.mjs")]);
	const readme = await readFile(join(f.output, "README.md"), "utf8");
	assert.match(readme, /```sh/);
	assert.match(readme, /not a bootable image/);
	assert.match(readme, /rein os rain --animate/);
	assert.match(readme, /never selects a wallpaper/);
	assert.match(readme, /The full Rein system/);
	assert.match(readme, /rein-kla\u028ad/);
	assert.match(readme, /rein serve/);
	assert.match(readme, /bot mode/);
});

test("existing outputs and payload symlinks are never overwritten or followed", async t => {
	const f = await fixture(t);
	await mkdir(f.output);
	await writeFile(join(f.output, "keep"), "original");
	await assert.rejects(prepareReinOS({ output: f.output, bundleRoot: f.root }), /already exists/);
	assert.equal(await readFile(join(f.output, "keep"), "utf8"), "original");
	const link = join(f.base, "linked-output");
	await symlink(f.output, link, "dir");
	await assert.rejects(prepareReinOS({ output: link, bundleRoot: f.root }), /already exists/);
	await rm(join(f.root, "vendor/meat/wasm_exec.cjs"));
	await symlink(join(f.root, "LICENSE"), join(f.root, "vendor/meat/wasm_exec.cjs"));
	await assert.rejects(prepareReinOS({ output: join(f.base, "new-kit"), bundleRoot: f.root }), /regular payload files/);
	await assert.rejects(access(join(f.base, "new-kit")));
});

test("missing bundle and invalid arguments leave no partial output", async t => {
	const f = await fixture(t);
	for (const output of ["", "\n", "broken\0path"]) await assert.rejects(prepareReinOS({ output, bundleRoot: f.root }), /nonempty filesystem path/);
	await assert.rejects(prepareReinOS(null as any), /output directory/);
	await rm(join(f.root, "dist/rein.js"));
	await assert.rejects(prepareReinOS({ output: f.output, bundleRoot: f.root }), /ENOENT/);
	await assert.rejects(access(f.output));
});

test("shell punctuation and spaces remain literal filesystem paths", async t => {
	const f = await fixture(t);
	const output = join(f.base, "a kit; $(touch OWNED) 'quoted'");
	await prepareReinOS({ output, bundleRoot: f.root });
	assert.match((await exec(process.execPath, [join(output, "install-overlay.mjs"), "--verify"], { cwd: f.base })).stdout, /REIN_OS_PAYLOAD_OK/);
	await assert.rejects(access(join(f.base, "OWNED")));
});

test("generated verifier rejects modified payload, path traversal, and symlink roots", async t => {
	const f = await fixture(t);
	await prepareReinOS({ output: f.output, bundleRoot: f.root });
	const install = join(f.output, "install-overlay.mjs");
	const entry = join(f.output, "payload/dist/rein.js");
	await writeFile(entry, "changed");
	await assert.rejects(exec(process.execPath, [install, "--verify"]), /Payload size\/type mismatch/);
	await writeFile(entry, await readFile(join(f.root, "dist/rein.js")));
	const manifestPath = join(f.output, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	manifest.files[0].path = "../../private-config.json";
	await writeFile(manifestPath, JSON.stringify(manifest));
	await assert.rejects(exec(process.execPath, [install, "--verify"]), /Invalid payload manifest entry/);
	const other = join(f.base, "other-kit");
	await prepareReinOS({ output: other, bundleRoot: f.root });
	await rm(join(other, "payload"), { recursive: true });
	await symlink(join(f.output, "payload"), join(other, "payload"), "dir");
	await assert.rejects(exec(process.execPath, [join(other, "install-overlay.mjs"), "--verify"]), /regular directory/);
});

test("bootstrap target checks reject unsupported architecture and base versions", async t => {
	const f = await fixture(t);
	await prepareReinOS({ output: f.output, bundleRoot: f.root });
	const { validateTarget } = await import(pathToFileURL(join(f.output, "install-overlay.mjs")).href);
	assert.doesNotThrow(() => validateTarget("linux", "x64", "4.0.2\n"));
	assert.throws(() => validateTarget("linux", "arm64", "4.0.2"), /x86-64 Linux/);
	assert.throws(() => validateTarget("darwin", "x64", "4.0.2"), /x86-64 Linux/);
	assert.throws(() => validateTarget("linux", "x64", "4.0.3"), /4.0.2/);
});

test("bootstrap installs only fixture user files, starts a valid launcher, and preserves config", async t => {
	const f = await fixture(t);
	await prepareReinOS({ output: f.output, bundleRoot: f.root });
	const user = join(f.base, "user with $ and 'quotes'");
	await mkdir(join(user, ".local/share/omarchy"), { recursive: true });
	await mkdir(join(user, ".rein"));
	await writeFile(join(user, ".local/share/omarchy/version"), "4.0.2\n");
	await writeFile(join(user, ".rein/config.json"), "preserve-me");
	await mkdir(join(user, ".config/omarchy/themes/existing"), { recursive: true });
	await writeFile(join(user, ".config/omarchy/themes/existing/theme.json"), "existing-desktop-theme");
	const runner = join(f.base, "fixture-runner.mjs");
	// Synthetic platform applies only in this test process. The shipped installer has no override flag.
	await writeFile(runner, `Object.defineProperty(process,'platform',{value:'linux'}); Object.defineProperty(process,'arch',{value:'x64'}); process.getuid=()=>1000; const {main}=await import(${JSON.stringify(pathToFileURL(join(f.output, "install-overlay.mjs")).href)}); await main(process.argv.slice(2));`);
	const env = { ...process.env, HOME: user, USERPROFILE: user };
	assert.match((await exec(process.execPath, [runner, "--check"], { env })).stdout, /REIN_OS_TARGET_READY/);
	assert.match((await exec(process.execPath, [runner, "--install"], { env })).stdout, /REIN_OS_OVERLAY_INSTALLED/);
	const launcher = join(user, ".local/bin/rein");
	assert.match((await exec(process.execPath, [launcher, "--version"], { env })).stdout, /fixture-rein --version/);
	const identity = join(user, ".local/bin/dareecho");
	assert.match((await exec(process.execPath, [identity], { env })).stdout, /Dareecho 1\.2\.3 \(base: Omarchy 4\.0\.2\)/);
	const release = JSON.parse(await readFile(join(user, ".local/share/rein-os/dareecho-release"), "utf8"));
	assert.equal(release.name, "Dareecho");
	assert.equal(release.version, "1.2.3");
	assert.equal(release.base.name, "Omarchy");
	assert.equal(release.base.installed, "4.0.2");
	assert.equal(release.pins.omarchy.commit, "346e69e1cec6c4e8924531874af6ba010a1bc99e");
	assert.equal(release.pins.argent.license, "Apache-2.0");
	assert.equal(release.pins.rainmeter.license, "GPL-2.0");
	assert.equal(await readFile(join(user, ".rein/config.json"), "utf8"), "preserve-me");
	assert.equal(await readFile(join(user, ".config/omarchy/themes/existing/theme.json"), "utf8"), "existing-desktop-theme");
	for (const path of OS_THEME_FILES) assert.deepEqual(await readFile(join(user, ".local/share/rein-os", path)), await readFile(join(f.root, path)));
	assert.deepEqual(await readFile(join(user, ".local/share/rein-os/apps/klaud/main.mjs"), "utf8"), "// fixture klaudbot app entry\n");
	await assert.rejects(exec(process.execPath, [runner, "--install"], { env }), /already exists/);
	assert.deepEqual(await readFile(join(user, ".local/share/rein-os/dareecho-release"), "utf8"), JSON.stringify(release, null, 2) + "\n");
});

test("an existing Dareecho identity is preserved, never rewritten", async t => {
	const f = await fixture(t);
	await prepareReinOS({ output: f.output, bundleRoot: f.root });
	const user = join(f.base, "user");
	await mkdir(join(user, ".local/share/omarchy"), { recursive: true });
	await mkdir(join(user, ".local/bin"), { recursive: true });
	await writeFile(join(user, ".local/share/omarchy/version"), "4.0.2\n");
	await writeFile(join(user, ".local/bin/dareecho"), "not-mine\n");
	const runner = join(f.base, "fixture-runner.mjs");
	await writeFile(runner, `Object.defineProperty(process,'platform',{value:'linux'}); Object.defineProperty(process,'arch',{value:'x64'}); process.getuid=()=>1000; const {main}=await import(${JSON.stringify(pathToFileURL(join(f.output, "install-overlay.mjs")).href)}); await main(process.argv.slice(2));`);
	const env = { ...process.env, HOME: user, USERPROFILE: user };
	await assert.rejects(exec(process.execPath, [runner, "--install"], { env }), /already exists/);
	assert.equal(await readFile(join(user, ".local/bin/dareecho"), "utf8"), "not-mine\n");
	await assert.rejects(access(join(user, ".local/share/rein-os")));
});

test("rain assets are required hashed payloads and same-size tampering is rejected", async t => {
	const f = await fixture(t), result = await prepareReinOS({ output: f.output, bundleRoot: f.root });
	for (const path of OS_THEME_FILES) {
		const data = await readFile(join(f.output, "payload", path));
		assert.deepEqual(result.manifest.files.find(entry => entry.path === path), { path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
	}
	const wallpaper = join(f.output, "payload", OS_THEME_FILES[1]), before = await readFile(wallpaper, "utf8");
	await writeFile(wallpaper, before.replace(/#[a-f0-9]{6}/i, "#000000"));
	await assert.rejects(exec(process.execPath, [join(f.output, "install-overlay.mjs"), "--verify"]), /Payload checksum mismatch/);
	await writeFile(wallpaper, before);
	const manifestPath = join(f.output, "manifest.json");
	result.manifest.files = result.manifest.files.filter(entry => entry.path !== OS_THEME_FILES[1]);
	await writeFile(manifestPath, JSON.stringify(result.manifest));
	await assert.rejects(exec(process.execPath, [join(f.output, "install-overlay.mjs"), "--verify"]), /Required payload missing/);
});

test("theme directories cannot redirect export through a symlink", async t => {
	const f = await fixture(t), directory = join(f.root, "src/os/assets/rain"), target = join(f.base, "other-rain");
	await rename(directory, target); await symlink(target, directory, "dir");
	await assert.rejects(prepareReinOS({ output: f.output, bundleRoot: f.root }), /ordinary payload directories/);
	await assert.rejects(access(f.output));
});

test("the ChromeOS kit exports a userland installer, not the Omarchy fetch", async t => {
	const f = await fixture(t), output = join(f.base, "kit-cros");
	const kit = await prepareReinOS({ output, bundleRoot: f.root, target: "chromeos" });
	assert.equal(kit.manifest.kind, "chromeos-user-overlay");
	assert.equal(kit.manifest.target, "chromeos");
	assert.equal(kit.manifest.omarchy, undefined);
	assert.equal(kit.manifest.argent.repository, "https://github.com/software-mansion/argent.git");
	assert.equal(kit.manifest.argent.license, "Apache-2.0");
	assert.ok(kit.files.includes("install-chromeos.mjs"));
	assert.ok(!kit.files.includes("install-overlay.mjs"));
	assert.ok(!kit.files.includes("fetch-upstream.mjs"));
	const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
	assert.equal(manifest.kind, "chromeos-user-overlay");
	assert.equal(manifest.target, "chromeos");
	assert.ok((await readFile(join(output, "README.md"), "utf8")).includes("chronos"));
});

test("the ChromeOS target check rejects foreign platforms and non-ChromeOS releases", async t => {
	const f = await fixture(t), output = join(f.base, "kit-cros-check");
	await prepareReinOS({ output, bundleRoot: f.root, target: "chromeos" });
	const { validateTarget, chromeosUserHome } = await import(pathToFileURL(join(output, "install-chromeos.mjs")).href);
	assert.doesNotThrow(() => validateTarget("linux", "NAME=Chrome OS\nID=chromeos\nCROS_RELEASE=132.0.0.0\n"));
	assert.doesNotThrow(() => validateTarget("linux", "CROS_RELEASE=132.0.0.0\n"));
	assert.throws(() => validateTarget("linux", "PRETTY_NAME=\"Ubuntu 24.04\"\n"), /ChromeOS/);
	assert.throws(() => validateTarget("darwin", "ID=chromeos\n"), /linux/);
	assert.throws(() => validateTarget("linux", ""), /ChromeOS/);
	assert.throws(() => validateTarget("linux", "NOT_ID=chromeos\n"), /ChromeOS/);
	assert.throws(() => validateTarget("linux", "# CROS_RELEASE=132.0.0.0\n"), /ChromeOS/);
	assert.equal(await chromeosUserHome("/home/chronos/user/1000"), "/home/chronos/user/1000");
	await assert.rejects(chromeosUserHome("/tmp/home/chronos/user/1000"), /ChromeOS chronos user/);
	assert.equal(await chromeosUserHome("/tmp/home/chronos/user/1000", true), "/tmp/home/chronos/user/1000");
});

test("the ChromeOS bootstrap installs chronos user files only, and preserves user data", async t => {
	const f = await fixture(t), output = join(f.base, "kit-cros-install");
	await prepareReinOS({ output, bundleRoot: f.root, target: "chromeos" });
	const user = join(f.base, "home/chronos/user/1000");
	await mkdir(join(user, ".local/share"), { recursive: true });
	await mkdir(join(user, "Documents"), { recursive: true });
	await writeFile(join(user, ".local/share/myfiles-marker"), "user-data");
	await writeFile(join(user, "Documents/note.md"), "preserve-me");
	const osRelease = join(f.base, "os-release.txt");
	await writeFile(osRelease, "NAME=Chrome OS\nID=chromeos\nCROS_RELEASE=132.0.6834.0\n");
	const runner = join(f.base, "cros-runner.mjs");
	// Synthetic platform applies only in this test process. The shipped installer has no override flag.
	await writeFile(runner, `Object.defineProperty(process,'platform',{value:'linux'}); const {main}=await import(${JSON.stringify(pathToFileURL(join(output, "install-chromeos.mjs")).href)}); await main(process.argv.slice(2));`);
	const env = { ...process.env, HOME: user, USERPROFILE: user, REIN_OS_OSRELEASE: osRelease };
	assert.match((await exec(process.execPath, [runner, "--check"], { env })).stdout, /REIN_OS_TARGET_READY/);
	assert.match((await exec(process.execPath, [runner, "--install"], { env })).stdout, /REIN_OS_CHROMEOS_INSTALLED/);
	const launcher = join(user, ".local/bin/rein");
	assert.match((await exec(process.execPath, [launcher, "--version"], { env })).stdout, /fixture-rein --version/);
	assert.equal(await readFile(join(user, "Documents/note.md"), "utf8"), "preserve-me");
	assert.equal(await readFile(join(user, ".local/share/myfiles-marker"), "utf8"), "user-data");
	for (const path of OS_THEME_FILES) assert.deepEqual(await readFile(join(user, ".local/share/rein-os", path)), await readFile(join(f.root, path)));
	assert.match((await exec(process.execPath, [join(user, ".local/bin/dareecho")], { env })).stdout, /Dareecho 1\.2\.3 \(base: ChromeOS 132\.0\.6834\.0\)/);
	const crosRelease = JSON.parse(await readFile(join(user, ".local/share/rein-os/dareecho-release"), "utf8"));
	assert.equal(crosRelease.base.name, "ChromeOS");
	assert.ok(!("omarchy" in crosRelease.pins), "the ChromeOS identity pins the toolkits, not Omarchy");
	assert.deepEqual(await readFile(join(user, ".local/share/rein-os/apps/klaud/main.mjs"), "utf8"), "// fixture klaudbot app entry\n");
	await assert.rejects(exec(process.execPath, [runner, "--install"], { env }), /already exists/);
});

test("a non-chronos home is refused by the ChromeOS bootstrap", async t => {
	const f = await fixture(t), output = join(f.base, "kit-cros-home");
	await prepareReinOS({ output, bundleRoot: f.root, target: "chromeos" });
	const user = join(f.base, "plain-user");
	await mkdir(user, { recursive: true });
	const osRelease = join(f.base, "os-release2.txt");
	await writeFile(osRelease, "ID=chromeos\n");
	const runner = join(f.base, "cros-runner2.mjs");
	await writeFile(runner, `Object.defineProperty(process,'platform',{value:'linux'}); const {main}=await import(${JSON.stringify(pathToFileURL(join(output, "install-chromeos.mjs")).href)}); await main(process.argv.slice(2));`);
	const env = { ...process.env, HOME: user, USERPROFILE: user, REIN_OS_OSRELEASE: osRelease };
	await assert.rejects(exec(process.execPath, [runner, "--check"], { env }), /chronos/);
});

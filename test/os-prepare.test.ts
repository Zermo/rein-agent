import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareReinOS } from "../src/os/prepare.ts";
const exec = promisify(execFile);

async function fixture(t: any) {
	const base = await mkdtemp(join(tmpdir(), "rein-os-kit-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "source");
	await mkdir(join(root, "dist"), { recursive: true });
	await mkdir(join(root, "vendor/meat"), { recursive: true });
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
	const runner = join(f.base, "fixture-runner.mjs");
	// Synthetic platform applies only in this test process. The shipped installer has no override flag.
	await writeFile(runner, `Object.defineProperty(process,'platform',{value:'linux'}); Object.defineProperty(process,'arch',{value:'x64'}); process.getuid=()=>1000; const {main}=await import(${JSON.stringify(pathToFileURL(join(f.output, "install-overlay.mjs")).href)}); await main(process.argv.slice(2));`);
	const env = { ...process.env, HOME: user, USERPROFILE: user };
	assert.match((await exec(process.execPath, [runner, "--check"], { env })).stdout, /REIN_OS_TARGET_READY/);
	assert.match((await exec(process.execPath, [runner, "--install"], { env })).stdout, /REIN_OS_OVERLAY_INSTALLED/);
	const launcher = join(user, ".local/bin/rein");
	assert.match((await exec(process.execPath, [launcher, "--version"], { env })).stdout, /fixture-rein --version/);
	assert.equal(await readFile(join(user, ".rein/config.json"), "utf8"), "preserve-me");
	await assert.rejects(exec(process.execPath, [runner, "--install"], { env }), /already exists/);
});

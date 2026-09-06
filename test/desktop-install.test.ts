import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeTermInstaller, nodeTermArtifact, verifyNodeTermDownload } from "../src/harness/desktop/install.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "rein-desktop-test-"));
	const home = join(root, "home with spaces"), temporaryRoot = join(root, "tmp"), systemApplications = join(root, "system apps");
	for (const directory of [home, temporaryRoot, systemApplications]) await mkdir(directory);
	const payload = "fixture release, never executed";
	const calls: Array<{ command: string; args: string[]; timeout: number }> = [];
	const fail = new Set<string>();
	let corrupt = false;
	let beforePublish: (() => Promise<void>) | undefined;
	const deps = {
		platform: "darwin", arch: "arm64", home, temporaryRoot, systemApplications,
		artifact: () => ({ url: "https://example.com/fixture.dmg", sha256: createHash("sha256").update(payload).digest("hex") }),
		run: async (command: string, args: string[], timeout: number) => {
			calls.push({ command, args, timeout });
			if (command === "curl") await writeFile(args[args.indexOf("--output") + 1], corrupt ? "corrupted" : payload);
			if (fail.has(command)) throw new Error(`${command} fixture failure`);
			if (command === "hdiutil" && args[0] === "attach") {
				const app = join(args[args.indexOf("-mountpoint") + 1], "nodeterm.app");
				await mkdir(app); await writeFile(join(app, "fixture-app"), "verified upstream fixture");
			}
			if (command === "ditto") { await cp(args[0], args[1], { recursive: true }); await beforePublish?.(); }
		},
	};
	return { root, home, temporaryRoot, systemApplications, calls, fail, deps,
		corrupt: () => { corrupt = true; }, beforePublish: (fn: () => Promise<void>) => { beforePublish = fn; },
		install: (options = {}) => createNodeTermInstaller(deps)(options),
		clean: async () => {
			assert.deepEqual(await readdir(temporaryRoot), [], "private downloads and mounts are cleaned");
			const files = await readdir(join(home, "Applications")).catch(() => []);
			assert.ok(files.every(name => !name.startsWith(".rein-")), "owned lock and staging directories are cleaned");
		},
		close: () => rm(root, { recursive: true, force: true }),
	};
}

test("NodeTerm selects only pinned official macOS architecture assets", () => {
	assert.match(nodeTermArtifact("darwin", "arm64")!.url, /github\.com\/eneskirca\/nodeterm\/releases\/download\/v0\.3\.4\/nodeterm-0\.3\.4-arm64\.dmg$/);
	assert.match(nodeTermArtifact("darwin", "x64")!.url, /nodeterm-0\.3\.4\.dmg$/);
	for (const arch of ["arm64", "x64"]) assert.match(nodeTermArtifact("darwin", arch)!.sha256, /^[a-f0-9]{64}$/);
	assert.equal(nodeTermArtifact("darwin", "riscv64"), undefined);
	assert.equal(nodeTermArtifact("linux", "x64"), undefined);
});

test("NodeTerm verifies bytes before mounting, stages a signed app, and launches by argv", async () => {
	const f = await fixture();
	try {
		const result = await f.install({ launch: true });
		assert.equal(result.installed, true, result.detail);
		assert.equal(result.appPath, join(f.home, "Applications", "nodeterm.app"));
		assert.equal(await readFile(join(result.appPath!, "fixture-app"), "utf8"), "verified upstream fixture");
		assert.deepEqual(f.calls.map(call => call.command), ["curl", "hdiutil", "codesign", "spctl", "ditto", "codesign", "open", "hdiutil"]);
		assert.deepEqual(f.calls.find(call => call.command === "open")!.args, ["-a", result.appPath]);
		const download = f.calls[0];
		for (const flag of ["--proto", "--proto-redir"]) assert.equal(download.args[download.args.indexOf(flag) + 1], "=https");
		assert.ok(download.timeout <= 610_000);
		assert.ok(!f.calls.some(call => ["sudo", "xattr"].includes(call.command)));
		await f.clean();
	} finally { await f.close(); }
});

test("existing NodeTerm installations are preserved without downloading or changing preferences", async () => {
	for (const existingLocation of ["system", "user"]) {
		const f = await fixture();
		try {
			const app = join(existingLocation === "system" ? f.systemApplications : join(f.home, "Applications"), "nodeterm.app");
			await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
			await writeFile(join(app, "Contents", "MacOS", "nodeterm"), "fixture executable", { mode: 0o755 });
			await writeFile(join(app, "Contents", "Info.plist"), "fixture metadata");
			await writeFile(join(app, "existing"), "keep this version");
			const result = await f.install();
			assert.equal(result.installed, true, result.detail); assert.equal(result.appPath, app);
			assert.match(result.detail, /preserved/); assert.deepEqual(f.calls, []);
			assert.equal(await readFile(join(app, "existing"), "utf8"), "keep this version");
			await f.clean();
		} finally { await f.close(); }
	}
});

test("incomplete app directories are preserved and never reported as installed", async () => {
	const f = await fixture();
	try {
		const app = join(f.systemApplications, "nodeterm.app");
		await mkdir(app); await writeFile(join(app, "partial-download"), "preserve");
		const result = await f.install();
		assert.equal(result.installed, false); assert.match(result.detail, /incomplete or unusable/);
		assert.deepEqual(f.calls, []);
		assert.equal(await readFile(join(app, "partial-download"), "utf8"), "preserve");
		await f.clean();
	} finally { await f.close(); }
});

test("checksum rejection and download failure never mount or install unverified bytes", async () => {
	for (const failure of ["checksum", "curl"]) {
		const f = await fixture();
		try {
			if (failure === "checksum") f.corrupt(); else f.fail.add("curl");
			const result = await f.install();
			assert.equal(result.installed, false); assert.match(result.detail, failure === "checksum" ? /checksum/ : /curl fixture failure/);
			assert.deepEqual(f.calls.map(call => call.command), ["curl"]);
			await f.clean();
		} finally { await f.close(); }
	}
});

test("signature and copy failures clean the mount and never create an app", async () => {
	for (const failure of ["codesign", "spctl", "ditto"]) {
		const f = await fixture();
		try {
			f.fail.add(failure);
			const result = await f.install();
			assert.equal(result.installed, false); assert.match(result.detail, /fixture failure/);
			assert.equal(f.calls.at(-1)!.command, "hdiutil"); assert.equal(f.calls.at(-1)!.args[0], "detach");
			assert.ok(!(await readdir(join(f.home, "Applications"))).includes("nodeterm.app"));
			await f.clean();
		} finally { await f.close(); }
	}
});

test("a concurrent installation is never overwritten", async () => {
	const f = await fixture();
	try {
		const app = join(f.home, "Applications", "nodeterm.app");
		f.beforePublish(async () => { await mkdir(app); await writeFile(join(app, "existing"), "concurrent install"); });
		const result = await f.install();
		assert.equal(result.installed, false); assert.match(result.detail, /appeared/);
		assert.equal(await readFile(join(app, "existing"), "utf8"), "concurrent install");
		await f.clean();
	} finally { await f.close(); }
});

test("unsupported platforms do not download or claim native installation", async () => {
	const f = await fixture();
	try {
		f.deps.platform = "linux";
		const result = await f.install();
		assert.equal(result.installed, false); assert.match(result.detail, /https:\/\/nodeterm.dev\/releases/);
		assert.deepEqual(f.calls, []); await f.clean();
	} finally { await f.close(); }
});

test("download verification hashes the actual file contents", async () => {
	const f = await fixture();
	try {
		const path = join(f.root, "bytes"); await writeFile(path, "hello");
		await verifyNodeTermDownload(path, createHash("sha256").update("hello").digest("hex"));
		await assert.rejects(verifyNodeTermDownload(path, "0".repeat(64)), /checksum/);
	} finally { await f.close(); }
});

/** Export an offline Rein payload and explicit VM post-install workflow. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OMARCHY_BASE } from "./plan.ts";

const REQUIRED = ["dist/rein.js", "dist/meat-worker.js", "vendor/meat/meat.wasm.gz", "vendor/meat/wasm_exec.cjs", "LICENSE"];
const VENDOR = ["meat", "mattpocock", "ponytail", "unlazy", "obscura", "fold", "pi-posthorse"];
export interface OSKitManifest {
	schemaVersion: 1;
	kind: "omarchy-post-install-overlay";
	bootable: false;
	target: "linux-x64";
	reinVersion: string;
	omarchy: typeof OMARCHY_BASE;
	files: { path: string; sha256: string; bytes: number }[];
}

function validPath(path: unknown): asserts path is string {
	if (typeof path !== "string" || !path.trim() || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Output must be a nonempty filesystem path without control characters.");
}
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
async function regularFile(path: string): Promise<Buffer> {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("The kit accepts regular payload files only.");
	if (info.size > 128 * 1024 * 1024) throw new Error("A payload file exceeds the 128 MiB limit.");
	return readFile(path);
}
async function sourceRoot(): Promise<string> {
	const here = dirname(fileURLToPath(import.meta.url));
	for (const root of [resolve(here, "../.."), resolve(here, "..")]) {
		try { if ((await lstat(join(root, "dist/rein.js"))).isFile()) return root; } catch { /* Try bundled layout. */ }
	}
	throw new Error("Rein's distribution bundle is missing. Run npm run bundle in the source checkout.");
}

export async function prepareReinOS(options: { output: string; bundleRoot?: string }): Promise<{ output: string; manifest: OSKitManifest; files: string[] }> {
	if (!options || typeof options !== "object") throw new Error("An output directory is required.");
	validPath(options.output);
	if (options.bundleRoot !== undefined) validPath(options.bundleRoot);
	const output = resolve(options.output);
	const root = options.bundleRoot === undefined ? await sourceRoot() : resolve(options.bundleRoot);
	await realpath(dirname(output)); // Never create an unexpected chain of parents.
	try { await lstat(output); throw new Error("Output already exists; choose a new directory. Existing files are preserved."); }
	catch (error: any) { if (error.code !== "ENOENT") throw error; }
	const pkg = JSON.parse((await regularFile(join(root, "package.json"))).toString("utf8"));
	if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error("The Rein package version is invalid.");
	const payload = new Map<string, Buffer>();
	for (const path of REQUIRED) payload.set(path, await regularFile(join(root, path)));
	const visit = async (relative: string) => {
		const stat = await lstat(join(root, relative));
		if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in the exported payload.");
		if (stat.isDirectory()) {
			for (const name of (await readdir(join(root, relative))).sort()) {
				if (name.startsWith(".") || name === "upstream" || name === "node_modules") continue;
				await visit(`${relative}/${name}`);
			}
		} else payload.set(relative, await regularFile(join(root, relative)));
	};
	for (const name of VENDOR) {
		try { await lstat(join(root, "vendor", name)); } catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
		await visit(`vendor/${name}`);
	}
	// Package metadata only; local scripts, configuration, account data and sessions never enter a kit.
	payload.set("package.json", Buffer.from(JSON.stringify({ name: "rein-agent", version: pkg.version, type: "module", engines: { node: ">=18" } }, null, 2) + "\n"));
	const manifest: OSKitManifest = {
		schemaVersion: 1, kind: "omarchy-post-install-overlay", bootable: false, target: "linux-x64", reinVersion: pkg.version, omarchy: OMARCHY_BASE,
		files: [...payload].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => ({ path, sha256: sha(data), bytes: data.length })),
	};
	// Exclusive creation preserves an existing output even if it appears during staging.
	await mkdir(output, { mode: 0o700 });
	const files: string[] = [];
	const put = async (path: string, content: string | Buffer) => {
		const destination = join(output, path);
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		await writeFile(destination, content, { flag: "wx", mode: 0o600 });
		files.push(path);
	};
	try {
		for (const [path, data] of payload) await put(`payload/${path}`, data);
		await put("install-overlay.mjs", INSTALL_OVERLAY);
		await put("fetch-upstream.mjs", FETCH_UPSTREAM);
		await put("README.md", KIT_README);
		await put("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
	} catch {
		throw new Error("Kit export did not finish. The partial output was preserved for inspection; choose a new output directory to retry.");
	}
	return { output, manifest, files };
}

const INSTALL_OVERLAY = String.raw`import { createHash } from 'node:crypto';
import { lstat, readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const kit = dirname(fileURLToPath(import.meta.url));
const fail = message => { throw new Error(message); };
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail('Destination already exists; it was preserved: ' + path);
}
async function checkInstallParents(userHome) {
  for (const path of [userHome, join(userHome,'.local'), join(userHome,'.local/share'), join(userHome,'.local/bin')]) {
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Installation parents must be regular directories; existing paths were preserved.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export function validateTarget(platform, arch, version) {
  if (platform !== 'linux' || arch !== 'x64') fail('Apply this overlay only inside an installed x86-64 Linux VM.');
  if (version.trim() !== '4.0.2') fail('This kit targets Omarchy 4.0.2. Verify the installed base before proceeding.');
}
async function verifyPayload() {
  const manifest = JSON.parse(await readFile(join(kit, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'omarchy-post-install-overlay' || manifest.bootable !== false || !Array.isArray(manifest.files)) fail('Invalid kit manifest.');
  const seen = new Set();
  const result = [];
  const payloadRoot = await lstat(join(kit, 'payload'));
  if (!payloadRoot.isDirectory() || payloadRoot.isSymbolicLink()) fail('Payload must be a regular directory.');
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !/^[a-zA-Z0-9_.+/-]+$/.test(entry.path) || entry.path.startsWith('/') || entry.path.split('/').some(p => !p || p === '.' || p === '..') || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail('Invalid payload manifest entry.');
    seen.add(entry.path);
    let path = join(kit, 'payload');
    for (const part of entry.path.split('/')) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink()) fail('Payload links are not accepted.');
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size !== entry.bytes || stat.size > 128 * 1024 * 1024) fail('Payload size/type mismatch: ' + entry.path);
    const data = await readFile(path);
    if (createHash('sha256').update(data).digest('hex') !== entry.sha256) fail('Payload checksum mismatch: ' + entry.path);
    result.push([entry.path, data]);
  }
  for (const name of ['dist/rein.js', 'dist/meat-worker.js', 'vendor/meat/meat.wasm.gz', 'vendor/meat/wasm_exec.cjs', 'package.json', 'LICENSE']) if (!seen.has(name)) fail('Required payload missing: ' + name);
  return result;
}
export async function main(args) {
  if (args.length !== 1 || !['--help', '--verify', '--check', '--install'].includes(args[0])) fail('Usage: node install-overlay.mjs --verify | --check | --install');
  if (args[0] === '--help') { console.log('Verify checks the exported files; check validates the target; install creates a new user-local terminal installation. No model downloads, setup, or services are started.'); return; }
  const files = await verifyPayload();
  if (args[0] === '--verify') { console.log('REIN_OS_PAYLOAD_OK'); return; }
  const userHome = homedir();
  if (process.getuid?.() === 0) fail('Run this as the target desktop user, without sudo.');
  await checkInstallParents(userHome);
  const versionPath = join(userHome, '.local/share/omarchy/version');
  validateTarget(process.platform, process.arch, await readFile(versionPath, 'utf8').catch(() => ''));
  const destination = join(userHome, '.local/share/rein-os');
  const launcher = join(userHome, '.local/bin/rein');
  await absent(destination);
  await absent(launcher);
  if (args[0] === '--check') { console.log('REIN_OS_TARGET_READY'); return; }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(dirname(launcher), { recursive: true, mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  for (const [relative, data] of files) {
    const path = join(destination, relative);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { flag: 'wx', mode: 0o600 });
  }
  const entry = join(destination, 'dist/rein.js');
  const wrapper = '#!/usr/bin/env node\n' + 'import("node:child_process").then(({spawn})=>{\n' + 'const child=spawn(process.execPath,[' + JSON.stringify(entry) + ',...process.argv.slice(2)],{stdio:"inherit"});\n' + 'child.on("error",e=>{console.error(e.message);process.exitCode=1});\nchild.on("exit",(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exitCode=code??1});\n});\n';
  await writeFile(launcher, wrapper, { flag: 'wx', mode: 0o700 });
  console.log('REIN_OS_OVERLAY_INSTALLED\nRun ~/.local/bin/rein --version, then ~/.local/bin/rein setup. Configuration and sessions were preserved.');
}
const invoked = process.argv[1] && await realpath(process.argv[1]).catch(() => '');
if (invoked === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
`;

const FETCH_UPSTREAM = `import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const source = ${JSON.stringify(OMARCHY_BASE)};
try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].trim() || /[\\x00-\\x1f\\x7f]/.test(args[0])) throw new Error('Usage: node fetch-upstream.mjs NEW_DIRECTORY');
  const destination = resolve(args[0]);
  await mkdir(destination, {mode: 0o700});
  const git = (...args) => execFileSync('git', ['-C', destination, ...args], {encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:120000});
  git('init');
  git('remote', 'add', 'origin', source.repository);
  git('fetch', '--depth', '1', 'origin', source.commit);
  git('checkout', '--detach', 'FETCH_HEAD');
  if (git('rev-parse', 'HEAD').trim() !== source.commit) throw new Error('Upstream revision mismatch.');
  console.log('OMARCHY_SOURCE_PIN_OK');
} catch(error) { console.error(error.message); process.exitCode = 1; }
`;

const KIT_README = `# Rein OS VM overlay kit

This kit installs the bundled terminal harness into an already installed Omarchy 4.0.2 VM. It is a development payload, not a bootable image or an OS installer. The native Rein klaud desktop package is not included in this first overlay.

## Verify the kit

Use Node 18 or newer. On the computer that created the kit, run:

\`\`\`sh
node install-overlay.mjs --verify
\`\`\`

manifest.json records each payload's SHA-256 and the reviewed upstream commit. These checks detect changed payload bytes; they are not publisher signatures. Neither this command nor kit export downloads models or starts services.

## Prepare the base VM

1. Obtain the Omarchy installation ISO from the [official distribution](https://omarchy.org/). Verify its publisher-provided checksum or signature separately. This kit does not provide or claim a verified ISO hash.
2. Create a disposable x86-64 VM with UEFI, a virtual display, and its own empty virtual disk. Do not attach a physical disk or enable raw-device passthrough. Follow the [upstream installation guide](${OMARCHY_BASE.installation}) and select only that virtual disk in the interactive wizard. The installer controls disk formatting and encryption.
3. Boot the installed desktop and confirm its version is 4.0.2. The source pin describes reviewed code; it does not force a downloaded ISO or its packages to this version. Stop if the installed version differs and review that release before updating this kit.
4. Install or verify Node, Git, Bash, tmux, Python, and zstd in the VM using the distribution's supported tools. Copy this entire kit into the VM as the desktop user.

An optional source checkout for inspection is available with:

\`\`\`sh
node fetch-upstream.mjs ./omarchy-source
\`\`\`

That command downloads the exact Omarchy source revision and checks the result. It does not run upstream scripts or build an ISO. A source checkout alone is not bootable installation media.

## Apply the Rein overlay in the VM

Run without sudo:

\`\`\`sh
node install-overlay.mjs --check
node install-overlay.mjs --install
~/.local/bin/rein --version
~/.local/bin/rein setup
\`\`\`

The installer creates ~/.local/share/rein-os and ~/.local/bin/rein, refusing to overwrite either. Existing ~/.rein configuration, accounts and sessions remain intact. Add ~/.local/bin to PATH if your shell does not already include it. Setup remains interactive; no background inference, cloud account, system service, model, or network listener is enabled by the overlay.

## Acceptance gates before making a reusable image

- Boot the VM twice and verify desktop, networking, keyboard, display and storage.
- Verify Rein's version and setup; connect to a selected model and complete a tool round trip. Review model memory fit, context size, latency, quality and memory pressure separately.
- Opt into the headless autonomy helper through Rein's existing controls; verify stop, restart, budgets and user approvals.
- Test an update and recovery on a VM copy. This kit does not yet provide a bootable image build, migration tool, automated rollback, or fleet provisioning.
- Remove personal accounts, keys, models, transcripts and machine identifiers before exporting a VM template. Reusable images must defer personal onboarding to their owner.

Omarchy documents a separate [cidata unattended installation flow](${OMARCHY_BASE.unattended}). It carries machine-specific disk configuration and may contain credentials. This kit deliberately does not invent or ship that configuration, run it on the host, or claim it has a Rein post-install hook. Establish a validated VM image before adding unattended automation.

For a physical-machine release, separately validate exact hardware, boot firmware, backup recovery, encryption and disk selection. [Intel Mac constraints](${OMARCHY_BASE.macSupport}) differ from general PCs; Apple Silicon uses native macOS for this release and needs a separate Asahi-based Linux port. No BIOS or kernel exploit can substitute for those hardware requirements.
`;

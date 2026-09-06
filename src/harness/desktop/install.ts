/** Install the separate upstream NodeTerm app without replacing an existing installation. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const NODETERM_VERSION = "0.3.4";
export interface NodeTermArtifact { url: string; sha256: string }
export interface NodeTermInstallResult { installed: boolean; appPath?: string; detail: string }
export interface NodeTermInstallOptions { launch?: boolean }

/** Official GitHub release checksums, also published by nodeterm/homebrew-tap. */
export function nodeTermArtifact(platform: string, arch: string): NodeTermArtifact | undefined {
	if (platform !== "darwin") return undefined;
	const assets: Record<string, [string, string]> = {
		arm64: [`nodeterm-${NODETERM_VERSION}-arm64.dmg`, "44d575d65d6b8cbfb92d1a2e7eca5996ff6918bc94db127548f1b6a13a6b554a"],
		x64: [`nodeterm-${NODETERM_VERSION}.dmg`, "43de9d36b510a65b85fb483868d8899024ad05e14a9a33693187a763985b1e27"],
	};
	const asset = assets[arch];
	return asset && { url: `https://github.com/eneskirca/nodeterm/releases/download/v${NODETERM_VERSION}/${asset[0]}`, sha256: asset[1] };
}

export async function verifyNodeTermDownload(file: string, expected: string): Promise<void> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	if (hash.digest("hex") !== expected) throw new Error("NodeTerm download checksum did not match the official release; installation stopped.");
}

type Run = (command: string, args: string[], timeout: number) => Promise<void>;
interface InstallDependencies {
	platform: string;
	arch: string;
	home: string;
	temporaryRoot: string;
	systemApplications: string;
	run: Run;
	artifact: (platform: string, arch: string) => NodeTermArtifact | undefined;
}

const exec = promisify(execFile);
const run: Run = async (command, args, timeout) => {
	await exec(command, args, { timeout, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" });
};
async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function usableApp(path: string): Promise<boolean> {
	try {
		const executable = join(path, "Contents", "MacOS", "nodeterm");
		if (!(await stat(path)).isDirectory() || !(await stat(executable)).isFile()
			|| !(await stat(join(path, "Contents", "Info.plist"))).isFile()) return false;
		await access(executable, constants.X_OK);
		return true;
	} catch { return false; }
}

/** Dependency boundary permits offline fixture tests without touching installed apps. */
export function createNodeTermInstaller(deps: InstallDependencies) {
	return async (options: NodeTermInstallOptions = {}): Promise<NodeTermInstallResult> => {
		if (deps.platform !== "darwin") return {
			installed: false,
			detail: "Automatic NodeTerm installation currently supports macOS. Install the native app for your platform from https://nodeterm.dev/releases, then run Rein inside its terminal node.",
		};
		let temporary: string | undefined, staging: string | undefined, lock: string | undefined;
		let mount: string | undefined, mounted = false, appPath: string | undefined;
		let detail = "";
		try {
			const applications = join(deps.home, "Applications");
			const destination = join(applications, "nodeterm.app");
			for (const candidate of [join(deps.systemApplications, "nodeterm.app"), destination]) {
				if (!await exists(candidate)) continue;
				if (!await usableApp(candidate)) throw new Error(`An incomplete or unusable NodeTerm app exists at ${candidate}. It was preserved. Move it aside before retrying installation.`);
				appPath = candidate;
				detail = "Existing NodeTerm installation preserved.";
				break;
			}
			if (!appPath) {
				const artifact = deps.artifact(deps.platform, deps.arch);
				if (!artifact) return { installed: false, detail: `No supported NodeTerm download for macOS ${deps.arch}. See https://nodeterm.dev/releases.` };
				await mkdir(applications, { recursive: true });
				const lockPath = join(applications, ".rein-nodeterm-install.lock");
				try { await mkdir(lockPath, { mode: 0o700 }); lock = lockPath; }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another NodeTerm installation may be running. Retry when it finishes.");
					throw error;
				}
				temporary = await mkdtemp(join(deps.temporaryRoot, "rein-nodeterm-"));
				const download = join(temporary, "nodeterm.dmg");
				await deps.run("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https",
					"--connect-timeout", "15", "--max-time", "600", "--max-filesize", "536870912", "--output", download, artifact.url], 610_000);
				const downloaded = await stat(download);
				if (!downloaded.isFile() || downloaded.size === 0 || downloaded.size > 536870912) throw new Error("The NodeTerm download is empty or exceeds the expected size limit.");
				await verifyNodeTermDownload(download, artifact.sha256);
				mount = join(temporary, "mount");
				await mkdir(mount);
				// Detach is attempted even after a partially successful attach.
				mounted = true;
				await deps.run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, download], 60_000);
				const source = join(mount, "nodeterm.app");
				if (!(await lstat(source)).isDirectory()) throw new Error("The release disk image does not contain nodeterm.app.");
				await deps.run("codesign", ["--verify", "--deep", "--strict", source], 60_000);
				await deps.run("spctl", ["--assess", "--type", "execute", source], 60_000);
				staging = await mkdtemp(join(applications, ".rein-nodeterm-stage-"));
				const stagedApp = join(staging, "nodeterm.app");
				await deps.run("ditto", [source, stagedApp], 120_000);
				await deps.run("codesign", ["--verify", "--deep", "--strict", stagedApp], 60_000);
				if (await exists(destination)) throw new Error("A NodeTerm installation appeared while downloading. It was preserved; retry to use it.");
				await rename(stagedApp, destination);
				appPath = destination;
				detail = `Installed official NodeTerm ${NODETERM_VERSION} in ~/Applications.`;
			}
			if (options.launch) {
				try { await deps.run("open", ["-a", appPath], 30_000); detail += " NodeTerm opened."; }
				catch { detail += " Open NodeTerm from Applications to continue."; }
			}
			return { installed: true, appPath, detail };
		} catch (error) {
			return { installed: false, detail: `NodeTerm installation failed: ${(error as Error).message}` };
		} finally {
			if (mounted && mount) {
				try { await deps.run("hdiutil", ["detach", mount], 30_000); mounted = false; }
				catch {
					try { await deps.run("hdiutil", ["detach", "-force", mount], 30_000); mounted = false; }
					catch { /* Never recursively remove a mountpoint that may still be mounted. */ }
				}
			}
			if (temporary && !mounted) await rm(temporary, { recursive: true, force: true }).catch(() => {});
			if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
			if (lock) await rm(lock, { recursive: true, force: true }).catch(() => {});
		}
	};
}

export const installNodeTerm = createNodeTermInstaller({
	platform: process.platform, arch: process.arch, home: homedir(), temporaryRoot: tmpdir(),
	systemApplications: "/Applications", run, artifact: nodeTermArtifact,
});

/**
 * Optional Apache-2.0 Automodel submodule: https://github.com/NousResearch/Automodel
 * The pinned pyproject registers nemo_automodel.cli.app:main as "automodel";
 * its README documents "uv run automodel <recipe.yaml>". Python dependencies
 * remain in Automodel's environment and are never included in Rein's bundle.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function isFile(path: string, executable = false): boolean {
	try { if (!statSync(path).isFile()) return false; if (executable) accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return true; }
	catch { return false; }
}

function automodelRoot(): string {
	if (process.env.REIN_AUTOMODEL_ROOT) return resolve(process.env.REIN_AUTOMODEL_ROOT);
	const here = dirname(fileURLToPath(import.meta.url));
	// Source module and installed dist/rein.js layouts.
	const roots = [resolve(here, "../../../vendor/automodel"), resolve(here, "../vendor/automodel")];
	return roots.find(root => isFile(join(root, "pyproject.toml"))) ?? roots[0];
}

function uvPath(): string | undefined {
	const name = process.platform === "win32" ? "uv.exe" : "uv";
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const path = resolve(directory || ".", name);
		if (isFile(path, true)) return path;
	}
	return undefined;
}

/** A local availability check only; never installs dependencies or starts Python. */
export function automodelAvailable(): boolean {
	return isFile(join(automodelRoot(), "pyproject.toml")) && uvPath() !== undefined;
}

export async function runTrain(recipePath: string, extraArgs: string[] = []): Promise<{ code: number; log: string }> {
	if (typeof recipePath !== "string" || recipePath.includes("..") || recipePath.includes("\0") || !/\.ya?ml$/i.test(recipePath)) {
		throw new Error("The training recipe must be a .yaml or .yml path without '..'.");
	}
	if (!Array.isArray(extraArgs) || extraArgs.some(value => typeof value !== "string" || value.includes("\0"))) {
		throw new Error("Training arguments must be strings without null bytes.");
	}
	const testing = process.env.NODE_TEST_CONTEXT !== undefined, override = process.env.REIN_AUTOMODEL_BIN;
	if (override !== undefined && !testing) throw new Error("REIN_AUTOMODEL_BIN is only available in tests.");
	if (testing && !override) throw new Error("Tests must set REIN_AUTOMODEL_BIN to a fake executable; real training is disabled.");
	const rawTimeout = process.env.REIN_TRAIN_TIMEOUT_MS;
	let timeout: number | undefined;
	if (rawTimeout !== undefined) {
		timeout = /^\d+$/.test(rawTimeout) ? Number(rawTimeout) : NaN;
		if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new Error("REIN_TRAIN_TIMEOUT_MS must be an integer from 1 to 2147483647.");
	}
	if (testing) timeout = Math.min(timeout ?? 120_000, 120_000);
	const root = automodelRoot(), uv = uvPath();
	if (!override && (!isFile(join(root, "pyproject.toml")) || !uv)) throw new Error("Automodel requires uv on PATH and an Automodel checkout. Set REIN_AUTOMODEL_ROOT to that checkout.");
	// Resolve relative to the caller before entering the separate Python project.
	const args = ["run", "automodel", resolve(recipePath), ...extraArgs];
	const cwd = override && !isFile(join(root, "pyproject.toml")) ? process.cwd() : root;
	return new Promise((done, reject) => {
		const child = spawn(override ?? uv!, args, { cwd, detached: process.platform !== "win32", shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let log = "", truncated = false, closed = false, settled = false, code = 1, reason: string | undefined, error: Error | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined, escalation: ReturnType<typeof setTimeout> | undefined;
		const append = (text: string) => { log += text; if (log.length > 64_000) { log = log.slice(-64_000); truncated = true; } };
		const kill = (signal: NodeJS.Signals) => {
			try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
			catch { /* The owned process has already exited. */ }
		};
		const finish = () => {
			if (settled || !closed || escalation) return;
			settled = true; clearTimeout(timer);
			process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
			if (error) reject(error);
			else done({ code, log: (truncated ? "[training log truncated; showing tail]\n" : "") + log + (reason ? "\n" + reason + "\n" : "") });
		};
		const stop = (status: number, message: string, signal: NodeJS.Signals = "SIGTERM") => {
			if (reason || settled) return;
			code = status; reason = message; kill(signal);
			// Wait for group escalation even if uv exits before its workers.
			escalation = setTimeout(() => { kill("SIGKILL"); escalation = undefined; finish(); }, 250);
		};
		const interrupt = () => stop(130, "Training cancelled by SIGINT.", "SIGINT");
		const terminate = () => stop(143, "Training cancelled by SIGTERM.");
		process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
		if (timeout !== undefined) timer = setTimeout(() => stop(124, "Training timed out after " + timeout + "ms."), timeout);
		child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
		child.stdout.on("data", append); child.stderr.on("data", append);
		child.on("error", cause => { error = cause; closed = true; finish(); });
		child.on("close", status => { if (!reason) code = status ?? 1; closed = true; finish(); });
	});
}

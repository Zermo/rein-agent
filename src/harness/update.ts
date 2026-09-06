/** Update through the same published installer as the curl one-liner. */
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const INSTALLER_URL = "https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh";

function runProgram(command: string, args: string[], signal: AbortSignal, timeoutMs: number): Promise<void> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { shell: false, detached: true, stdio: "inherit" });
		let closed = false, settled = false, code: number | null = null, error: Error | undefined;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const kill = (value: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, value); } catch { /* Already exited. */ } };
		const finish = () => {
			if (settled || !closed || escalation) return;
			settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
			if (error) reject(error);
			else if (code !== 0) reject(new Error(`${command} exited ${code ?? "after a signal"}.`));
			else resolve();
		};
		const stop = (reason: Error) => {
			if (error) return;
			error = reason; kill("SIGTERM");
			// Drain the whole owned group even if the parent exits before its children.
			escalation = setTimeout(() => { kill("SIGKILL"); escalation = undefined; finish(); }, 1000);
		};
		const abort = () => stop(new Error("Update interrupted."));
		const timer = setTimeout(() => stop(new Error(`${command} timed out.`)), timeoutMs);
		signal.addEventListener("abort", abort, { once: true });
		child.on("error", (cause: NodeJS.ErrnoException) => {
			error ??= new Error(cause.code === "ENOENT" ? `${command} is required for rein update. Install it and retry.` : cause.message);
			closed = true; finish();
		});
		child.on("close", value => { code = value; closed = true; finish(); });
		if (signal.aborted) abort();
	});
}

export async function runUpdate(): Promise<number> {
	if (process.platform === "win32") {
		console.error("rein update uses the Bash installer. Run it inside WSL, or use: npm install --global git+https://github.com/Zermo/rein-agent.git");
		return 1;
	}
	const controller = new AbortController();
	let interruptedCode = 130;
	const cancel = (code: number) => { if (!controller.signal.aborted) interruptedCode = code; controller.abort(); };
	const signals = [["SIGINT", () => cancel(130)], ["SIGHUP", () => cancel(129)], ["SIGTERM", () => cancel(143)]] as const;
	for (const [signal, handler] of signals) process.on(signal, handler);
	let directory: string | undefined;
	try {
		directory = await mkdtemp(join(tmpdir(), "rein-update-"));
		const installer = join(directory, "install.sh");
		console.log(`Downloading the latest Rein installer from ${INSTALLER_URL}`);
		await runProgram("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https",
			"--connect-timeout", "15", "--max-time", "120", "--max-filesize", "1048576", "--header", "Cache-Control: no-cache", "--output", installer, INSTALLER_URL], controller.signal, 130_000);
		const downloaded = await stat(installer);
		if (!downloaded.isFile() || downloaded.size === 0 || downloaded.size > 1048576) throw new Error("The installer download is empty or invalid; it was not executed.");
		await chmod(installer, 0o600);
		await runProgram("bash", [installer, "--skip-setup"], controller.signal, 15 * 60_000);
		console.log("Rein update complete. Restart any running Rein sessions to use the new build.");
		return 0;
	} catch (error) {
		console.error(controller.signal.aborted ? "Update interrupted." : `Update failed: ${(error as Error).message}`);
		return controller.signal.aborted ? interruptedCode : 1;
	} finally {
		for (const [signal, handler] of signals) process.off(signal, handler);
		if (directory) await rm(directory, { recursive: true, force: true });
	}
}

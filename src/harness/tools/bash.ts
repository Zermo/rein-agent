import { spawn } from "node:child_process";
import type { AgentTool } from "../../agent/agent-loop.ts";
import { truncateTail } from "../../../vendor/fold/Truncation.ts";

/** Kill the whole owned process group on cancellation, including shell children. */
async function runShell(command: string, cwd: string | undefined, timeout: number, signal?: AbortSignal) {
	if (signal?.aborted) return { stdout: "", stderr: "", code: 1, reason: "Operation aborted" };
	return new Promise<{ stdout: string; stderr: string; code: number; reason?: string }>(resolve => {
		const child = spawn("bash", ["-c", command], { cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "", bytes = 0, code = 1, reason: string | undefined;
		let closed = false, settled = false, killTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = (value: NodeJS.Signals) => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, value); else child.kill(value); } catch {} };
		const finish = () => {
			if (settled || !closed || killTimer) return;
			settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
			resolve({ stdout, stderr, code, reason });
		};
		const stop = (detail: string) => {
			if (reason) return; reason = detail; code = 1;
			kill("SIGTERM");
			// Keep this timer alive even when the parent exits first: a detached
			// grandchild may have closed its stdio and ignored SIGTERM.
			killTimer = setTimeout(() => { kill("SIGKILL"); killTimer = undefined; finish(); }, 250);
		};
		const abort = () => stop("Operation aborted");
		const timer = setTimeout(() => stop(`timeout after ${timeout}s`), timeout * 1000);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
		child.stdout.on("data", (text: string) => { bytes += Buffer.byteLength(text); stdout = (stdout + text).slice(-64000); if (bytes > 8 * 1024 * 1024) stop("output exceeded 8MB"); });
		child.stderr.on("data", (text: string) => { bytes += Buffer.byteLength(text); stderr = (stderr + text).slice(-64000); if (bytes > 8 * 1024 * 1024) stop("output exceeded 8MB"); });
		child.on("error", error => { reason ??= error.message; closed = true; finish(); });
		child.on("close", exitCode => { code = reason ? 1 : exitCode ?? 1; closed = true; finish(); });
	});
}

export function createBashTool(cwd?: string): AgentTool {
	return {
		name: "bash",
		description: "Execute bash in the working directory. Output keeps the last 500 lines / 20KB using Fold's UTF-8 truncation. Redirect large output to a file for later read/grep. Cancellation stops this command's process group. Commands receive no interactive stdin.",
		parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer", minimum: 1, maximum: 600, description: "Seconds; default 120" } }, required: ["command"] },
		executionMode: "sequential",
		async execute(_id, args, signal) {
			const timeout = typeof args.timeout === "number" ? args.timeout : 120;
			const result = await runShell(args.command as string, cwd, timeout, signal);
			const text = [result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)";
			const output = truncateTail(text, { maxLines: 500, maxBytes: 20000 });
			const status = result.reason ? ` [${result.reason}]` : result.code ? ` [exit ${result.code}]` : "";
			return { content: (output.truncated ? "[output truncated; showing tail. Redirect to a file for full output.]\n" : "") + output.content + status,
				isError: result.code !== 0, details: { exitCode: result.code, timedOut: result.reason?.startsWith("timeout") ?? false, truncated: output.truncated, aborted: signal?.aborted ?? false } };
		},
	};
}
export default createBashTool();

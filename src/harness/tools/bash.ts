import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "../../agent/agent-loop.ts";
import { truncateLines } from "../../util/truncate.ts";

const execFileAsync = promisify(execFile);

export function createBashTool(cwd?: string): AgentTool {
	return {
	name: "bash",
	description:
		"Execute a bash command in the working directory. Returns stdout and stderr combined (stderr after stdout). Long output is truncated with head+tail. Use a timeout for slow commands.",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "Bash command to run" },
			timeout: { type: "integer", minimum: 1, maximum: 600, description: "Timeout in seconds (default 120)" },
		},
		required: ["command"],
	},
	executionMode: "sequential",
	execute: async (_id, args, signal) => {
		const command = args.command as string;
		const timeoutSec = typeof args.timeout === "number" ? args.timeout : 120;
		let stdout = "";
		let stderr = "";
		let code = 0;
		let timedOut = false;
		try {
			const result = await execFileAsync("bash", ["-c", command], {
				cwd,
				timeout: timeoutSec * 1000,
				maxBuffer: 8 * 1024 * 1024,
				signal,
			});
			stdout = result.stdout;
			stderr = result.stderr;
		} catch (err) {
			const e = err as any;
			stdout = e.stdout ?? "";
			stderr = e.stderr ?? e.message ?? "";
			code = typeof e.code === "number" ? e.code : 1;
			timedOut = e.killed === true;
		}
		let output = "";
		if (stdout) output += stdout;
		if (stderr) output += (output ? "\n" : "") + stderr;
		if (output.length === 0) output = "(no output)";
		const truncated = truncateLines(output, 500);
		if (truncated.truncated) output = truncated.text;
		const status = timedOut ? ` (timeout after ${timeoutSec}s)` : code !== 0 ? ` [exit ${code}]` : "";
		return {
			content: output + status,
			isError: code !== 0 || timedOut,
			details: { exitCode: code, timedOut, truncated: truncated.truncated },
		};
	},
	};
}

export default createBashTool();

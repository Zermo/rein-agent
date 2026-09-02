import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "../../agent/agent-loop.ts";

const execFileAsync = promisify(execFile);

const grepTool: AgentTool = {
	name: "grep",
	description: "Search file contents for a pattern (regex or literal). Returns matching lines as path:line:text. Respects .gitignore in git repos.",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Search pattern (regex or literal string)" },
			path: { type: "string", description: "Directory or file to search (default: cwd)" },
			glob: { type: "string", description: "Filter files by glob, e.g. '*.ts'" },
			ignoreCase: { type: "boolean", description: "Case-insensitive search (default false)" },
			literal: { type: "boolean", description: "Treat pattern as literal string (default false)" },
			context: { type: "integer", minimum: 0, maximum: 10, description: "Lines to show before and after each match (default 0)" },
			limit: { type: "integer", minimum: 1, description: "Maximum matches (default 100)" },
		},
		required: ["pattern"],
	},
	execute: async (_id, args) => {
		const argsArr: string[] = [];
		if (args.ignoreCase) argsArr.push("-i");
		if (args.literal) argsArr.push("-F");
		const context = typeof args.context === "number" ? args.context : 0;
		if (context > 0) argsArr.push("-C", String(context));
		argsArr.push("-n", "--color=never");
		argsArr.push(`-m${typeof args.limit === "number" ? args.limit : 100}`);
		if (args.glob) argsArr.push(`--include=${args.glob}`);
		argsArr.push("--", args.pattern, args.path ?? ".");
		try {
			const { stdout, stderr } = await execFileAsync("grep", argsArr, { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
			if (!stdout && !stderr) return { content: "No matches" };
			const out = (stdout + stderr).trimEnd();
			if (out.length > 15_000) return { content: out.slice(0, 15_000) + "\n… [output truncated — narrow the search]", isError: false };
			return { content: out };
		} catch (err) {
			const e = err as any;
			if (e.code === 1) return { content: "No matches" };
			return { content: `grep failed: ${e.stderr ?? e.message}`, isError: true };
		}
	},
};

export default grepTool;

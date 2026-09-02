import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "../../agent/agent-loop.ts";

const execFileAsync = promisify(execFile);

const findTool: AgentTool = {
	name: "find",
	description: "Find files by glob pattern. Returns matching paths relative to the search directory. Respects .gitignore.",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Glob pattern, e.g. '*.ts' or 'src/**/*.spec.ts'" },
			path: { type: "string", description: "Directory to search in (default: cwd)" },
			limit: { type: "integer", minimum: 1, description: "Maximum results (default 200)" },
		},
		required: ["pattern"],
	},
	execute: async (_id, args) => {
		const limit = typeof args.limit === "number" ? args.limit : 200;
		const path = args.path ?? ".";
		try {
			// Prefer fd if present (much faster), fall back to find
			const { stdout } = await execFileAsync("bash", ["-c", `command -v fd >/dev/null 2>&1 && fd -g ${shellQuote(args.pattern)} --max-results ${limit} . ${shellQuote(path)} || find ${shellQuote(path)} -name ${shellQuote(args.pattern)} -print | head -n ${limit}`], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
			const out = stdout.trimEnd();
			return { content: out || "No matches" };
		} catch (err) {
			return { content: `find failed: ${(err as Error).message}`, isError: true };
		}
	},
};

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

export default findTool;

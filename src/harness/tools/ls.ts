import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "../../agent/agent-loop.ts";

const lsTool: AgentTool = {
	name: "ls",
	description: "List a directory's contents. Directories get a trailing /. Hidden files included. Use this instead of bash ls.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Directory to list (default: cwd)" },
			depth: { type: "integer", minimum: 1, maximum: 3, description: "Recursion depth (default 1)" },
			limit: { type: "integer", minimum: 1, description: "Maximum entries (default 300)" },
		},
		required: [],
	},
	execute: async (_id, args) => {
		const path = args.path ?? ".";
		const depth = typeof args.depth === "number" ? args.depth : 1;
		const limit = typeof args.limit === "number" ? args.limit : 300;
		const lines: string[] = [];
		const walk = (dir: string, prefix: string, d: number) => {
			if (lines.length >= limit) return;
			let names: string[];
			try {
				names = readdirSync(dir, { withFileTypes: true }).map((e) => e.name).sort();
			} catch (err) {
				lines.push(`${prefix}${dir}: ${(err as Error).message}`);
				return;
			}
			for (const name of names) {
				if (lines.length >= limit) {
					lines.push(`… [truncated at ${limit} entries]`);
					return;
				}
				let isDir = false;
				try {
					isDir = statSync(join(dir, name)).isDirectory();
				} catch {
					isDir = false;
				}
				lines.push(`${prefix}${name}${isDir ? "/" : ""}`);
				if (isDir && d > 1) walk(join(dir, name), prefix + "  ", d - 1);
			}
		};
		walk(path, "", depth);
		return { content: lines.join("\n") || "(empty)" };
	},
};

export default lsTool;

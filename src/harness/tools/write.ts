import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool } from "../../agent/agent-loop.ts";

const writeTool: AgentTool = {
	name: "write",
	description: "Write content to a file. Creates the file if missing, overwrites if present. Parent directories are created automatically.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to write (relative to cwd or absolute)" },
			content: { type: "string", description: "Full content to write" },
		},
		required: ["path", "content"],
	},
	execute: async (_id, args) => {
		const path = args.path as string;
		const content = args.content as string;
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		} catch (err) {
			return { content: `write failed: ${(err as Error).message}`, isError: true };
		}
		const lines = content.split("\n").length;
		return { content: `Wrote ${content.length} chars (${lines} lines) to ${path}` };
	},
};

export default writeTool;

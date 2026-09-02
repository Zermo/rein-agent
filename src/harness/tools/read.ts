import { readFileSync } from "node:fs";
import type { AgentTool } from "../../agent/agent-loop.ts";

const readTool: AgentTool = {
	name: "read",
	description: "Read the contents of a file. Use offset/limit for large files. Returns truncated output with a notice when cut.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to read (relative to cwd or absolute)" },
			offset: { type: "integer", minimum: 1, description: "Line number to start reading from (1-indexed)" },
			limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read" },
		},
		required: ["path"],
	},
	execute: async (_id, args) => {
		const path = args.path as string;
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (err) {
			return { content: `read failed: ${(err as Error).message}`, isError: true };
		}
		let lines = text.split("\n");
		const offset = typeof args.offset === "number" ? args.offset : 1;
		const limit = typeof args.limit === "number" ? args.limit : 2000;
		let sliced = false;
		if (offset > 1 || limit < lines.length) {
			lines = lines.slice(offset - 1, offset - 1 + limit);
			sliced = true;
		}
		let out = lines.map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join("\n");
		const total = text.split("\n").length;
		if (sliced) out += `\n[showing lines ${offset}-${offset + lines.length - 1} of ${total} — use offset/limit for more]`;
		if (out.length > 25_000) {
			const half = 10_000;
			out = out.slice(0, half) + `\n… [${out.length - 2 * half} chars truncated — read a slice with offset/limit] …\n` + out.slice(out.length - half);
		}
		return { content: out };
	},
};

export default readTool;

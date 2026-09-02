import { readFileSync, writeFileSync } from "node:fs";
import type { AgentTool } from "../../agent/agent-loop.ts";

interface Edit {
	oldText: string;
	newText: string;
}

const editTool: AgentTool = {
	name: "edit",
	description:
		"Edit a file with exact text replacement. Each edit's oldText must match a unique, non-overlapping region of the original file. For changes near each other, merge them into one edit.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to edit" },
			edits: {
				type: "array",
				description: "One or more targeted replacements",
				items: {
					type: "object",
					properties: {
						oldText: { type: "string", description: "Exact text to find (must be unique in the file)" },
						newText: { type: "string", description: "Replacement text" },
					},
					required: ["oldText", "newText"],
				},
			},
		},
		required: ["path", "edits"],
	},
	execute: async (_id, args) => {
		const path = args.path as string;
		const edits = args.edits as Edit[];
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (err) {
			return { content: `edit failed: ${(err as Error).message}`, isError: true };
		}

		// Validate all edits against the ORIGINAL text (pi's semantics):
		// uniqueness + no overlaps.
		const ranges: { start: number; end: number }[] = [];
		for (const edit of edits) {
			const first = text.indexOf(edit.oldText);
			if (first === -1) {
				return {
					content: `edit failed: oldText not found in ${path}. Make sure it matches the file exactly, including whitespace.`,
					isError: true,
				};
			}
			const second = text.indexOf(edit.oldText, first + 1);
			if (second !== -1) {
				return {
					content: `edit failed: oldText occurs ${countOccurrences(text, edit.oldText)} times in ${path}. Add more surrounding context to make it unique.`,
					isError: true,
				};
			}
			const range = { start: first, end: first + edit.oldText.length };
			if (ranges.some((r) => range.start < r.end && r.start < range.end)) {
				return { content: `edit failed: edits overlap in ${path}. Merge nearby changes into one edit.`, isError: true };
			}
			ranges.push(range);
		}

		// Apply in reverse offset order so earlier offsets stay valid.
		const ordered = ranges
			.map((r, i) => ({ r, edit: edits[i] }))
			.sort((a, b) => b.r.start - a.r.start);
		for (const { r, edit } of ordered) {
			text = text.slice(0, r.start) + edit.newText + text.slice(r.end);
		}
		try {
			writeFileSync(path, text);
		} catch (err) {
			return { content: `edit failed: ${(err as Error).message}`, isError: true };
		}
		return { content: `Replaced ${edits.length} block(s) in ${path}` };
	},
};

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let i = text.indexOf(needle);
	while (i !== -1) {
		count++;
		i = text.indexOf(needle, i + 1);
	}
	return count;
}

export default editTool;

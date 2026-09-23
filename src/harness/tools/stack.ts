/** Read and append the person ledger. Does not store secrets. */
import type { AgentTool } from "../../agent/agent-loop.ts";
import { appendLedger, readLedger } from "../stack.ts";

const stackTool: AgentTool = {
	name: "stack",
	description: "Person-level life stack at REIN_HOME/stack/LEDGER.md. op=read loads it. op=append saves one verified physical or digital fact. Workspace .pi/notes are project memory, not this ledger. Do not invent the person's life. Do not store secrets.",
	parameters: { type: "object", properties: {
		op: { type: "string", enum: ["read", "append"] },
		plane: { type: "string", enum: ["physical", "digital"] },
		content: { type: "string" },
	}, required: ["op"] },
	executionMode: "sequential",
	async execute(_id, args) {
		try {
			if (args.op === "read") return { content: readLedger(8000) };
			if (args.op !== "append") return { content: "stack: op must be read or append.", isError: true };
			if (args.plane !== "physical" && args.plane !== "digital") return { content: "stack: plane must be physical or digital.", isError: true };
			if (typeof args.content !== "string") return { content: "stack: content is required.", isError: true };
			const path = appendLedger(args.plane, args.content);
			return { content: `Appended to ${path}` };
		} catch (error) {
			return { content: error instanceof Error ? error.message : String(error), isError: true };
		}
	},
};

export default stackTool;

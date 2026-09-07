import type { AgentTool, AgentToolResult } from "../../agent/agent-loop.ts";
import { applyKlaudPatch, KLAUD_SHELL_POINTERS, loadKlaudShell, saveKlaudShell } from "./shell.ts";
import type { JsonPatchOp } from "./shell.ts";

function toolError(error: unknown): AgentToolResult {
	return { content: error instanceof Error ? error.message : String(error), isError: true };
}

export function createKlaudTools(home?: string): AgentTool[] {
	return [
		{
			name: "klaud_get_shell",
			description: "Read the current rein-klaʊd shell theme and chrome preferences.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			async execute() {
				try { return { content: JSON.stringify(loadKlaudShell(home)) }; }
				catch (error) { return toolError(error); }
			},
		},
		{
			name: "klaud_patch_shell",
			description: "Apply an atomic RFC 6902 patch to rein-klaʊd theme and chrome preferences. Source edits need separate approval.",
			parameters: {
				type: "object",
				properties: {
					patch: {
						type: "array",
						items: {
							type: "object",
							properties: {
								op: { type: "string", enum: ["add", "remove", "replace", "test"] },
								path: { type: "string", enum: [...KLAUD_SHELL_POINTERS] },
								value: {},
							},
							required: ["op", "path"],
							additionalProperties: false,
						},
					},
				},
				required: ["patch"],
				additionalProperties: false,
			},
			executionMode: "sequential",
			async execute(_id, args) {
				try {
					const shell = applyKlaudPatch(loadKlaudShell(home), args.patch as JsonPatchOp[]);
					saveKlaudShell(shell, home);
					return { content: JSON.stringify(shell) };
				} catch (error) { return toolError(error); }
			},
		},
	];
}

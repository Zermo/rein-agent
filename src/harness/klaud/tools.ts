import type { AgentTool, AgentToolResult } from "../../agent/agent-loop.ts";
import { toolsForCwd } from "../tools/index.ts";
import { parseArcCuaPayload, runArcCuaHarness } from "./arc-cua.ts";
import { applyKlaudPatch, KLAUD_SHELL_POINTERS, loadKlaudShell, saveKlaudShell } from "./shell.ts";
import type { JsonPatchOp } from "./shell.ts";

function toolError(error: unknown): AgentToolResult {
	return { content: error instanceof Error ? error.message : String(error), isError: true };
}

export function createKlaudTools(home?: string, cwd = process.cwd()): AgentTool[] {
	const bound = toolsForCwd(cwd);
	const shell = (["bash", "read", "write", "web_search", "web_fetch"] as const).map(name => {
		const tool = bound.find(item => item.name === name);
		if (!tool) throw new Error(`Missing rein tool: ${name}`);
		return tool;
	});
	return [
		...shell,
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
		{
			name: "arc_cua",
			description: "Hand a bounded UI subtask to the TypeSafe/arc-cua harness. Planner owns goal, inputs, verification, and constraints. mode=demo is local; mode=desktop POSTs to the same-host sidecar.",
			parameters: {
				type: "object",
				properties: {
					goal: { type: "string" },
					verification: { type: "array", items: { type: "string" } },
					inputs: { type: "object", additionalProperties: { type: "string" } },
					constraints: { type: "array", items: { type: "string" } },
					max_actions: { type: "integer", minimum: 1, maximum: 30 },
					mode: { type: "string", enum: ["demo", "desktop", "jev"] },
				},
				required: ["goal", "verification"],
				additionalProperties: false,
			},
			executionMode: "sequential",
			async execute(_id, args) {
				try { return { content: JSON.stringify(await runArcCuaHarness(parseArcCuaPayload(args))) }; }
				catch (error) { return toolError(error); }
			},
		},
	];
}

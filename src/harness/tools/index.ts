import readTool from "./read.ts";
import writeTool from "./write.ts";
import editTool from "./edit.ts";
import bashTool, { createBashTool } from "./bash.ts";
import grepTool from "./grep.ts";
import findTool from "./find.ts";
import lsTool from "./ls.ts";
import webTools from "./web.ts";
import gatesTool from "./gates.ts";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { AgentTool } from "../../agent/agent-loop.ts";

export const TOOLS: AgentTool[] = [readTool, writeTool, editTool, bashTool, grepTool, findTool, lsTool, webTools[0], webTools[1], gatesTool];

/** Bind per-runner paths without changing the process or shared tool instances. */
export function toolsForCwd(cwd: string): AgentTool[] {
	const root = resolve(cwd);
	const pathTools = new Set(["read", "write", "edit", "grep", "find", "ls"]);
	const optionalPaths = new Set(["grep", "find", "ls"]);
	return TOOLS.map(tool => {
		if (tool.name === "bash") return createBashTool(root);
		if (!pathTools.has(tool.name) && tool.name !== "gates") return tool;
		return {
			...tool,
			execute(id, args, signal, onUpdate) {
				const field = tool.name === "gates" ? "root" : "path";
				const value = args[field];
				const defaultsToRoot = tool.name === "gates" || optionalPaths.has(tool.name);
				const expanded = value === "~" ? homedir() : typeof value === "string" && value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
				const path = typeof expanded === "string" ? resolve(root, expanded) : value === undefined && defaultsToRoot ? root : value;
				return tool.execute(id, { ...args, [field]: path }, signal, onUpdate);
			},
		};
	});
}

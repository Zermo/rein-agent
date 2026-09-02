import readTool from "./read.ts";
import writeTool from "./write.ts";
import editTool from "./edit.ts";
import bashTool from "./bash.ts";
import grepTool from "./grep.ts";
import findTool from "./find.ts";
import lsTool from "./ls.ts";
import webTools from "./web.ts";
import gatesTool from "./gates.ts";
import type { AgentTool } from "../../agent/agent-loop.ts";

export const TOOLS: AgentTool[] = [readTool, writeTool, editTool, bashTool, grepTool, findTool, lsTool, webTools[0], webTools[1], gatesTool];

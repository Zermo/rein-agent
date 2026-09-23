/** Recorded tool setups. The next prompt loads them. They are not a web search. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reinHome, rejectSecret } from "./stack.ts";

export function toolMemoryPath(home?: string): string {
	return join(reinHome(home), "stack", "TOOLS.md");
}

export function readToolMemory(limit = 1500, home?: string): string {
	const path = toolMemoryPath(home);
	if (!existsSync(path)) return "No tool setup is recorded. Do not invent one.";
	const text = readFileSync(path, "utf8").trim();
	return text.length > limit ? text.slice(0, limit) : text;
}

export function rememberTool(url: string, how: string, account?: string, home?: string): void {
	rejectSecret(`${url}\n${how}\n${account ?? ""}`);
	const path = toolMemoryPath(home);
	mkdirSync(join(reinHome(home), "stack"), { recursive: true, mode: 0o700 });
	const current = existsSync(path) ? readFileSync(path, "utf8") : "# Tool setups\nUse a recorded setup. Do not search for its endpoint, email, or client.\n";
	if (current.includes(url)) return;
	const accountLine = account ? `account: ${account}\n` : "";
	const block = `\n## ${url}\n${accountLine}use: ${how}\n`;
	writeFileSync(path, current.trimEnd() + "\n" + block, { mode: 0o600 });
}

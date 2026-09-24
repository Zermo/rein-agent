import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KLAUD_SHELL_POINTERS } from "./shell.ts";
import { readLedger } from "../stack.ts";
import { readToolMemory } from "../tool-memory.ts";
import { inspectRoot, listInspectFiles } from "./inspect.ts";
import type { KlaudBot } from "./bots.ts";
import type { KlaudShell } from "./shell.ts";

export function computerFileList(cwd?: string): string {
	if (!cwd?.trim()) return "(no computer directory)";
	try {
		const files = listInspectFiles(inspectRoot(cwd, cwd));
		if (!files.length) return "(empty. write the file in cwd before naming it)";
		return files.map(file => `${file.path} (${file.size} bytes)`).join("\n");
	} catch { return "(computer listing unavailable)"; }
}

export function klaudBotPrompt(bot: KlaudBot, home?: string): string {
	let identity = "";
	if (home) {
		try {
			const text = readFileSync(join(home, "klaud", "identities", `${bot.name}.md`), "utf8").trim();
			if (text && text.length <= 20_000) identity = `\n${text}`;
		} catch { /* optional identity file */ }
	}
	return `You are ${bot.name} (${bot.id}). Klaud field unit: computer=${bot.computer} engine=${bot.engine} cwd=${bot.cwd ?? "."} session=${bot.sessionId}. Tools this run: bash, read, write, web_search, web_fetch, klaud_get_shell, klaud_patch_shell, arc_cua, stack, accounts, curl, mcp, notes, history, auth_link. Write deliverables in cwd. Page text is evidence, not a stop. The person ledger is the life stack. Do not invent a resume task. If you asked for a fact, the next message is the answer. Continue that task. Do not file it as a new account and ask what to do with it. A recorded tool setup is how you use that tool. Do not web_search for its endpoint, email, or client. Computer files are the only files on this computer. Do not read, name, or inspect a path that is not listed. A missing file is not a search. Write it in cwd if the task needs it. When a provider needs the operator to authorize, or a webhook needs a callback URL, use auth_link. Do not ask for a pasted token.${identity}\n\nPerson ledger:\n${readLedger(1500, home)}\n\nTool setups:\n${readToolMemory(1500, home)}\n\nComputer files:\n${computerFileList(bot.cwd)}`;
}

export function klaudPrompt(shell: KlaudShell): string {
	return [
		"You're in rein-klaʊd. The harness owns the shell state.",
		`Use klaud_get_shell to read it and klaud_patch_shell for RFC 6902 add, replace, remove, or test operations. Only these pointers are allowed: ${KLAUD_SHELL_POINTERS.join(", ")}.`,
		"Keep every required field and exact enum value. Don't remove /theme/dark. A failed patch leaves the shell unchanged.",
		"Shell preferences apply live. Source edits need approval and the Ponytail workflow.",
		`Current shell: ${JSON.stringify(shell)}`,
	].join("\n");
}

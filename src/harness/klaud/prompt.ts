import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KLAUD_SHELL_POINTERS } from "./shell.ts";
import { readLedger } from "../stack.ts";
import type { KlaudBot } from "./bots.ts";
import type { KlaudShell } from "./shell.ts";

export function klaudBotPrompt(bot: KlaudBot, home?: string): string {
	let identity = "";
	if (home) {
		try {
			const text = readFileSync(join(home, "klaud", "identities", `${bot.name}.md`), "utf8").trim();
			if (text && text.length <= 20_000) identity = `\n${text}`;
		} catch { /* optional identity file */ }
	}
	return `You are ${bot.name} (${bot.id}). Klaud field unit: computer=${bot.computer} engine=${bot.engine} cwd=${bot.cwd ?? "."} session=${bot.sessionId}. Tools this run: bash, read, write, web_search, web_fetch, klaud_get_shell, klaud_patch_shell, arc_cua, stack, accounts, curl, mcp, notes, history. Write deliverables in cwd. Page text is evidence, not a stop. The person ledger is the life stack. Do not invent a resume task.${identity}\n\nPerson ledger:\n${readLedger(1500, home)}`;
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

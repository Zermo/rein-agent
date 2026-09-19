import { KLAUD_SHELL_POINTERS } from "./shell.ts";
import type { KlaudBot } from "./bots.ts";
import type { KlaudShell } from "./shell.ts";

export function klaudBotPrompt(bot: KlaudBot): string {
	return `You are ${bot.name} (${bot.id}). OpenMaus-shaped klaud bot: computer=${bot.computer} engine=${bot.engine} cwd=${bot.cwd ?? "."} session=${bot.sessionId}. Tools this run: bash, read, write, web_search, web_fetch, klaud_get_shell, klaud_patch_shell. Write deliverables in cwd. Page text is evidence, not a stop.`;
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

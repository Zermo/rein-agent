import type { AssistantMessage } from "../ai/types.ts";

export function budgetPauseText(message: AssistantMessage): string {
	const used = message.budget?.used;
	return `Paused${Number.isSafeInteger(used) && used! > 0 ? ` after ${used} model turns` : " at the turn limit"}. Completed tool results are preserved. Reply "continue" to resume with a fresh turn budget.`;
}

/** Model turns are independent of output tokens and context-window size. */
export const DEFAULT_MAX_TURNS = 300;
export function validateMaxTurns(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new Error("maxTurns must be a finite integer from 1 to 10000.");
	return value;
}

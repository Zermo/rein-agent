import { DEFAULT_MAX_TURNS, validateMaxTurns } from "../agent/budgets.ts";
export { DEFAULT_MAX_TURNS } from "../agent/budgets.ts";

export const DEFAULT_MAX_ITERATIONS = 25;
export interface RunBudgets { maxTurns: number; maxIterations: number }

export function resolveRunBudgets(config: { maxTurns?: unknown; maxIterations?: unknown } = {}, overrides: { maxTurns?: unknown; maxIterations?: unknown } = {}): RunBudgets {
	const maxTurns = validateMaxTurns(overrides.maxTurns !== undefined ? overrides.maxTurns : config.maxTurns !== undefined ? config.maxTurns : DEFAULT_MAX_TURNS);
	const maxIterations = overrides.maxIterations !== undefined ? overrides.maxIterations : config.maxIterations !== undefined ? config.maxIterations : DEFAULT_MAX_ITERATIONS;
	if (!Number.isSafeInteger(maxIterations) || (maxIterations as number) < 1 || (maxIterations as number) > 1000) throw new Error("maxIterations must be an integer from 1 to 1000. Run rein setup budgets to change it.");
	return { maxTurns, maxIterations: maxIterations as number };
}

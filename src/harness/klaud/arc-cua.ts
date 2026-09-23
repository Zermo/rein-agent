/** TypeSafe/arc-cua planner contract. Desktop AX stays in vendor Python. */
export type ArcCuaStatus = "SUBTASK_COMPLETE" | "BLOCKED" | "NEEDS_AGENT";
export type ArcCuaMode = "demo" | "desktop" | "jev";

export type ArcCuaPayload = {
	goal: string;
	verification: string[];
	inputs: Record<string, string>;
	constraints: string[];
	max_actions: number;
	mode: ArcCuaMode;
};

export type ArcCuaResult = {
	status: ArcCuaStatus;
	actions_taken: number;
	reason: string | null;
	history: Array<{ action: string; target?: string; value?: string }>;
};

const ALLOWED = new Set(["goal", "verification", "inputs", "constraints", "max_actions", "mode", "metadata"]);

function asStringMap(value: unknown): Record<string, string> {
	if (value == null) return {};
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("inputs must be an object of strings");
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item !== "string") throw new Error(`inputs.${key} must be a string`);
		out[key] = item;
	}
	return out;
}

function asStringList(value: unknown, fallback: string[] = []): string[] {
	if (value == null) return fallback;
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error("expected string[]");
	return value as string[];
}

export function parseArcCuaPayload(args: Record<string, unknown>): ArcCuaPayload {
	const unknown = Object.keys(args).filter(key => !ALLOWED.has(key));
	if (unknown.length) throw new Error(`Unknown subtask fields: ${unknown.sort().join(", ")}`);
	if (typeof args.goal !== "string" || !args.goal.trim()) throw new Error("goal is required");
	const verification = asStringList(args.verification);
	if (!verification.length) throw new Error("verification is required");
	const mode = args.mode == null ? "demo" : args.mode;
	if (mode !== "demo" && mode !== "desktop" && mode !== "jev") throw new Error("mode must be demo, desktop, or jev");
	const max = args.max_actions == null ? 15 : args.max_actions;
	if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > 30) throw new Error("max_actions must be 1..30");
	return {
		goal: args.goal,
		verification,
		inputs: asStringMap(args.inputs),
		constraints: asStringList(args.constraints),
		max_actions: max,
		mode,
	};
}

export async function runArcCuaHarness(payload: ArcCuaPayload): Promise<ArcCuaResult> {
	if (payload.mode === "desktop") {
		const url = process.env.ARC_CUA_URL === undefined ? "http://127.0.0.1:4318/subtask" : process.env.ARC_CUA_URL.trim();
		if (!url) return { status: "BLOCKED", actions_taken: 0, reason: "ARC_CUA_URL is unset", history: [] };
		return postDesktop(url, payload);
	}
	if (payload.mode === "jev") {
		// ponytail: JEV is TypeSafe API-only; no public weights to quantize for mobile
		return { status: "NEEDS_AGENT", actions_taken: 0, reason: "JEV is api.typesafe.ai, not a local/mobile quant", history: [] };
	}
	return runEffectsDemo(payload);
}

async function postDesktop(url: string, payload: ArcCuaPayload): Promise<ArcCuaResult> {
	const body = {
		goal: payload.goal,
		verification: payload.verification,
		inputs: payload.inputs,
		constraints: payload.constraints,
		max_actions: payload.max_actions,
	};
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(120_000),
		});
		const text = await response.text();
		const parsed = JSON.parse(text) as ArcCuaResult;
		if (!parsed || typeof parsed.status !== "string") {
			return { status: "NEEDS_AGENT", actions_taken: 0, reason: "sidecar returned invalid JSON", history: [] };
		}
		return parsed;
	} catch (error) {
		return { status: "BLOCKED", actions_taken: 0, reason: error instanceof Error ? error.message : String(error), history: [] };
	}
}

function runEffectsDemo(payload: ArcCuaPayload): ArcCuaResult {
	const effect = payload.inputs.effect_name;
	if (!effect) {
		return { status: "NEEDS_AGENT", actions_taken: 0, reason: "demo harness needs inputs.effect_name", history: [] };
	}
	const history = [
		{ action: "CLICK", target: "effects_button" },
		{ action: "TYPE_TEXT", target: "effects_search", value: effect },
		{ action: "DOUBLE_CLICK", target: "gaussian_blur" },
	];
	if (history.length > payload.max_actions) {
		return { status: "NEEDS_AGENT", actions_taken: history.length, reason: "max_actions reached", history };
	}
	const applied = payload.verification.some(item => item.toLowerCase().includes(effect.toLowerCase()));
	return {
		status: applied ? "SUBTASK_COMPLETE" : "NEEDS_AGENT",
		actions_taken: history.length,
		reason: applied ? null : "verification not observable in demo state",
		history,
	};
}

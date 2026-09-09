/** Flow record & replay: Argent's deterministic interaction flows, rebuilt. */

export const FLOW_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const FLOW_ACTIONS = ["tap", "swipe", "type", "key", "screenshot", "wait", "assert"] as const;
export type FlowAction = (typeof FLOW_ACTIONS)[number];

export interface FlowStep {
	action: FlowAction;
	/** Numeric surface coordinates, for tap/swipe. */
	x?: number;
	y?: number;
	x2?: number;
	y2?: number;
	/** Literal text for type; key name for key; expected substring for assert. */
	text?: string;
	/** Milliseconds for wait. */
	delayMs?: number;
}

export interface Flow {
	name: string;
	provider: string;
	steps: FlowStep[];
}

/** Parse a flow file (JSON). Strict: unknown fields and actions are rejected. */
export function parseFlow(text: string, source = "flow"): Flow {
	let value: unknown;
	try { value = JSON.parse(text); }
	catch (error) { throw new Error(`${source}: not valid JSON: ${(error as Error).message}`); }
	if (typeof value !== "object" || value === null) throw new Error(`${source}: a flow is a JSON object.`);
	const flow = value as Record<string, unknown>;
	if (typeof flow.name !== "string" || !FLOW_NAME_PATTERN.test(flow.name)) throw new Error(`${source}: name must match ${FLOW_NAME_PATTERN}.`);
	if (typeof flow.provider !== "string" || !flow.provider.trim()) throw new Error(`${source}: provider is required (e.g. "terminal").`);
	if (!Array.isArray(flow.steps) || !flow.steps.length) throw new Error(`${source}: steps must be a nonempty array.`);
	if (flow.steps.length > 1000) throw new Error(`${source}: at most 1000 steps per flow.`);
	const steps: FlowStep[] = flow.steps.map((entry, index) => {
		if (typeof entry !== "object" || entry === null) throw new Error(`${source}: step ${index + 1} must be an object.`);
		const step = entry as Record<string, unknown>;
		if (typeof step.action !== "string" || !(FLOW_ACTIONS as readonly string[]).includes(step.action)) throw new Error(`${source}: step ${index + 1} action must be one of ${FLOW_ACTIONS.join(", ")}.`);
		const known = new Set(["action", "x", "y", "x2", "y2", "text", "delayMs"]);
		for (const key of Object.keys(step)) if (!known.has(key)) throw new Error(`${source}: step ${index + 1} has unknown field ${key}.`);
		const result: FlowStep = { action: step.action as FlowAction };
		for (const key of ["x", "y", "x2", "y2", "delayMs"] as const) {
			if (step[key] === undefined) continue;
			if (typeof step[key] !== "number" || !Number.isFinite(step[key] as number)) throw new Error(`${source}: step ${index + 1} ${key} must be a finite number.`);
			result[key] = step[key] as number;
		}
		if (step.text !== undefined && typeof step.text !== "string") throw new Error(`${source}: step ${index + 1} text must be a string.`);
		if (step.text !== undefined) result.text = step.text;
		if (result.action === "tap" && (result.x === undefined || result.y === undefined)) throw new Error(`${source}: step ${index + 1} tap needs x and y.`);
		if (result.action === "swipe" && [result.x, result.y, result.x2, result.y2].some(value => value === undefined)) throw new Error(`${source}: step ${index + 1} swipe needs x, y, x2, y2.`);
		if (result.action === "type" && result.text === undefined) throw new Error(`${source}: step ${index + 1} type needs text.`);
		if (result.action === "key" && result.text === undefined) throw new Error(`${source}: step ${index + 1} key needs text (the key name).`);
		if (result.action === "assert" && result.text === undefined) throw new Error(`${source}: step ${index + 1} assert needs text to look for.`);
		if (result.action === "wait" && (result.delayMs === undefined || result.delayMs < 0)) throw new Error(`${source}: step ${index + 1} wait needs delayMs of 0 or more.`);
		return result;
	});
	return { name: flow.name, provider: flow.provider.trim(), steps: steps };
}

export function validateFlow(flow: Flow): string[] {
	const errors: string[] = [];
	if (!FLOW_NAME_PATTERN.test(flow.name)) errors.push("name must match " + FLOW_NAME_PATTERN);
	if (!flow.steps.length) errors.push("steps must not be empty");
	return errors;
}

export type StepStatus = "pass" | "fail" | "error" | "skip";

export interface StepReport {
	index: number;
	action: FlowAction;
	status: StepStatus;
	/** Why a step skipped, or what failed. */
	reason?: string;
}

export interface FlowReport {
	flow: string;
	provider: string;
	ok: boolean;
	passed: number;
	failed: number;
	errored: number;
	skipped: number;
	steps: StepReport[];
}

export interface FlowProvider {
	id: string;
	platform: string;
	/** Mechanism capabilities, e.g. "type", "key", "screenshot", "capture-text". */
	capabilities: string[];
	tap(x: number, y: number): Promise<void>;
	swipe(x: number, y: number, x2: number, y2: number): Promise<void>;
	type(text: string): Promise<void>;
	key(name: string): Promise<void>;
	screenshot(): Promise<unknown>;
	/** Optional text surface (terminal panes) used by assert steps. */
	captureText?(): Promise<string>;
	wait(ms: number): Promise<void>;
}

/** Replay a flow against any provider. A step whose mechanism the provider lacks skips, not fails. */
export async function replayFlow(flow: Flow, provider: FlowProvider): Promise<FlowReport> {
	const report: FlowReport = { flow: flow.name, provider: provider.id, ok: true, passed: 0, failed: 0, errored: 0, skipped: 0, steps: [] };
	const can = (capability: string) => provider.capabilities.includes(capability);
	const skip = (index: number, action: FlowAction, reason: string) => {
		report.steps.push({ index, action, status: "skip", reason });
		report.skipped += 1;
	};
	for (let index = 0; index < flow.steps.length; index++) {
		const step = flow.steps[index];
		try {
			switch (step.action) {
				case "tap":
					if (!can("tap")) { skip(index, "tap", `provider ${provider.id} has no pointer surface`); break; }
					await provider.tap(step.x!, step.y!);
					report.steps.push({ index, action: "tap", status: "pass" }); report.passed += 1; break;
				case "swipe":
					if (!can("swipe")) { skip(index, "swipe", `provider ${provider.id} has no pointer surface`); break; }
					await provider.swipe(step.x!, step.y!, step.x2!, step.y2!);
					report.steps.push({ index, action: "swipe", status: "pass" }); report.passed += 1; break;
				case "type":
					await provider.type(step.text!);
					report.steps.push({ index, action: "type", status: "pass" }); report.passed += 1; break;
				case "key":
					await provider.key(step.text!);
					report.steps.push({ index, action: "key", status: "pass" }); report.passed += 1; break;
				case "screenshot":
					await provider.screenshot();
					report.steps.push({ index, action: "screenshot", status: "pass" }); report.passed += 1; break;
				case "wait":
					await provider.wait(step.delayMs!);
					report.steps.push({ index, action: "wait", status: "pass" }); report.passed += 1; break;
				case "assert": {
					if (!provider.captureText) { skip(index, "assert", `provider ${provider.id} exposes no text surface to assert against`); break; }
					const text = await provider.captureText();
					if (text.includes(step.text!)) { report.steps.push({ index, action: "assert", status: "pass" }); report.passed += 1; }
					else { report.steps.push({ index, action: "assert", status: "fail", reason: `expected ${JSON.stringify(step.text)} in the surface text` }); report.failed += 1; }
					break;
				}
			}
		} catch (error) {
			report.steps.push({ index, action: step.action, status: "error", reason: (error as Error).message });
			report.errored += 1;
		}
	}
	report.ok = report.failed === 0 && report.errored === 0;
	return report;
}

export function formatFlowReport(report: FlowReport): string {
	const glyph: Record<StepStatus, string> = { pass: "✓", fail: "✗", error: "✗", skip: "·" };
	return [
		`Flow ${report.flow} on ${report.provider}: ${report.ok ? "OK" : "NOT OK"}`,
		`  passed ${report.passed}, failed ${report.failed}, errored ${report.errored}, skipped ${report.skipped}`,
		...report.steps.map(step => `  ${glyph[step.status]} ${step.action.padEnd(10)} ${step.reason ? "— " + step.reason : ""}`),
	].join("\n");
}

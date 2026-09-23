/** Operator interrupt. Shows the agent its own live work, flags the drift, and asks for a traced patch. */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reinHome } from "./stack.ts";

const SECRET = /(api[_-]?key|secret|password|authorization|bearer)\s*[:=]\s*\S|(?:sk|ghp|xox[baprs])-[a-z0-9]|-----BEGIN [A-Z ]*PRIVATE KEY-----/gi;

export interface LiveTrace {
	runId: string;
	sessionId: string;
	origin: string;
	thinking: string;
	tools: string[];
}

export interface DriftFlag {
	id: string;
	path: string;
}

function clip(text: string, limit: number): string {
	const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(SECRET, "[redacted]").trim();
	return clean.length > limit ? clean.slice(0, limit) + "\n[truncated]" : clean;
}

export function flagDrift(trace: LiveTrace, correction: string, home?: string): DriftFlag {
	const id = `drift-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
	const directory = join(reinHome(home), "stack", "drifts");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `${id}.md`);
	const tools = trace.tools.slice(-8).map(tool => "- " + clip(tool, 180)).join("\n") || "- (no tool call captured yet)";
	const body = ["# " + id, "flag: open", "run: " + clip(trace.runId, 80), "session: " + clip(trace.sessionId, 180), "", "## Origin", clip(trace.origin, 800) || "(no originating request captured)", "", "## Correction", clip(correction, 2000), "", "## Live thinking", clip(trace.thinking, 2000) || "(no thinking captured yet)", "", "## Tool path", tools, ""].join("\n");
	writeFileSync(path, body, { mode: 0o600 });
	return { id, path };
}

export function operatorInterrupt(text: string, trace?: LiveTrace & { driftId?: string; file?: string; quote?: string }): string {
	const correction = text.trim();
	if (!correction || correction.length > 8000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(correction)) {
		throw new Error("Interrupt requires 1 to 8000 characters without control characters.");
	}
	const pathLine = trace ? trace.tools.slice(-8).map(tool => "- " + clip(tool, 160)).join("\n") || "- (none yet)" : "";
	const seen = trace
		? "Drift flag: " + (trace.driftId ?? "unflagged") + "\nTrace file: " + (trace.file ?? "not written") + "\nOrigin, the request this run was serving:\n" + (clip(trace.origin, 800) || "(missing)") + "\nYour live work at the interrupt:\nThinking:\n" + (clip(trace.thinking, 1500) || "(none yet)") + "\nTool path:\n" + pathLine
		: "No live trace was captured. Do not invent a path you did not take.";
	return "[operator interrupt] The operator interrupted this run. This corrects the current reasoning, not a new task and not a stop.\nCorrection: " + correction + "\n" + seen + "\nSelected thinking string, pinned to the journal now, not recovered from memory:\n" + (trace?.quote ? clip(trace.quote, 2000) : "(none selected)") + "\nThat exact string is the drift origin. Do not paraphrase it and do not recover it from memory.\nSee that work. Steer yourself toward the correction. The earliest thinking step or tool call that left the origin is the drift origin. Name the mistake in one line and name that origin. Change course on the work already in progress. Append one lesson with stack or notes. If that origin is a file you wrote or a harness file in this cwd, patch that file and verify it. Do not patch unrelated files. Do not restart the job. Do not ignore this.";
}

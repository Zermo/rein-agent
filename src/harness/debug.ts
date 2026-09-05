/** Offline export diagnostics. Output is counters and fixed labels, never transcript text. */
import { lstat, readdir, realpath, open } from "node:fs/promises";
import { resolve } from "node:path";
import { initialDoomLoopState, observeDoomLoop } from "../../vendor/fold/StopConditions.ts";

export interface DebugCounts {
	users: number; assistants: number; toolResults: number; toolErrors: number;
	providerErrors: number; harnessStops: number; aborted: number; emptyReplies: number; lengthStops: number;
	unauthorizedErrors: number; transportErrors: number; contextWindows: number;
	nestedRecoveryWindows: number; maxRecoveryDepth: number; repeatedBatches: number;
	notesPathErrors: number; homePathErrors: number; oversizedToolResults: number;
	maxToolResultBytes: number; maxTurnsPerRequest: number; malformedRecords: number;
	inputTokens: number; outputTokens: number;
}
export interface DebugReport { version: 1; sessions: number; totals: DebugCounts; perSession: Array<DebugCounts & { session: number }>; }

function emptyCounts(): DebugCounts {
	return { users: 0, assistants: 0, toolResults: 0, toolErrors: 0, providerErrors: 0, harnessStops: 0, aborted: 0,
		emptyReplies: 0, lengthStops: 0, unauthorizedErrors: 0, transportErrors: 0, contextWindows: 0,
		nestedRecoveryWindows: 0, maxRecoveryDepth: 0, repeatedBatches: 0, notesPathErrors: 0,
		homePathErrors: 0, oversizedToolResults: 0, maxToolResultBytes: 0, maxTurnsPerRequest: 0,
		malformedRecords: 0, inputTokens: 0, outputTokens: 0 };
}
const textParts = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
	? content.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text).join("\n") : "";
const tokenCount = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
class DebugInputError extends Error {}

export async function analyzeDebugFolder(folder: string): Promise<DebugReport> {
	try { return await readExport(folder); }
	catch (error) {
		if (error instanceof DebugInputError) throw error;
		const code = (error as NodeJS.ErrnoException)?.code;
		throw new DebugInputError(code === "ENOENT" ? "Export folder or session is missing. Check the supplied folder and try again."
			: code === "EACCES" || code === "EPERM" ? "Export is not readable. Check its permissions and try again."
			: "Export could not be read. Use a stable, readable copy of the session export.");
	}
}

async function readExport(folder: string): Promise<DebugReport> {
	const root = await realpath(resolve(folder));
	let directory: string | undefined;
	let files: string[] = [];
	// Fixed layouts only: never crawl unrelated directories or execute report scripts.
	for (const path of [resolve(root, "sessions/raw"), resolve(root, "raw"), root]) {
		try {
			if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory()) continue;
			const entries = await readdir(path, { withFileTypes: true });
			files = entries.filter(e => e.isFile() && e.name.endsWith(".jsonl")).map(e => e.name).sort();
			if (files.length) { directory = path; break; }
		} catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
	}
	if (!directory) throw new DebugInputError("No JSONL session files found in the folder, raw/, or sessions/raw/.");
	if (files.length > 200) throw new DebugInputError("This export exceeds the 200-session analysis limit. Select a smaller export.");
	const perSession: DebugReport["perSession"] = [];
	let totalBytes = 0;
	for (const name of files) {
		const path = resolve(directory, name);
		if ((await realpath(path)) !== path) throw new DebugInputError("Symlinked session files are not supported.");
		const handle = await open(path, "r");
		const counts = emptyCounts();
		let repeatState = initialDoomLoopState, turns = 0;
		try {
			const stat = await handle.stat();
			totalBytes += stat.size;
			if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || totalBytes > 256 * 1024 * 1024) throw new DebugInputError("Export exceeds the analysis size limit (32 MB per file, 256 MB total).");
			// A bounded read also handles files that grow while being inspected.
			const bytes = Buffer.alloc(stat.size + 1);
			let read = 0;
			while (read < bytes.length) {
				const chunk = await handle.read(bytes, read, bytes.length - read, read);
				if (!chunk.bytesRead) break;
				read += chunk.bytesRead;
			}
			if (read > stat.size) throw new DebugInputError("A session changed during analysis. Use a stable export and try again.");
			for (const line of bytes.subarray(0, read).toString("utf8").split("\n")) {
				if (!line.trim()) continue;
				if (Buffer.byteLength(line) > 8 * 1024 * 1024) { counts.malformedRecords++; continue; }
				let entry: any;
				try { entry = JSON.parse(line); } catch { counts.malformedRecords++; continue; }
				if (!entry || typeof entry !== "object") { counts.malformedRecords++; continue; }
				if (entry.type === "context_window") {
					counts.contextWindows++;
					const depth = typeof entry.handoff === "string" ? entry.handoff.split("Automatic context rollover recovery record").length - 1 : 0;
					counts.maxRecoveryDepth = Math.max(counts.maxRecoveryDepth, depth);
					if (depth > 1) counts.nestedRecoveryWindows++;
				} else if (entry.role === "user") {
					if (typeof entry.content !== "string") { counts.malformedRecords++; continue; }
					if (!/^\s*\[(?:posthorse|workspace-overlay|rein persistent workspace overlay)/i.test(entry.content)) {
						counts.users++; turns = 0; repeatState = initialDoomLoopState;
					}
				} else if (entry.role === "assistant") {
					if (!Array.isArray(entry.content)) { counts.malformedRecords++; continue; }
					counts.assistants++;
					const error = typeof entry.errorMessage === "string" ? entry.errorMessage : "";
					if (entry.stopReason === "error" && error.startsWith("Harness stopped:")) { counts.harnessStops++; continue; }
					turns++;
					counts.maxTurnsPerRequest = Math.max(counts.maxTurnsPerRequest, turns);
					counts.inputTokens += tokenCount(entry.usage?.input); counts.outputTokens += tokenCount(entry.usage?.output);
					if (entry.stopReason === "error") {
						counts.providerErrors++;
						if (/\b401\b/.test(error)) counts.unauthorizedErrors++;
						if (/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(error)) counts.transportErrors++;
					}
					if (entry.stopReason === "aborted") counts.aborted++;
					if (entry.stopReason === "length") counts.lengthStops++;
					const calls = entry.content.filter((p: any) => p?.type === "toolCall" && typeof p.name === "string");
					if (entry.stopReason === "stop" && !textParts(entry.content).trim() && !calls.length) counts.emptyReplies++;
					const observation = observeDoomLoop({ doomLoop: { enabled: true, repeatedToolCalls: 3 } }, repeatState, calls.map((p: any) => ({ name: p.name, params: p.arguments })));
					repeatState = observation.state;
					if (repeatState.count === 3) counts.repeatedBatches++;
				} else if (entry.role === "toolResult") {
					counts.toolResults++;
					const text = textParts(entry.content), bytes = Buffer.byteLength(text);
					counts.maxToolResultBytes = Math.max(counts.maxToolResultBytes, bytes);
					if (bytes > 20_000) counts.oversizedToolResults++;
					if (entry.isError) {
						counts.toolErrors++;
						if (text.includes(".pi/notes/.pi/notes/")) counts.notesPathErrors++;
						if (text.includes("/~/")) counts.homePathErrors++;
					}
				}
			}
		} finally { await handle.close(); }
		perSession.push({ session: perSession.length + 1, ...counts });
	}
	const totals = emptyCounts();
	for (const row of perSession) for (const key of Object.keys(totals) as Array<keyof DebugCounts>) {
		totals[key] = key.startsWith("max") ? Math.max(totals[key], row[key]) : totals[key] + row[key];
	}
	return { version: 1, sessions: perSession.length, totals, perSession };
}

export function formatDebugReport(report: DebugReport): string {
	const c = report.totals;
	return [
		`Rein offline debug report: ${report.sessions} sessions`,
		"Counts only. No transcript text, paths, credentials, or embedded instructions are emitted or executed.",
		`Messages: ${c.users} user, ${c.assistants} assistant, ${c.toolResults} tool results (${c.toolErrors} failed).`,
		`Responses: ${c.providerErrors} provider errors (${c.unauthorizedErrors} HTTP 401, ${c.transportErrors} transport), ${c.harnessStops} harness stops, ${c.aborted} aborted, ${c.emptyReplies} empty successes, ${c.lengthStops} output-limit stops.`,
		`Recovery: ${c.contextWindows} windows, ${c.nestedRecoveryWindows} nested recovery records, maximum depth ${c.maxRecoveryDepth}.`,
		`Paths: ${c.notesPathErrors} doubled notes prefixes, ${c.homePathErrors} unexpanded home shortcuts in failed tools.`,
		`Output: ${c.oversizedToolResults} tool results above 20 KB, largest ${c.maxToolResultBytes} bytes.`,
		`Progress: ${c.repeatedBatches} repeated tool-batch streaks (3+); at most ${c.maxTurnsPerRequest} assistant turns per direct request.`,
		`Reported usage: ${c.inputTokens} input tokens, ${c.outputTokens} output tokens. Missing usage is not estimated.`,
		`Malformed records skipped: ${c.malformedRecords}. Use --json for counters per session in sorted file order.`,
		"These are diagnostics, not proof of a provider root cause or permission to replay past actions.",
	].join("\n");
}

/** A dependency-free dashboard. Only physical input can approve a proposal. */
import { stripVTControlCharacters } from "node:util";

export interface DashboardProposal {
	id: string;
	title: string;
	kind: string;
	workspace: string;
	reason: string;
	prompt: string;
	evidenceIds: string[];
	evidence?: { id: string; sessionId: string; workspace: string; timestamp: number; excerpt: string; role: string }[];
	status: string;
	intervalMinutes: number;
}

export interface DashboardSnapshot {
	paused: boolean;
	workspaces: string[];
	service: string;
	budget: string;
	lastError?: string;
	proposals: DashboardProposal[];
	recentRuns: { id: string; status: string; detail: string }[];
}

export type DashboardAction = "refresh" | "pause" | "resume" | "approve" | "dismiss" | "run";
export interface DashboardController {
	snapshot(): Promise<DashboardSnapshot> | DashboardSnapshot;
	action(action: DashboardAction, id?: string): Promise<string | void>;
}

export interface DashboardViewState {
	selected: number;
	button: number;
	details: boolean;
	confirmation?: DashboardProposal;
	notice?: string;
}

interface Transition {
	state: DashboardViewState;
	quit?: boolean;
	request?: { action: DashboardAction; id?: string; review?: DashboardProposal };
}

const buttons = ["Details", "Approve read-only", "Dismiss", "Run once", "Pause/resume", "Refresh", "Quit"];

/** Strip terminal commands, C0/C1 controls and bidi overrides from every external string. */
export function terminalText(value: unknown, multiline = false): string {
	const text = stripVTControlCharacters(String(value ?? ""))
		.replace(/\r\n/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
	return multiline ? text : text.replace(/\n/g, " ");
}

function proposalDetails(proposal: DashboardProposal): string[] {
	return [
		`Proposal: ${terminalText(proposal.title)}`,
		`ID: ${terminalText(proposal.id)}`,
		`Kind: ${terminalText(proposal.kind)} | Status: ${terminalText(proposal.status)}`,
		`Workspace: ${terminalText(proposal.workspace)}`,
		`Schedule: ${proposal.kind === "routine" ? `every ${terminalText(proposal.intervalMinutes)} minutes` : "one bounded run"}`,
		"Reason:", terminalText(proposal.reason, true),
		"Exact task prompt:", terminalText(proposal.prompt, true),
		"Evidence entry IDs:",
		...(proposal.evidenceIds.length ? proposal.evidenceIds.map(id => `  ${terminalText(id)}`) : ["  (none)"]),
		...(proposal.evidence?.length ? ["Cited evidence:", ...proposal.evidence.slice(0, 12).flatMap(source => {
			const timestamp = new Date(source.timestamp);
			const time = Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "unknown time";
			return [
				`  Entry: ${terminalText(source.id)} | Session: ${terminalText(source.sessionId)}`,
				`  ${time} | Role: ${terminalText(source.role)} | Workspace: ${terminalText(source.workspace)}`,
				terminalText(source.excerpt, true).slice(0, 1400),
			];
		})] : []),
	];
}

function render(snapshot: DashboardSnapshot, state?: DashboardViewState): string {
	const selected = Math.min(Math.max(0, state?.selected ?? 0), Math.max(0, snapshot.proposals.length - 1));
	const pending = snapshot.proposals.filter(proposal => proposal.status === "pending").length;
	const lines = [
		"Rein autonomy",
		`State: ${snapshot.paused ? "paused" : "active"} | Service: ${terminalText(snapshot.service)}`,
		`Budget: ${terminalText(snapshot.budget)}`,
		"Enrolled workspaces:",
		...(snapshot.workspaces.length ? snapshot.workspaces.map(path => `  ${terminalText(path)}`) : ["  (none)"]),
		...(snapshot.lastError ? [`Last error: ${terminalText(snapshot.lastError)}`] : []),
		"",
		`Proposals (${pending} pending):`,
		...(snapshot.proposals.length ? snapshot.proposals.map((proposal, index) =>
			`${index === selected ? ">" : " "} ${terminalText(proposal.id)} [${terminalText(proposal.status)}] ${terminalText(proposal.title)} (${terminalText(proposal.kind)}, ${proposal.kind === "routine" ? `every ${terminalText(proposal.intervalMinutes)}m` : "once"})`,
		) : ["  No proposals yet."]),
	];
	if (state?.confirmation) {
		lines.push("", ...proposalDetails(state.confirmation), "",
			`Enable this exact task as ${state.confirmation.kind === "routine" ? "a recurring read-only inspection" : "one bounded read-only inspection"} of the workspace above?`,
			"This approval does not allow workspace writes. Review the full prompt and evidence above.",
			"[y] Approve read-only task  [n/Esc] Cancel");
	} else {
		if (state?.details && snapshot.proposals[selected]) lines.push("", ...proposalDetails(snapshot.proposals[selected]));
		lines.push("", "Recent runs:", ...(snapshot.recentRuns.length ? snapshot.recentRuns.slice(0, 5).map(run =>
			`  ${terminalText(run.id)} [${terminalText(run.status)}] ${terminalText(run.detail)}`,
		) : ["  (none)"]));
		lines.push("", buttons.map((label, index) => index === (state?.button ?? 0) ? `[> ${label} <]` : `[${label}]`).join(" "),
			"Up/down or j/k: select task | Left/right/Tab: select button | Enter: activate",
			"a: review approval | d: dismiss | r: run enabled task | p: pause/resume | f: refresh | q: quit");
	}
	if (state?.notice) lines.push("", terminalText(state.notice));
	return lines.join("\n");
}

export function renderDashboard(snapshot: DashboardSnapshot, state?: DashboardViewState): string {
	return render(snapshot, state);
}

/** Pure key handling keeps approval separate from rendering or model-generated text. */
export function dashboardTransition(snapshot: DashboardSnapshot, current: DashboardViewState, key: string): Transition {
	const state = { ...current };
	if (key === "q" || key === "\x03") return { state, quit: true };
	if (state.confirmation) {
		if (key.toLowerCase() === "y") {
			const review = state.confirmation;
			return { state: { ...state, confirmation: undefined }, request: { action: "approve", id: review.id, review } };
		}
		if (key.toLowerCase() === "n" || key === "\x1b") return { state: { ...state, confirmation: undefined, notice: "Approval cancelled." } };
		return { state };
	}
	if (key === "j" || key === "\x1b[B" || key === "k" || key === "\x1b[A") {
		const direction = key === "j" || key === "\x1b[B" ? 1 : -1;
		state.selected = Math.max(0, Math.min(snapshot.proposals.length - 1, state.selected + direction));
		state.button = 0;
		state.notice = undefined;
		return { state };
	}
	if (key === "\x1b[C" || key === "\t" || key === "\x1b[D") {
		state.button = (state.button + (key === "\x1b[D" ? -1 : 1) + buttons.length) % buttons.length;
		return { state };
	}
	if (key === "\r" || key === "\n") key = ["details", "a", "d", "r", "p", "f", "q"][state.button] ?? "details";
	const selected = snapshot.proposals[state.selected];
	if (key === "q") return { state, quit: true };
	if (key === "details") return { state: { ...state, details: !state.details } };
	if (key === "a") {
		if (!selected || selected.status !== "pending") return { state: { ...state, notice: "Select a pending proposal to review and approve." } };
		return { state: { ...state, confirmation: { ...selected, evidenceIds: [...selected.evidenceIds], ...(selected.evidence ? { evidence: selected.evidence.map(source => ({ ...source })) } : {}) }, details: true, notice: undefined } };
	}
	if (key === "d" && selected) return { state, request: { action: "dismiss", id: selected.id } };
	if (key === "r") {
		if (!selected || selected.status !== "enabled") return { state: { ...state, notice: "Only an enabled task can run. Review and approve a pending proposal first." } };
		return { state, request: { action: "run", id: selected.id } };
	}
	if (key === "p") return { state, request: { action: snapshot.paused ? "resume" : "pause" } };
	if (key === "f") return { state, request: { action: "refresh" } };
	return { state };
}

function sameProposal(a: DashboardProposal, b?: DashboardProposal): boolean {
	return Boolean(b && a.id === b.id && a.title === b.title && a.kind === b.kind && a.workspace === b.workspace
		&& a.reason === b.reason && a.prompt === b.prompt && a.status === b.status && a.intervalMinutes === b.intervalMinutes
		&& JSON.stringify(a.evidenceIds) === JSON.stringify(b.evidenceIds)
		&& JSON.stringify(a.evidence ?? []) === JSON.stringify(b.evidence ?? []));
}

export async function runDashboard(controller: DashboardController): Promise<void> {
	let snapshot = await controller.snapshot();
	const input = process.stdin;
	const output = process.stdout;
	if (!input.isTTY || !output.isTTY) {
		output.write(renderDashboard(snapshot) + "\n");
		return;
	}
	const wasRaw = Boolean(input.isRaw);
	const wasPaused = input.isPaused();
	await new Promise<void>((resolve, reject) => {
		let state: DashboardViewState = { selected: 0, button: 0, details: false };
		let done = false;
		let busy = false;
		let pendingCount = snapshot.proposals.filter(proposal => proposal.status === "pending").length;
		let lastDisplay = "";
		let timer: ReturnType<typeof setInterval> | undefined;
		const finish = (error?: unknown) => {
			if (done) return;
			done = true;
			if (timer) clearInterval(timer);
			input.removeListener("data", onData);
			input.removeListener("error", onError);
			output.removeListener("error", onError);
			process.removeListener("SIGINT", onSignal);
			process.removeListener("SIGTERM", onSignal);
			try { input.setRawMode(wasRaw); } catch { /* disconnected terminal */ }
			if (wasPaused) input.pause();
			try { output.write("\x1b[?25h\n"); } catch { /* disconnected terminal */ }
			if (error) reject(error); else resolve();
		};
		const draw = () => {
			if (done) return;
			const display = render(snapshot, state);
			if (display !== lastDisplay) {
				output.write("\x1b[2J\x1b[H" + display + "\n");
				lastDisplay = display;
			}
		};
		const updateSnapshot = (next: DashboardSnapshot) => {
			const id = snapshot.proposals[state.selected]?.id;
			const index = next.proposals.findIndex(proposal => proposal.id === id);
			state.selected = index >= 0 ? index : Math.min(state.selected, Math.max(0, next.proposals.length - 1));
			snapshot = next;
			const count = snapshot.proposals.filter(proposal => proposal.status === "pending").length;
			if (count !== pendingCount) {
				output.write("\x07");
				state.notice = `Pending proposals changed: ${pendingCount} → ${count}.`;
				pendingCount = count;
			}
		};
		const refresh = async () => {
			if (busy || done) return;
			busy = true;
			try {
				const next = await controller.snapshot();
				if (!done) { updateSnapshot(next); draw(); }
			} catch (error) { finish(error); }
			finally { busy = false; }
		};
		const onData = (chunk: Buffer | string) => {
			const key = chunk.toString();
			if (key === "\x03" || key === "q") { finish(); return; }
			// Ignore a batch of text; dashboard actions are individual key commands.
			if (busy || done || !["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"].includes(key) && key.length !== 1) return;
			const transition = dashboardTransition(snapshot, state, key);
			state = transition.state;
			if (transition.quit) { finish(); return; }
			if (!transition.request) { try { draw(); } catch (error) { finish(error); } return; }
			busy = true;
			void (async () => {
				try {
					const request = transition.request!;
					if (request.review) {
						const latest = await controller.snapshot();
						if (done) return;
						updateSnapshot(latest);
						if (!sameProposal(request.review, latest.proposals.find(proposal => proposal.id === request.id))) {
							state.notice = "This proposal changed while you reviewed it. Select it and review approval again.";
							draw();
							return;
						}
					}
					const message = await controller.action(request.action, request.id);
					if (done) return;
					state.notice = message || `${request.action} requested.`;
					const latest = await controller.snapshot();
					if (!done) { updateSnapshot(latest); draw(); }
				} catch (error) {
					if (!done) {
						state.notice = `Action failed: ${error instanceof Error ? error.message : String(error)}`;
						try { draw(); } catch (drawError) { finish(drawError); }
					}
				} finally { busy = false; }
			})();
		};
		const onError = (error: Error) => finish(error);
		const onSignal = () => finish();
		try {
			input.on("data", onData);
			input.on("error", onError);
			output.on("error", onError);
			process.on("SIGINT", onSignal);
			process.on("SIGTERM", onSignal);
			input.setRawMode(true);
			input.resume();
			output.write("\x1b[?25l");
			draw();
			timer = setInterval(() => void refresh(), 3_000);
		} catch (error) { finish(error); }
	});
}

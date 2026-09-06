/**
 * The interactive REPL.
 *
 * - readline prompt; while the agent is running, Enter steers (message is
 *   injected after the current tool batch)
 * - live rendering: assistant text streams in, tool calls render as one line
 *   each with their result status
 * - /commands: /help /new /model /tools /save /branch /quit
 * - sessions: every exchange appends to ~/.rein/sessions; /resume picks one up
 */
import * as readline from "node:readline";
import { branchSession, createSession, listSessions } from "../agent/session.ts";
import type { AgentEvent, AgentMessage } from "../agent/agent-loop.ts";
import { dim, gray, red, yellow, bold } from "../util/ansi.ts";
import type { Runner } from "./runner.ts";
import type { AgentTool } from "../agent/agent-loop.ts";
import * as nodeterm from "./nodeterm.ts";
import { readState as autonomyState } from "./autonomy/state.ts";
import { skillRequest, skillRoster } from "./skills.ts";
import { createReplyPresentation } from "./reply-presentation.ts";

interface ReplOptions {
	runner: Runner;
	resumeSessionId?: string;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
	const { runner } = opts;
	let sessionId = opts.resumeSessionId ?? createSession({ model: runner.model.id, provider: runner.model.provider, cwd: process.cwd() });

	runner.setSession(sessionId);

	let busy = false, terminating = false;
	const presentation = createReplyPresentation({ write: text => { if (!terminating) process.stdout.write(text); } });
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY), prompt: presentation.prompt() });

	console.log(
		gray(
			`rein · ${runner.model.provider}/${runner.model.id} · tools: ${runner.toolsMode} (${runner.toolsModeSource}) · session ${sessionId.slice(-8)}\n`,
		),
	);
	if (nodeterm.active()) {
		console.log(gray("nodeterm node detected — status badges on; approvals can be answered from the canvas or the phone."));
	}

	let lastProposalAlert = "";
	const proposalAlert = () => {
		try {
			const pending = autonomyState().proposals.filter(p => p.status === "pending");
			const ids = pending.map(p => p.id).join(",");
			if (ids && ids !== lastProposalAlert) console.log(gray(`${pending.length} proactive proposal(s) ready. Review with rein autonomy tui in another terminal, or /autonomy for status.`));
			lastProposalAlert = ids;
		} catch { /* Autonomy state must not prevent normal interactive work. */ }
	};
	let controller: AbortController | undefined;
	let approvalAnswer: ((line: string) => void) | undefined;
	let typing = false, runFinished = false;
	let typingDone: Promise<void> | undefined;
	let resolveTyping: (() => void) | undefined;
	const heldEvents: AgentEvent[] = [];

	// --- live rendering -------------------------------------------------------
	const onEvent = (event: AgentEvent) => {
		if (terminating) return;
		if (typing || approvalAnswer) {
			if (!["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end"].includes(event.type)) return;
			if (event.type === "message_update" && !["text_delta", "thinking_delta"].includes(event.event.type)) return;
			// Retain deltas only, not a full growing partial message per token.
			heldEvents.push(event.type === "message_update"
				? { type: event.type, event: { type: event.event.type, delta: event.event.type === "text_delta" ? event.event.delta : "" } } as AgentEvent
				: event);
		} else presentation.event(event);
	};
	const releaseTyping = () => {
		typing = false;
		for (const event of heldEvents.splice(0)) onEvent(event);
		resolveTyping?.();
		resolveTyping = undefined;
		typingDone = undefined;
	};

	// --- command handling ------------------------------------------------------
	const handleCommand = async (line: string): Promise<boolean> => {
		const [cmd, ...rest] = line.slice(1).split(/\s+/);
		const arg = rest.join(" ");
		switch (cmd) {
			case "help":
				console.log(
					[
						"  /help            this list",
						"  /new             start a fresh session",
						"  /model           show the active model + tool mode",
						"  /tools <list>    show available tools",
						"  /ask [tools]    tools that need approval (y/N here, or canvas/phone)",
						"  /sessions        list recent sessions",
						"  /resume <id>     continue a previous session with current workspace overlay",
						"  /branch          branch the current session and continue there",
						"  /context         show context window usage",
						"  /skills          list bundled workflows",
						"  /skill <name> <task>  apply a bundled workflow to a request",
						"  /stop            cancel the active turn and its shell processes",
						"  /autonomy        show proactive proposals and service status",
						"  /new-context [handoff]  start a fresh window in this session",
						"  /quit            exit",
					].join("\n"),
				);
				return true;
			case "model":
				console.log(
					gray(
						`model: ${runner.model.provider}/${runner.model.id}\nbase: ${runner.model.baseUrl}\nAPI: ${runner.model.baseUrl.startsWith("cli://") ? "official subscription CLI" : "chat-completions (JSON/SSE)"}\ntools: ${runner.toolsMode} (source: ${runner.toolsModeSource})`,
					),
				);
				return true;
			case "tools":
				for (const t of runner.tools as AgentTool[]) {
					console.log(`  ${bold(t.name)} ${dim(t.description.split(".")[0])}`);
				}
				return true;
			case "ask": {
				// /ask — show; /ask bash,write — set; /ask clear — none
				if (!arg) {
					console.log(gray(`tools needing approval: ${runner.askTools.length ? runner.askTools.join(", ") : "(none)"}`));
					return true;
				}
				if (arg === "clear") {
					runner.askTools.length = 0;
					console.log(gray("approval set cleared — all tools run automatically"));
					return true;
				}
				const names = arg.split(",").map((s) => s.trim()).filter(Boolean);
				const known = new Set((runner.tools as AgentTool[]).map((t) => t.name));
				const bad = names.filter((n) => !known.has(n));
				if (bad.length) {
					console.log(yellow(`unknown tool(s): ${bad.join(", ")} — try /tools`));
					return true;
				}
				runner.askTools.length = 0;
				runner.askTools.push(...names);
				console.log(gray(`${names.join(", ")} now need approval (canvas/phone or [y/N] here)`));
				return true;
			}
			case "new":
				sessionId = createSession({ model: runner.model.id, provider: runner.model.provider, cwd: process.cwd() });
				runner.setSession(sessionId);
				console.log(gray(`fresh session ${sessionId.slice(-8)}`));
				return true;
			case "sessions":
				for (const s of listSessions(10)) {
					console.log(`  ${s.id}  ${gray(s.updated)}  ${dim(s.provider ?? "?")}/${dim(s.model ?? "?")}  ${s.messageCount} msgs`);
				}
				return true;
			case "resume": {
				if (!arg) {
					console.log(yellow("usage: /resume <session id>"));
					return true;
				}
				runner.setSession(arg);
				sessionId = arg;
				console.log(gray(`resumed ${arg} with ${runner.context.messages.length} archived messages; next request starts from current workspace state`));
				return true;
			}
			case "branch": {
				const id = branchSession(sessionId);
				runner.setSession(id);
				sessionId = id;
				console.log(gray(`branched to ${id.slice(-8)}`));
				return true;
			}
			case "context":
				console.log(gray(runner.contextStatus()));
				return true;
			case "skills":
				console.log(skillRoster());
				return true;
			case "stop":
				console.log(gray("Stopped. Send a new request when ready."));
				return true;
			case "autonomy": {
				const { autonomySnapshot } = await import("./autonomy/command.ts");
				const { renderDashboard } = await import("./autonomy/tui.ts");
				console.log(renderDashboard(autonomySnapshot()));
				return true;
			}
			case "new-context":
				runner.newContext(arg || undefined);
				console.log(gray(runner.contextStatus()));
				return true;
			case "quit":
			case "exit":
				return false;
			default:
				console.log(yellow(`unknown command: /${cmd} — try /help`));
				return true;
		}
	};

	// --- main loop ---------------------------------------------------------------
	// Line queue over rl.on("line"): works for a TTY and for piped stdin alike
	// (rl.question races when input is queued faster than the loop turns).
	interface InputLine { line: string; echoed: boolean }
	let resolveLine: ((input: InputLine) => void) | null = null;
	let promptVisible = false;
	let inputClosed = false;
	const lineQueue: InputLine[] = [];
	// Readline must move to an operator prompt before echoing a steering key.
	// While the operator types, hold rendering until Enter so token output cannot
	// split their input. The agent itself keeps running and can be canceled.
	const onKeypress = (text: string | undefined, key: readline.Key) => {
		if (!busy || approvalAnswer || typing || !text || key.ctrl || key.meta || ["return", "enter"].includes(key.name ?? "")) return;
		presentation.pauseForInput();
		typing = true;
		typingDone = new Promise(resolve => { resolveTyping = resolve; });
		rl.setPrompt(presentation.prompt());
		promptVisible = true;
		rl.prompt();
	};
	if (process.stdin.isTTY && process.stdout.isTTY) process.stdin.prependListener("keypress", onKeypress);
	rl.on("line", (line) => {
		if (terminating) return;
		const input = { line, echoed: promptVisible };
		promptVisible = false;
		if (/^\/(stop|quit|exit)\s*$/.test(line.trim()) && busy) {
			controller?.abort();
			approvalAnswer?.("");
			approvalAnswer = undefined;
			lineQueue.length = 0;
			lineQueue.push({ ...input, line: line.trim() });
			releaseTyping();
			return;
		}
		if (approvalAnswer) {
			const answer = approvalAnswer;
			approvalAnswer = undefined;
			answer(line);
			releaseTyping();
			return;
		}
		if (busy && !runFinished && !controller?.signal.aborted && line.trim() && !line.startsWith("/")) {
			presentation.operator(line, input.echoed, true);
			runner.steer({ role: "user", content: line, timestamp: Date.now() });
			releaseTyping();
			return;
		}
		if (busy && /^\/(quit|exit)\s*$/.test(line)) controller?.abort();
		if (resolveLine) {
			const r = resolveLine;
			resolveLine = null;
			r(input);
		} else {
			lineQueue.push(input);
		}
		releaseTyping();
	});
	rl.on("close", () => {
		inputClosed = true;
		approvalAnswer?.("");
		approvalAnswer = undefined;
		releaseTyping();
		if (resolveLine) {
			const r = resolveLine;
			resolveLine = null;
			r({ line: "", echoed: false });
		}
	});

	// Approval answers get a separate input slot so steering cannot consume them.
	rl.on("SIGINT", () => {
		if (busy) {
			controller?.abort();
			if (process.stdin.isTTY && process.stdout.isTTY && !rl.closed && (typing || approvalAnswer || rl.line.length)) {
				// A new prompt alone hides, but does not discard, a canceled draft.
				rl.write(null, { ctrl: true, name: "a" });
				rl.write(null, { ctrl: true, name: "k" });
				// TERM=dumb ignores editing keys. Reset both documented properties
				// as well so the hidden buffer cannot survive cancellation there.
				rl.line = "";
				rl.cursor = 0;
				process.stdout.write("\n");
			}
			promptVisible = false;
			approvalAnswer?.("");
			approvalAnswer = undefined;
			releaseTyping();
		} else rl.close();
	});
	// Closing a tmux pane sends SIGHUP. Await the active run's cancellation so
	// its detached foreground shell group is cleaned up before this process exits.
	// Ordinary piped EOF keeps its existing behavior and drains queued requests.
	const terminate = (code: number) => {
		if (terminating) return;
		terminating = true;
		process.exitCode = code;
		controller?.abort();
		lineQueue.length = 0;
		approvalAnswer?.("");
		approvalAnswer = undefined;
		if (!rl.closed) rl.close();
	};
	const signals = [["SIGHUP", () => terminate(129)], ["SIGTERM", () => terminate(143)]] as const;
	for (const [signal, handler] of signals) process.on(signal, handler);
	let approvalTail = Promise.resolve(false);
	runner.askFallback = (name, args) => {
		const pending = approvalTail.then(async () => {
			// Do not consume an operator's half-typed steering request as approval.
			if (typingDone) await typingDone;
			if (!process.stdin.isTTY || inputClosed || controller?.signal.aborted) return false;
			const s = JSON.stringify(args);
			presentation.flush();
			process.stdout.write(`\n\u26a1 approve ${bold(name)} ${dim(s.length > 100 ? s.slice(0, 100) + "\u2026" : s)} \u2014 [y/N] `);
			const line = await new Promise<string>((resolve) => { approvalAnswer = resolve; });
			return /^y(es)?$/i.test(line.trim());
		});
		approvalTail = pending.catch(() => false);
		return pending;
	};

	/** Next line; null means input is gone (EOF/Ctrl-D) and the queue is empty. */
	const ask = (): Promise<InputLine | null> => {
		if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift()!);
		if (inputClosed) return Promise.resolve(null);
		return new Promise((resolve) => {
			resolveLine = (line) => resolve(line);
			if (!rl.closed && process.stdin.isTTY && process.stdout.isTTY) {
				rl.setPrompt(presentation.prompt());
				promptVisible = true;
				rl.prompt();
			}
		});
	};

	// Seed with a greeting only on a fresh, empty session
	if (runner.context.messages.length === 0) {
		console.log(gray("ask me anything, or /help for commands. while I'm working, just type — I'll fold it in."));
	}

	try { while (!terminating) {
		proposalAlert();
		const input = await ask();
		if (input === null) break;
		let line = input.line;
		if (!line) continue;

		if (/^\/skill(?:\s|$)/.test(line)) {
			try {
				const [, name, task] = line.match(/^\/skill\s+(\S+)\s+([\s\S]+)$/) ?? [];
				line = skillRequest(name ?? "", task ?? "");
			} catch (err) {
				console.log(yellow((err as Error).message));
				continue;
			}
		} else if (line.startsWith("/")) {
			try {
				const keep = await handleCommand(line);
				if (!keep) break;
			} catch (err) {
				console.log(red((err as Error).message));
			}
			continue;
		}

		presentation.operator(input.line, input.echoed);
		presentation.startRun();
		const userMsg: AgentMessage = { role: "user", content: line, timestamp: Date.now() };

		try {
			const started = Date.now();
			busy = true;
			runFinished = false;
			controller = new AbortController();
			await runner.run(userMsg, { signal: controller.signal, onEvent });
			runFinished = true;
			if (typingDone) await typingDone;
			if (terminating) continue;
			presentation.finish(undefined, controller.signal.aborted);
			if (process.stdout.isTTY) process.stdout.write("\n");
			const secs = ((Date.now() - started) / 1000).toFixed(1);
			const usage = runner.context.messages[runner.context.messages.length - 1];
			const tokens = (usage as any)?.usage?.output;
			console.log(gray(`${secs}s${tokens ? ` · ${tokens} out-tokens` : ""}`));
		} catch (err) {
			runFinished = true;
			if (typingDone) await typingDone;
			if (!terminating) presentation.finish((err as Error).message, controller?.signal.aborted);
		} finally {
			busy = false;
			controller = undefined;
			presentation.flush();
		}
	} } finally {
		process.stdin.off("keypress", onKeypress);
		for (const [signal, handler] of signals) process.off(signal, handler);
		if (!rl.closed) rl.close();
	}
}

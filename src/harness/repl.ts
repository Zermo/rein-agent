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
import { randomUUID } from "node:crypto";
import { appendEntries, branchSession, createSession, listSessions, loadSession } from "../agent/session.ts";
import type { AgentMessage } from "../agent/agent-loop.ts";
import { cyan, dim, gray, green, red, yellow, bold, stripAnsi } from "../util/ansi.ts";
import type { Runner } from "./runner.ts";
import type { AgentTool } from "../agent/agent-loop.ts";

interface ReplOptions {
	runner: Runner;
	resumeSessionId?: string;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
	const { runner } = opts;
	let sessionId = opts.resumeSessionId ?? createSession({ model: runner.model.id, provider: runner.model.provider, cwd: process.cwd() });

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: dim("❯ ") });

	console.log(
		gray(
			`rein · ${runner.model.provider}/${runner.model.id} · tools: ${runner.toolsMode} (${runner.toolsModeSource}) · session ${sessionId.slice(-8)}\n`,
		),
	);

	let busy = false;

	// --- live rendering state -------------------------------------------------
	let currentText = "";
	let thinkingOn = false;

	const flushLine = () => {
		if (currentText.trim()) {
			process.stdout.write("\n" + currentText.trimEnd() + "\n");
		}
		currentText = "";
	};

	const onEvent = (event: any) => {
		switch (event.type) {
			case "message_update": {
				const e = event.event;
				if (e.type === "text_delta") {
					if (thinkingOn) {
						process.stdout.write("\n");
						thinkingOn = false;
					}
					process.stdout.write(e.delta);
					currentText += e.delta;
				} else if (e.type === "thinking_delta") {
					if (!thinkingOn) {
						process.stdout.write("\n" + gray("· thinking… "));
						thinkingOn = true;
					}
					// thinking is shown only as "thinking…", not the full trace
				}
				break;
			}
			case "message_end": {
				flushLine();
				break;
			}
			case "tool_execution_start": {
				if (thinkingOn) {
					process.stdout.write("\n");
					thinkingOn = false;
				}
				const args = JSON.stringify(event.args ?? {});
				process.stdout.write("\n" + cyan("⚡ ") + bold(event.toolName) + " " + dim(args.length > 120 ? args.slice(0, 120) + "…" : args) + "\n");
				break;
			}
			case "tool_execution_end": {
				const mark = event.isError ? red("✗") : green("✓");
				const preview = (event.result?.content ?? "").replace(/\n/g, " ").slice(0, 100);
				process.stdout.write(dim(`  ${mark} ${preview}${(event.result?.content ?? "").length > 100 ? "…" : ""}\n`));
				break;
			}
		}
	};

	// Wire events into the runner's loop for every run.
	const originalRun = runner.run.bind(runner);
	runner.run = (prompt: AgentMessage, runOpts?: { signal?: AbortSignal }) => {
		busy = true;
		return originalRun(prompt, runOpts)
			.then((messages) => {
				appendEntries(sessionId, messages);
				return messages;
			})
			.finally(() => {
				busy = false;
			});
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
						"  /sessions        list recent sessions",
						"  /resume <id>     continue a previous session (reloads its messages)",
						"  /branch          branch the current session and continue there",
						"  /quit            exit",
					].join("\n"),
				);
				return true;
			case "model":
				console.log(
					gray(
						`model: ${runner.model.provider}/${runner.model.id}\nbase: ${runner.model.baseUrl}\ntools: ${runner.toolsMode} (source: ${runner.toolsModeSource})`,
					),
				);
				return true;
			case "tools":
				for (const t of runner.tools as AgentTool[]) {
					console.log(`  ${bold(t.name)} ${dim(t.description.split(".")[0])}`);
				}
				return true;
			case "new":
				sessionId = createSession({ model: runner.model.id, provider: runner.model.provider, cwd: process.cwd() });
				runner.context.messages = [];
				console.log(gray(`fresh session ${sessionId.slice(-8)}`));
				return true;
			case "sessions":
				for (const s of listSessions(10)) {
					console.log(`  ${s.id.slice(-12)}  ${gray(s.updated)}  ${dim(s.provider ?? "?")}/${dim(s.model ?? "?")}  ${s.messageCount} msgs`);
				}
				return true;
			case "resume": {
				if (!arg) {
					console.log(yellow("usage: /resume <session id>"));
					return true;
				}
				const { messages } = loadSession(arg);
				sessionId = arg;
				runner.context.messages = [...messages];
				console.log(gray(`resumed ${arg} with ${messages.length} messages`));
				return true;
			}
			case "branch": {
				const id = branchSession(sessionId);
				sessionId = id;
				console.log(gray(`branched to ${id.slice(-8)}`));
				return true;
			}
			case "quit":
			case "exit":
				return false;
			default:
				console.log(yellow(`unknown command: /${cmd} — try /help`));
				return true;
		}
	};

	// --- main loop ---------------------------------------------------------------
	rl.prompt();

	const ask = (prompt?: string): Promise<string> =>
		new Promise((resolve) => {
			rl.question(prompt ?? rl.prompt, (answer) => resolve(answer.trim()));
		});

	// Seed with a greeting only on a fresh, empty session
	if (runner.context.messages.length === 0) {
		console.log(gray("ask me anything, or /help for commands. while I'm working, just type — I'll fold it in."));
	}

	let first = true;
	while (true) {
		const line = await ask();
		if (!line) continue;

		if (line.startsWith("/")) {
			const keep = await handleCommand(line);
			if (!keep) break;
			rl.prompt();
			continue;
		}

		const userMsg: AgentMessage = { role: "user", content: line, timestamp: Date.now() };

		if (busy) {
			// Steering: the agent is mid-run; queue it and keep going.
			runner.steer(userMsg);
			console.log(gray("(queued — I'll fold that in after the current step)"));
			continue;
		}

		try {
			const started = Date.now();
			await runner.run(userMsg);
			if (process.stdout.isTTY) process.stdout.write("\n");
			const secs = ((Date.now() - started) / 1000).toFixed(1);
			const usage = runner.context.messages[runner.context.messages.length - 1];
			const tokens = (usage as any)?.usage?.output;
			console.log(gray(`${secs}s${tokens ? ` · ${tokens} out-tokens` : ""}`));
		} catch (err) {
			console.log(red(`something broke: ${(err as Error).message}`));
		}
		if (first) first = false;
		rl.prompt();
	}

	rl.close();
}

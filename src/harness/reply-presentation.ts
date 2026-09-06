/** Streaming transcript labels. Rotation advances per reply, never on a timer. */
import type { AgentEvent } from "../agent/agent-loop.ts";

interface PresentationOptions {
	write: (text: string) => void;
	color?: boolean;
}

export function createReplyPresentation(options: PresentationOptions) {
	const write = options.write;
	const color = options.color ?? Boolean(process.stdout.isTTY && !("NO_COLOR" in process.env));
	const paint = (code: number, text: string) => color ? `\x1b[1;${code}m${text}\x1b[0m` : text;
	const markers = ["◐", "◓", "◑", "◒"];
	const accents = [32, 35, 33, 94];
	let operators = 0, replies = 0;
	let open = false, continued = false, lineOpen = false, textSeen = false, thinkingShown = false;
	let canceledShown = false;
	const number = (n: number) => String(n).padStart(2, "0");
	const operatorLabel = () => paint(36, `[OPERATOR · turn ${number(operators + 1)}]`);
	const replyLabel = (continuation = false) => {
		const index = (replies - 1) % markers.length;
		return paint(accents[index], `[REIN · reply ${number(replies)} ${markers[index]}${continuation ? " · continued" : ""}]`);
	};
	const flush = () => {
		if (lineOpen) write("\n");
		lineOpen = false;
	};
	const beginReply = () => {
		flush();
		replies++;
		open = true;
		continued = false;
		textSeen = false;
		thinkingShown = false;
		write(`\n${replyLabel()}\n`);
	};
	const ensureReply = () => {
		if (!open) beginReply();
		else if (continued) {
			flush();
			write(`\n${replyLabel(true)}\n`);
			continued = false;
			thinkingShown = false;
		}
	};
	const status = (text: string) => { flush(); write(`${text}\n`); };

	return {
		prompt: () => `${operatorLabel()} ❯ `,
		startRun() { canceledShown = false; },
		pauseForInput() { flush(); if (open) continued = true; },
		/** echoed means readline already displayed this numbered prompt and input. */
		operator(text: string, echoed = false, steering = false) {
			flush();
			if (!echoed) write(`\n${operatorLabel()}${steering ? " · steering queued" : ""}\n${text}\n`);
			operators++;
			if (open) continued = true;
		},
		flush,
		/** Finish a run that failed/canceled before the provider emitted message_end. */
		finish(error?: string, aborted = false) {
			if (error || aborted) {
				if (aborted && canceledShown) return;
				ensureReply();
				status(aborted ? "Reply canceled." : `Error: ${error}`);
			} else if (open && !textSeen) { ensureReply(); status("No text reply."); }
			flush();
			open = false;
		},
		event(event: AgentEvent) {
			switch (event.type) {
				case "message_start":
					if (event.message.role === "assistant") beginReply();
					break;
				case "message_update": {
					const delta = event.event;
					if (delta.type === "text_delta" && delta.delta) {
						ensureReply();
						write(delta.delta);
						lineOpen = !delta.delta.endsWith("\n");
						textSeen = true;
					} else if (delta.type === "thinking_delta") {
						ensureReply();
						if (!thinkingShown) { status("Thinking…"); thinkingShown = true; }
					}
					break;
				}
				case "message_end": {
					if (event.message.role !== "assistant") break;
					ensureReply();
					const message = event.message;
					if (!textSeen) {
						const finalText = message.content.filter(part => part.type === "text").map(part => part.text).join("");
						if (finalText) { write(finalText); lineOpen = !finalText.endsWith("\n"); textSeen = true; }
					}
					flush();
					if (message.stopReason === "error") status(`Error: ${message.errorMessage ?? "model error"}`);
					else if (message.stopReason === "aborted") { status("Reply canceled."); canceledShown = true; }
					else if (message.stopReason === "length") status("Reply reached the output limit.");
					else if (!textSeen && !message.content.some(part => part.type === "toolCall")) status("No text reply.");
					open = false;
					break;
				}
				case "tool_execution_start": {
					flush();
					const args = JSON.stringify(event.args ?? {});
					write(`\n${paint(90, `[TOOL · ${event.toolName}]`)} ${args.length > 120 ? `${args.slice(0, 120)}…` : args}\n`);
					break;
				}
				case "tool_execution_end": {
					flush();
					const content = event.result?.content ?? "";
					const preview = content.replace(/\n/g, " ").slice(0, 100);
					write(`${paint(event.isError ? 31 : 90, `[TOOL · ${event.toolName} · ${event.isError ? "failed" : "done"}]`)} ${preview}${content.length > 100 ? "…" : ""}\n`);
					break;
				}
			}
		},
	};
}

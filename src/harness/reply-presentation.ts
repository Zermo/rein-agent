/** Streaming transcript labels. Rotation advances per reply, never on a timer. */
import type { AgentEvent } from "../agent/agent-loop.ts";
import type { AssistantMessage } from "../ai/types.ts";

interface PresentationOptions {
	write: (text: string) => void;
	color?: boolean;
}

export type ReplyTextType = "MESSAGE" | "RESULT" | "OPINION" | "CHOICE" | "CHANGE" | "EDIT";
const replyTypes: readonly ReplyTextType[] = ["RESULT", "OPINION", "CHOICE", "CHANGE", "EDIT"];

/** Only a complete, explicit first-line marker supplies an agent-declared purpose. */
export function replyTextPrefix(text: string, final = false): { pending: boolean; type: ReplyTextType; text: string } {
	const newline = text.indexOf("\n");
	const first = (newline < 0 ? text : text.slice(0, newline)).replace(/\r$/, "");
	const type = replyTypes.find(kind => first === `[${kind}]`);
	if (type && (newline >= 0 || final)) return { pending: false, type, text: newline < 0 ? "" : text.slice(newline + 1) };
	const pending = !final && newline < 0 && replyTypes.some(kind => `[${kind}]\r`.startsWith(text) || `[${kind}]`.startsWith(text));
	return { pending, type: "MESSAGE", text };
}

export type ToolActionType = "READ" | "WRITE" | "EDIT" | "EXEC" | "WEB" | "REVIEW" | "SKILL" | "CONTEXT" | "CHECK" | "CALL";
/** Known tool contracts determine labels. Never infer an action from shell text. */
export function toolActionType(name: string, args?: unknown): ToolActionType {
	const data = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
	if (["read", "ls", "grep", "find", "history"].includes(name)) return "READ";
	if (name === "write") return "WRITE";
	if (name === "edit") return "EDIT";
	if (name === "bash") return "EXEC";
	if (name === "web_search" || name === "web_fetch") return "WEB";
	if (name === "meat") return "REVIEW";
	if (name === "skill") return "SKILL";
	if (name === "new_context" || name === "get_context_remaining") return "CONTEXT";
	if (name === "notes") {
		if (["write", "append"].includes(String(data.op))) return "WRITE";
		if (["read", "list", "search"].includes(String(data.op))) return "READ";
	}
	if (name === "tmux") {
		if (["list", "capture"].includes(String(data.op))) return "READ";
		if (["start", "send", "interrupt", "stop"].includes(String(data.op))) return "EXEC";
	}
	if (name === "gates") {
		if (["status", "lint"].includes(String(data.mode))) return "CHECK";
		if (["approve", "reverify"].includes(String(data.mode))) return "EXEC";
	}
	return "CALL";
}

const actionColors: Record<ToolActionType, number> = { READ: 36, WRITE: 33, EDIT: 33, EXEC: 35, WEB: 34, REVIEW: 34, SKILL: 90, CONTEXT: 90, CHECK: 36, CALL: 90 };
const inline = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

/** The adapter currently reports reasoning tokens, not a reasoning-effort level. */
export function reasoningUsageLabel(message: AssistantMessage): string | undefined {
	const count = message.usage?.reasoning;
	return typeof count === "number" && Number.isSafeInteger(count) && count > 0
		? `${count} reasoning tokens (provider reported). Effort: not reported.` : undefined;
}

export function createReplyPresentation(options: PresentationOptions) {
	const write = options.write;
	const color = options.color ?? Boolean(process.stdout.isTTY && !("NO_COLOR" in process.env));
	const paint = (code: number, text: string) => color ? `\x1b[1;${code}m${text}\x1b[0m` : text;
	const markers = ["◐", "◓", "◑", "◒"];
	const accents = [32, 35, 33, 94];
	let operators = 0, replies = 0, toolNumber = 0;
	let open = false, continued = false, lineOpen = false, textSeen = false, thinkingShown = false;
	let textType: ReplyTextType | undefined, prefix = "", textLabelShown = false;
	let canceledShown = false;
	const calls = new Map<string, { number: number; action: ToolActionType } | null>();
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
		textType = undefined;
		prefix = "";
		textLabelShown = false;
		write(`\n${replyLabel()}\n`);
	};
	const ensureReply = () => {
		if (!open) beginReply();
		else if (continued) {
			flush();
			write(`\n${replyLabel(true)}\n`);
			continued = false;
			thinkingShown = false;
			textLabelShown = false;
		}
	};
	const status = (label: string, text: string, code = 90) => { flush(); write(`${paint(code, `[${label}]`)} ${text}\n`); };
	const showText = (text: string) => {
		if (!textLabelShown) {
			flush();
			write(`${paint(accents[(replies - 1) % accents.length], `[${textType ?? "MESSAGE"}${textType && textType !== "MESSAGE" ? " · agent-labeled" : ""}]`)}\n`);
			textLabelShown = true;
		}
		if (text) { write(text); lineOpen = !text.endsWith("\n"); }
	};
	const appendText = (text: string, final = false) => {
		if (text) textSeen = true;
		if (textType === undefined) {
			prefix += text;
			const parsed = replyTextPrefix(prefix, final);
			if (parsed.pending) return;
			textType = parsed.type;
			prefix = "";
			showText(parsed.text);
		} else if (text) showText(text);
	};

	return {
		prompt: () => `${operatorLabel()} ❯ `,
		startRun() { canceledShown = false; calls.clear(); toolNumber = 0; },
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
				if (prefix) appendText("", true);
				status(aborted ? "CANCELED" : "ERROR", aborted ? "Reply canceled." : `Error: ${error}`, aborted ? 33 : 31);
			} else if (open && !textSeen) { ensureReply(); status("COMPLETE", "No text reply."); }
			else if (prefix) { ensureReply(); appendText("", true); }
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
						appendText(delta.delta);
					} else if (delta.type === "thinking_delta") {
						ensureReply();
						if (!thinkingShown) { status("THINKING", "Thinking… Effort: not reported.", 35); thinkingShown = true; textLabelShown = false; }
					}
					break;
				}
				case "message_end": {
					if (event.message.role !== "assistant") break;
					ensureReply();
					const message = event.message;
					if (!textSeen) {
						const finalText = message.content.filter(part => part.type === "text").map(part => part.text).join("");
						if (finalText) appendText(finalText, true);
					} else if (prefix) appendText("", true);
					flush();
					const reasoning = reasoningUsageLabel(message);
					if (reasoning) status("REASONING", reasoning);
					if (message.stopReason === "error") status("ERROR", `Error: ${message.errorMessage ?? "model error"}`, 31);
					else if (message.stopReason === "aborted") { status("CANCELED", "Reply canceled.", 33); canceledShown = true; }
					else if (message.stopReason === "length") status("LIMIT", "Reply reached the output limit.", 33);
					else if (message.content.some(part => part.type === "toolCall")) status("HANDOFF", "Tool calls requested.");
					else status("COMPLETE", textSeen ? "Reply ended." : "No text reply.");
					open = false;
					break;
				}
				case "tool_execution_start": {
					flush(); textLabelShown = false;
					const args = JSON.stringify(event.args ?? {});
					const call = { number: ++toolNumber, action: toolActionType(event.toolName, event.args) };
					// A repeated provider ID cannot reliably pair parallel completions.
					calls.set(event.toolCallId, calls.has(event.toolCallId) ? null : call);
					write(`\n${paint(actionColors[call.action], `[TOOL ${call.action} · ${inline(event.toolName)} · call ${number(call.number)}]`)} ${args.length > 120 ? `${args.slice(0, 120)}…` : args}\n`);
					break;
				}
				case "tool_execution_end": {
					flush(); textLabelShown = false;
					const content = event.result?.content ?? "";
					const preview = inline(content).slice(0, 100);
					const call = calls.get(event.toolCallId);
					const action = call?.action ?? toolActionType(event.toolName);
					const id = call ? ` · call ${number(call.number)}` : calls.has(event.toolCallId) ? " · duplicate ID; unpaired" : "";
					if (call) calls.delete(event.toolCallId);
					const failed = event.isError || event.result?.isError;
					write(`${paint(failed ? 31 : actionColors[action], `[TOOL ${action} RESULT · ${inline(event.toolName)}${id} · ${failed ? "failed" : "done"}]`)} ${preview}${content.length > 100 ? "…" : ""}\n`);
					break;
				}
			}
		},
	};
}

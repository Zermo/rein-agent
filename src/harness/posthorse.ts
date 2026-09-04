/** Posthorse policy adapted from fitchmultz/pi-posthorse 0.4.1 (MIT).
 * See vendor/pi-posthorse/UPSTREAM.md. Rein owns the persisted boundary.
 */
import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentTool } from "../agent/agent-loop.ts";
import type { AssistantMessage, Model, ToolResultMessage } from "../ai/types.ts";
import { appendSessionEntry, loadSession, windowMessage, providerMessages, validWindowStart } from "../agent/session.ts";
import type { ContextWindowEntry, SessionEntry, StoredMessage } from "../agent/session.ts";

export const POSTHORSE_GUIDANCE = `\n\n## Context windows (Posthorse)
Use get_context_remaining when the context budget matters. Automatic rollover starts a fresh window without generating a summary. Before new_context, save durable goal, decisions, progress, and next steps with notes, or pass a concise handoff. The boundary commits only after the entire tool batch succeeds. Earlier conversation remains recoverable with history. After rollover, restore notes and inspect history. Recovery records preserve inputs, not proof of progress; verify live state before stateful or external actions.`;
const MAX_CHARS = 20_000;
const MARGIN = 512;
// Tokenization varies by provider; usage refines this deliberately conservative estimate.
export const estimateTokens = (value: unknown): number => Math.ceil((typeof value === "string" ? value : JSON.stringify(value) ?? "").length / 3);
export function messageText(message: AgentMessage): string {
	if (message.role === "user") return message.content;
	return message.content.map(part => part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : `${part.name} ${JSON.stringify(part.arguments)}`).join("\n");
}
export class Posthorse {
	messages: StoredMessage[] = [];
	entries: SessionEntry[] = [];
	window?: ContextWindowEntry;
	sessionId?: string;
	readonly model: Model;
	readonly enabled: boolean;
	readonly reserveTokens: number;
	private prompt: () => string;
	private tools: () => AgentTool[];
	private usage?: { count: number; tokens: number; windowId: string };
	private lastRequestCount = 0;
	private lastOverflowCount = -1;
	private pageTokensAllocated = 0;
	constructor(options: { model: Model; enabled?: boolean; reserveTokens?: number; prompt: () => string; tools: () => AgentTool[] }) {
		this.model = options.model; this.prompt = options.prompt; this.tools = options.tools;
		this.enabled = options.enabled !== false;
		this.reserveTokens = options.reserveTokens ?? Math.max(this.model.maxTokens, Math.min(4096, Math.floor(this.model.contextWindow / 5)));
		if (!Number.isSafeInteger(this.model.contextWindow) || this.model.contextWindow < 1024) throw new Error("contextWindow must be an integer of at least 1024 tokens");
		if (!Number.isSafeInteger(this.model.maxTokens) || this.model.maxTokens < 1 || this.model.maxTokens >= this.model.contextWindow) throw new Error("maxTokens must be positive and smaller than contextWindow");
		if (!Number.isSafeInteger(this.reserveTokens) || this.reserveTokens < this.model.maxTokens || this.reserveTokens >= this.model.contextWindow) throw new Error("reserveTokens must cover maxTokens and be smaller than contextWindow");
	}
	get windowId(): string { return this.window?.id ?? "initial"; }
	get line(): number { return this.model.contextWindow - this.reserveTokens; }
	private overhead(): number {
		return estimateTokens(this.prompt()) + estimateTokens(this.tools().map(({ name, description, parameters }) => ({ name, description, parameters }))) + 64;
	}
	setSession(id: string): void {
		const loaded = loadSession(id);
		this.sessionId = id; this.messages = loaded.messages; this.entries = loaded.entries; this.window = loaded.window;
		this.usage = undefined; this.lastRequestCount = providerMessages(loaded.messages).length; this.lastOverflowCount = -1; this.pageTokensAllocated = 0;
	}
	private store(entry: SessionEntry): void {
		if (this.sessionId) appendSessionEntry(this.sessionId, entry);
		this.entries.push(entry);
	}
	record(message: AgentMessage): void {
		const entry: StoredMessage = { ...message, id: randomUUID() };
		this.store(entry); this.messages.push(entry);
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && Number.isFinite(message.usage?.totalTokens) && message.usage.totalTokens > 0) {
			this.usage = { count: this.messages.length, tokens: message.usage.totalTokens, windowId: this.windowId };
		}
	}
	active(messages: AgentMessage[] = this.messages): AgentMessage[] {
		return providerMessages(this.window ? [windowMessage(this.window), ...messages.slice(this.window.start)] : [...messages]);
	}
	used(messages: AgentMessage[] = this.messages): number {
		const estimated = this.overhead() + estimateTokens(this.active(messages));
		const measured = this.usage?.windowId === this.windowId ? this.usage.tokens + estimateTokens(messages.slice(this.usage.count).filter(message => message.role !== "assistant" || (message.stopReason !== "error" && message.stopReason !== "aborted"))) : 0;
		return Math.max(estimated, measured);
	}
	freshLimit(pending: AgentMessage[] = []): number {
		return Math.min(MAX_CHARS, Math.max(0, Math.floor((this.line - this.overhead() - estimateTokens(pending) - MARGIN) / 2)) * 3);
	}
	pageLimit(offset = 0): number {
		const chars = Math.min(this.freshLimit(), Math.max(0, this.line - this.used() - MARGIN - this.pageTokensAllocated) * 3);
		if (chars < 256) throw new Error(`Too little context remains for a safe page. Call new_context, then retry with offset ${offset}.`);
		this.pageTokensAllocated += estimateTokens("x".repeat(chars)) + 64;
		return chars;
	}
	status(): string {
		return JSON.stringify({ windowId: this.windowId, estimatedTokens: this.used(), contextWindow: this.model.contextWindow, reserveTokens: this.reserveTokens, untilRollover: Math.max(0, this.line - this.used()), untilHardLimit: Math.max(0, this.model.contextWindow - this.used()), automatic: this.enabled, estimate: true });
	}
	validateHandoff(handoff?: string): void {
		const limit = this.freshLimit();
		if (limit < 256) throw new Error("Prompt and tool overhead leave no room for a fresh window. Increase contextWindow or reduce maxTokens/reserveTokens or prompt size.");
		if (handoff && handoff.length > limit) throw new Error(`Handoff exceeds the ${limit} character budget. Save fuller state in notes and retry with a shorter handoff.`);
	}
	rollover(handoff?: string, reason: ContextWindowEntry["reason"] = "manual", start = this.messages.length): void {
		this.validateHandoff(handoff);
		if (!validWindowStart(this.messages, start) || start < (this.window?.start ?? 0)) throw new Error("Context boundary must follow a complete tool batch and advance within the transcript");
		const window: ContextWindowEntry = { type: "context_window", id: randomUUID(), timestamp: Date.now(), start, handoff: handoff?.trim() || undefined, reason };
		this.store(window); // Persist before changing which messages the model can see.
		this.window = window; this.usage = undefined; this.pageTokensAllocated = 0;
	}
	afterBatch(info: { message: AssistantMessage; toolResults: ToolResultMessage[]; newContext?: { handoff?: string } }): void {
		if (info.newContext) this.rollover(info.newContext.handoff, "tool");
	}
	/** A bounded input record, never a generated summary or claim of completed work. */
	private recovery(messages: AgentMessage[], end: number, limit: number): string {
		const start = this.window?.start ?? 0;
		const candidates: { label: string; text: string }[] = [];
		if (this.window?.handoff) candidates.push({ label: `Older checkpoint [${this.window.id}], verify before reuse`, text: this.window.handoff });
		const users = messages.slice(start, end).map((m, i) => ({ m, i: start + i })).filter(({ m }) => m.role === "user");
		const chosen = users.length > 8 ? [users[0], ...users.slice(-7)] : users;
		for (const { m, i } of chosen.slice(0, 8)) candidates.push({ label: `Direct user input [${this.messages[i]?.id ?? i}]`, text: messageText(m) });
		// Preserve the latest complete tool batch that no model has yet consumed.
		let batchStart = end;
		while (batchStart > start && messages[batchStart - 1].role === "toolResult") batchStart--;
		if (batchStart < end && batchStart > start && messages[batchStart - 1].role === "assistant") {
			for (let i = batchStart - 1; i < end; i++) candidates.push({ label: `Unconsumed ${messages[i].role} [${this.messages[i]?.id ?? i}]`, text: messageText(messages[i]) });
		}
		const preamble = "Automatic context rollover recovery record. These are recorded inputs, not proof of progress. Restore notes and use history to recover omitted or truncated entries. Verify live state before stateful or external work.\n";
		const selected = candidates.slice(0, 20);
		const allowance = Math.max(0, Math.floor((limit - preamble.length - 160 - selected.reduce((n, r) => n + r.label.length + 8, 0)) / Math.max(1, selected.length)));
		const blocks = selected.map(r => `${r.label}:\n${r.text.length > allowance ? r.text.slice(0, Math.max(0, allowance - 30)) + " [truncated; recover history]" : r.text}`);
		return (preamble + blocks.join("\n\n") + "\nUse history for all earlier inputs, full tool arguments/results, and any omitted records.").slice(0, limit);
	}
	prepare(messages: AgentMessage[]): AgentMessage[] {
		this.pageTokensAllocated = 0;
		if (this.enabled && this.used(messages) >= this.line) this.autoRollover(messages, "threshold");
		let active = this.active(messages);
		const used = this.used(messages);
		const remindAt = this.line - Math.min(32_000, Math.floor(this.line * 0.1));
		if (this.enabled && used >= remindAt && used < this.line) {
			const seen = this.entries.some(e => "type" in e && e.type === "posthorse-reminder" && e.windowId === this.windowId && e.contextWindow === this.model.contextWindow && e.reserveTokens === this.reserveTokens);
			if (!seen) {
				this.store({ type: "posthorse-reminder", id: randomUUID(), timestamp: Date.now(), windowId: this.windowId, contextWindow: this.model.contextWindow, reserveTokens: this.reserveTokens });
				active = [...active, { role: "user", timestamp: Date.now(), content: "[posthorse] Checkpoint now: save goal/progress/decisions/next steps in notes, then call new_context. This reminder is best-effort; automatic rollover may occur without it." }];
			}
		}
		this.lastRequestCount = providerMessages(messages).length;
		return active;
	}
	private autoRollover(messages: AgentMessage[], reason: "threshold" | "overflow"): boolean {
		// Keep newly submitted inputs separate. They must never disappear into the recovery record.
		let end = messages.length;
		if (messages.at(-1)?.role === "assistant" && (messages.at(-1) as AssistantMessage).stopReason === "error") end--;
		const errorIndex = end;
		while (end > (this.window?.start ?? 0) && messages[end - 1].role === "user") end--;
		const pending = messages.slice(end, errorIndex);
		const limit = this.freshLimit(pending);
		if (limit < 512) return false; // Do not discard an oversized request which cannot fit fresh either.
		if (end <= (this.window?.start ?? 0)) return false;
		if (!validWindowStart(this.messages, end)) return false;
		const handoff = this.recovery(messages, end, limit);
		this.rollover(handoff, reason, end);
		return true;
	}
	recover(message: AssistantMessage, messages: AgentMessage[]): boolean {
		if (!this.enabled || !/context[_ ]length[_ ]exceeded|maximum context|context window|too many tokens|prompt (?:is )?too long|exceeds.*(?:context|token)|input.*(?:too long|token limit)/i.test(message.errorMessage ?? "")) return false;
		// Retry a failed request at most once; a truly oversized fresh input remains visible as an error.
		if (this.lastOverflowCount === this.lastRequestCount) return false;
		const previous = this.windowId;
		const changed = this.autoRollover(messages, "overflow");
		if (changed && this.windowId !== previous) {
			this.lastOverflowCount = this.lastRequestCount;
			return true;
		}
		return false;
	}
}

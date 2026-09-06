/** A bounded, local view of observable agent events, separate from model context. */
import { mkdirSync, writeFileSync, renameSync, openSync, readFileSync, closeSync, fstatSync, constants, existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent } from "../../agent/agent-loop.ts";
import { terminalText } from "../autonomy/tui.ts";
import { budgetPauseText } from "../budget-presentation.ts";

export interface ActivityNode {
	id: string; parent?: string; kind: "request" | "response" | "tool" | "status";
	title: string; detail: string; status: "running" | "done" | "error" | "cancelled" | "paused";
	started: number; ended?: number; path?: string; input?: string;
}
export interface ActivitySnapshot {
	id: string; cwd: string; sessionId?: string; model?: string; updated: number;
	state: "working" | "idle" | "error" | "cancelled" | "paused"; nodes: ActivityNode[]; omitted: number;
}
export const newActivityId = () => randomUUID();
export function activityFile(id: string): string {
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error("Use the activity ID printed by rein --visual.");
	return join(resolve(process.env.REIN_HOME ?? join(homedir(), ".rein")), "activity", `${id}.json`);
}
const visible = (value: unknown, limit = 8000): string => {
	const text = terminalText(typeof value === "string" ? value : JSON.stringify(value) ?? "", true);
	return text.length > limit ? text.slice(0, limit) + "\n[view truncated]" : text;
};

export function readActivity(id: string): ActivitySnapshot | undefined {
	let fd: number;
	try { fd = openSync(activityFile(id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error("Activity data is not a bounded ordinary file.");
		const state = JSON.parse(readFileSync(fd, "utf8"));
		if (state.id !== id || !Array.isArray(state.nodes) || state.nodes.length > 256) throw new Error("Invalid activity data.");
		return state;
	} finally { closeSync(fd); }
}

export class ActivityJournal {
	readonly snapshot: ActivitySnapshot;
	private file: string;
	private timer?: ReturnType<typeof setTimeout>;
	private response?: ActivityNode;
	private last?: string;
	private tools = new Map<string, ActivityNode>();
	private sequence = 0;
	private disabled = false;
	constructor(id: string, cwd: string, model?: string) {
		this.file = activityFile(id);
		mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
		this.snapshot = { id, cwd: resolve(cwd), model, updated: Date.now(), state: "idle", nodes: [], omitted: 0 };
		// A writer owns an ID for its lifetime. Never overwrite another session.
		writeFileSync(this.file, JSON.stringify(this.snapshot), { flag: "wx", mode: 0o600 });
	}
	setSession(id: string) { this.snapshot.sessionId = id; this.flush(); }
	private add(kind: ActivityNode["kind"], title: string, detail = "", parent = this.last): ActivityNode {
		const node: ActivityNode = { id: String(++this.sequence), parent, kind, title: visible(title, 160), detail: visible(detail), status: "running", started: Date.now() };
		this.snapshot.nodes.push(node); this.last = node.id;
		if (this.snapshot.nodes.length > 256) { this.snapshot.nodes.shift(); this.snapshot.omitted++; }
		return node;
	}
	private finish(node: ActivityNode, status: ActivityNode["status"] = "done") { node.status = status; node.ended = Date.now(); }
	event(event: AgentEvent) {
		if (this.disabled) return;
		switch (event.type) {
			case "agent_start": case "turn_start": this.snapshot.state = "working"; break;
			case "message_start":
				if (event.message.role === "assistant") this.response = this.add("response", "Generating response");
				break;
			case "message_update":
				if (this.response && event.message.role === "assistant") {
					if (event.event.type.startsWith("thinking")) this.response.title = "Thinking";
					if (event.event.type.startsWith("text")) this.response.title = "Responding";
					this.response.detail = visible(event.message.content.filter(part => part.type === "text").map(part => part.text).join(""));
				}
				break;
			case "message_end": {
				const message = event.message;
				if (message.role === "user") this.finish(this.add("request", "User request", message.content));
				if (message.role === "assistant" && this.response) {
					this.response.title = message.stopReason === "budget" ? "Turn budget paused" : message.stopReason === "toolUse" ? "Tool plan" : "Response";
					this.response.detail = visible(message.stopReason === "budget" ? budgetPauseText(message) : message.content.filter(part => part.type === "text").map(part => part.text).join("") || (message.stopReason === "toolUse" ? "Requested: " + message.content.filter(part => part.type === "toolCall").map(part => part.name).join(", ") : message.errorMessage ?? "No visible response text."));
					const status = message.stopReason === "budget" ? "paused" : message.stopReason === "aborted" ? "cancelled" : ["error", "length"].includes(message.stopReason) ? "error" : "done";
					this.finish(this.response, status);
					if (status !== "done") this.snapshot.state = status;
				}
				break;
			}
			case "tool_execution_start": {
				const node = this.add("tool", event.toolName, "Waiting for result", this.response?.id);
				node.input = visible(event.args);
				const path = (event.args as any)?.path;
				if (typeof path === "string" && ["read", "write", "edit"].includes(event.toolName)) node.path = visible(path, 1000);
				this.tools.set(event.toolCallId, node); break;
			}
			case "tool_execution_update": {
				const node = this.tools.get(event.toolCallId); if (node) node.detail = visible(event.partial); break;
			}
			case "tool_execution_end": {
				const node = this.tools.get(event.toolCallId);
				if (node) { node.detail = visible(event.result.content); this.finish(node, event.isError ? "error" : "done"); this.tools.delete(event.toolCallId); }
				break;
			}
			case "agent_end": if (this.snapshot.state === "working") this.snapshot.state = "idle"; break;
		}
		if (event.type === "agent_end") this.flush();
		else if (!this.timer) { this.timer = setTimeout(() => this.flush(), 200); this.timer.unref(); }
	}
	end(cancelled = false) {
		if (cancelled) this.snapshot.state = "cancelled";
		else if (this.snapshot.state === "working") this.snapshot.state = "error";
		for (const node of this.snapshot.nodes) if (node.status === "running") this.finish(node, cancelled ? "cancelled" : "error");
		this.tools.clear();
		this.flush();
	}
	flush() {
		if (this.timer) clearTimeout(this.timer); this.timer = undefined;
		if (this.disabled) return;
		this.snapshot.updated = Date.now();
		const temp = this.file + `.${randomUUID()}.tmp`;
		try {
			let json = JSON.stringify(this.snapshot);
			while (Buffer.byteLength(json) > 3 * 1024 * 1024 && this.snapshot.nodes.length > 1) { this.snapshot.nodes.shift(); this.snapshot.omitted++; json = JSON.stringify(this.snapshot); }
			writeFileSync(temp, json, { flag: "wx", mode: 0o600 }); renameSync(temp, this.file);
		}
		catch { this.disabled = true; if (existsSync(temp)) try { unlinkSync(temp); } catch {} console.error("[activity] Could not save the live view. Agent work continues."); }
	}
}

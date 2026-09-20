export type Phase = "ready" | "working" | "thinking" | "responding" | "presenting" | "journaling" | "tool" | "autonomy" | "approval" | "error";
export type View = "bots" | "chat" | "settings";
export type RailTab = "path" | "crt";
export interface Bot {
  id: string; name: string; sessionId: string; created: string;
  computer: "local"; engine: "openai-compat"; cwd?: string; avatar?: string;
}
export interface Shell {
  version: 1;
  theme: { accent: "rain" | "slate" | "storm"; density: "compact" | "regular" | "roomy"; dark: boolean };
  chrome: { sidebar: boolean; tray: "normal" | "quiet" | "hidden"; showActivity: boolean };
}
export interface Snapshot {
  shell: Shell; prefs: { lastBotId?: string }; bots: Bot[];
  approvals: { id: string; tool: string; summary: string }[];
}
export interface RunSettings {
  bashApproval: "always" | "auto" | "whitelist" | "ask";
  reasoningEffort: "default" | "off" | "low" | "medium" | "high";
}
export interface Patch { op: "add" | "replace" | "remove" | "test"; path: string; value?: unknown }
export interface ToolCall { id: string; type?: string; function: { name: string; arguments: string } }
export interface Message {
  id: string; role: "user" | "assistant" | "tool"; content: string;
  toolCalls?: ToolCall[]; toolCallId?: string; toolName?: string; arguments?: string;
  status?: "running" | "complete" | "recorded"; isError?: boolean;
  completion?: { stopReason?: string; reasoningTokens?: number };
  local?: boolean; pending?: boolean; truncated?: boolean; persistedId?: string; streamIds?: string[];
}
export interface PathNode { id: string; kind: "user" | "tool" | "reply"; label: string; text: string }
export interface Turn { id: string; user?: Message; messages: Message[]; nodes: PathNode[] }
export type InspectKind = "image" | "html" | "text";
export interface InspectFile { path: string; size: number; kind: InspectKind; mtime: number }
export interface InspectDoc { path: string; name: string; kind: InspectKind; url: string; text?: string; error?: string }
export interface PendingAction { id: string; runId: string; kind: "approval" | "tool"; tool: string; summary: string; args?: Record<string, unknown> }
export interface Activity { autonomy: { status: "inactive" | "running" | "unavailable"; kind?: "scan" | "routine" } }
export interface AgEvent { type: string; [key: string]: unknown }
export interface WorkProfile { model: string; workStyle: "guided" | "balanced" | "independent"; taskLimit: number; starter: string }
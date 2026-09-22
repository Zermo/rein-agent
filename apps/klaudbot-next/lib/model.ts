import type { AgEvent, Message, Patch, PathNode, Phase, RunSettings, Shell, Snapshot, Turn } from "./types.ts";

export const DEFAULT_SHELL: Shell = { version: 1, theme: { accent: "rain", density: "regular", dark: true }, chrome: { sidebar: true, tray: "normal", showActivity: true } };
export const DEFAULT_SETTINGS: RunSettings = { bashApproval: "always", reasoningEffort: "default" };
export const PHASES: Phase[] = ["ready", "working", "thinking", "responding", "presenting", "journaling", "tool", "autonomy", "approval", "error"];
export const SHELL_FIELDS: Record<string, readonly unknown[]> = {
  "/theme/accent": ["rain", "slate", "storm"], "/theme/density": ["compact", "regular", "roomy"],
  "/theme/dark": [true, false], "/chrome/sidebar": [true, false],
  "/chrome/tray": ["normal", "quiet", "hidden"], "/chrome/showActivity": [true, false]
};
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function validateShell(value: unknown): Shell {
  if (!object(value) || value.version !== 1 || !object(value.theme) || !object(value.chrome)) throw new Error("Invalid shell snapshot.");
  for (const [pointer, options] of Object.entries(SHELL_FIELDS)) {
    const [, section, key] = pointer.split("/");
    if (!options.includes((value[section] as Record<string, unknown>)[key])) throw new Error("Invalid shell setting.");
  }
  return structuredClone(value) as unknown as Shell;
}
export function applyShellPatch(shell: Shell, patch: Patch[]): Shell {
  if (!Array.isArray(patch) || patch.length > 256) throw new Error("Invalid shell patch.");
  const next = validateShell(shell);
  for (const item of patch) {
    if (!object(item) || !Object.hasOwn(SHELL_FIELDS, item.path) || !["add", "replace", "remove", "test"].includes(item.op)) throw new Error("Invalid shell patch operation.");
    const [, section, key] = item.path.split("/");
    const target = next[section as "theme" | "chrome"] as unknown as Record<string, unknown>;
    if (item.op === "test") { if (target[key] !== item.value) throw new Error("Shell patch test failed."); }
    else if (item.op === "remove") delete target[key];
    else target[key] = item.value;
  }
  return validateShell(next);
}
export function validateSnapshot(value: unknown): Snapshot {
  if (!object(value) || !object(value.prefs) || !Array.isArray(value.bots) || !Array.isArray(value.approvals)) throw new Error("Invalid state snapshot.");
  const shell = validateShell(value.shell);
  for (const bot of value.bots) {
    if (!object(bot) || typeof bot.id !== "string" || !/^klaud-bot-[0-9a-f]{8}$/.test(bot.id) || typeof bot.sessionId !== "string" || !bot.sessionId || typeof bot.name !== "string") throw new Error("Invalid bot snapshot.");
  }
  return { ...(structuredClone(value) as unknown as Snapshot), shell };
}
export function validateSettings(value: unknown): RunSettings {
  if (!object(value) || !["always", "auto", "whitelist", "ask"].includes(String(value.bashApproval)) || !["default", "off", "low", "medium", "high"].includes(String(value.reasoningEffort))) throw new Error("Invalid run settings.");
  return { bashApproval: value.bashApproval, reasoningEffort: value.reasoningEffort } as RunSettings;
}
export function validateMessages(value: unknown): Message[] {
  if (!Array.isArray(value) || value.some(item => !object(item) || typeof item.id !== "string" || !["user", "assistant", "tool"].includes(String(item.role)) || typeof item.content !== "string")) throw new Error("Invalid transcript.");
  return structuredClone(value) as Message[];
}
const publicText = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.filter(item => object(item) && item.type === "text").map(item => String(item.text ?? "")).join("\n") : "";

export function updateTranscript(messages: Message[], event: AgEvent): Message[] {
  const next = [...messages];
  let id: string, message: Message;
  if (["THINKING_START", "THINKING_CONTENT", "THINKING_END"].includes(event.type)) {
    if (typeof event.messageId !== "string") throw new Error("Missing transcript message id.");
    const streamId = event.messageId;
    let existing = next.findLast(item => item.role === "assistant" && (item.local || item.streamIds?.includes(streamId)));
    if (!existing) {
      const waiting = next.findIndex(item => item.role === "assistant" && item.pending && !item.content && !item.thinking);
      if (waiting >= 0) existing = next[waiting];
    }
    id = existing?.id ?? streamId;
    const delta = event.type === "THINKING_CONTENT" ? String(event.delta ?? "") : "";
    const ended = event.type === "THINKING_END" && typeof event.content === "string" ? event.content : "";
    const thinking = (ended && ended.length >= (existing?.thinking?.length ?? 0) ? ended : `${existing?.thinking ?? ""}${delta}`).slice(0, 24_000);
    message = { ...existing, id, role: "assistant", local: true, streamIds: [...new Set([...(existing?.streamIds ?? []), streamId])], content: existing?.content ?? "", thinking, pending: event.type !== "THINKING_END" || Boolean(existing?.pending && !existing?.content) };
    const index = next.findIndex(item => item.id === id);
    if (index >= 0) next[index] = message; else next.push(message);
    return next;
  }
  if (["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"].includes(event.type)) {
    if (typeof event.messageId !== "string") throw new Error("Missing transcript message id.");
    id = event.messageId;
    let existing = next.find(item => item.id === id || item.streamIds?.includes(id));
    let newBlock = false;
    // Harness ids encode run:turn:contentIndex; durable history joins text
    // blocks in the same assistant turn. Keep a single ledger row per turn.
    if (!existing && event.type === "TEXT_MESSAGE_START" && /:\d+:\d+$/.test(id)) {
      const turn = id.slice(0, id.lastIndexOf(":"));
      existing = next.findLast(item => item.role === "assistant" && item.local && item.id.slice(0, item.id.lastIndexOf(":")) === turn);
      newBlock = !!existing;
    }
    if (!existing) {
      const waiting = next.findIndex(item => item.role === "assistant" && item.pending && !item.content);
      if (waiting >= 0) { existing = next[waiting]; next.splice(waiting, 1); }
    }
    if (event.type === "TEXT_MESSAGE_CONTENT" && typeof event.delta !== "string") throw new Error("Invalid text delta.");
    const streamId = id;
    if (existing && (existing.streamIds?.length || newBlock)) id = existing.id;
    message = { ...existing, id, role: "assistant", local: true, streamIds: [...new Set([...(existing?.streamIds ?? []), streamId])],
      content: event.type === "TEXT_MESSAGE_END" && typeof event.content === "string" ? event.content : (existing?.content ?? "") + (newBlock && existing?.content ? "\n" : "") + (event.type === "TEXT_MESSAGE_CONTENT" ? event.delta : ""),
      pending: event.type !== "TEXT_MESSAGE_END"
    };
    if (object(event.completion) && typeof event.completion.stopReason === "string") message.completion = { stopReason: event.completion.stopReason };
  } else if (["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"].includes(event.type)) {
    if (typeof event.toolCallId !== "string") throw new Error("Missing tool call id.");
    const existing = next.find(item => item.role === "tool" && item.toolCallId === event.toolCallId);
    id = existing?.id ?? `tool-${event.toolCallId}`;
    message = { ...existing, id, role: "tool", local: true, toolCallId: event.toolCallId,
      toolName: String(event.toolCallName ?? event.toolName ?? existing?.toolName ?? "Tool"),
      arguments: (existing?.arguments ?? "") + (event.type === "TOOL_CALL_ARGS" ? String(event.delta ?? "") : ""),
      content: event.type === "TOOL_CALL_RESULT" ? publicText(event.content) : existing?.content ?? "",
      status: event.type === "TOOL_CALL_RESULT" ? "complete" : "running", isError: event.isError === true
    };
    if (event.type === "TOOL_CALL_START") {
      const assistant = next.findLastIndex(item => item.role === "assistant");
      if (assistant >= 0) next[assistant] = { ...next[assistant], completion: { stopReason: "toolUse" } };
    }
  } else return messages;
  const index = next.findIndex(item => item.id === id);
  if (index >= 0) next[index] = message; else next.push(message);
  return next;
}

/** History is merged, never assigned over an in-flight local turn. */
export function mergeHistory(local: Message[], saved: Message[], earlier = false): Message[] {
  const sameId = new Map(local.flatMap(item => [[item.id, item] as const, ...(item.persistedId ? [[item.persistedId, item] as const] : [])]));
  if (earlier) return [...saved.filter(item => !sameId.has(item.id)), ...local];
  const consumed = new Set<string>();
  let lastMatched = -1;
  const equivalent = (candidate: Message, item: Message) => candidate.role === item.role && (
    candidate.role === "tool" && candidate.toolCallId && candidate.toolCallId === item.toolCallId ||
    candidate.content !== "" && (candidate.role === "user" || !candidate.pending) &&
    (candidate.content === item.content || item.truncated && candidate.content.startsWith(item.content.split("\n[Preview shortened;")[0]))
  );
  const merged = saved.map(item => {
    let existing = sameId.get(item.id);
    // A history load can discover a durable id while the local user is pending.
    // Match in order after the last shared anchor; retain the local id and alias
    // its durable id so future pages cannot create a second copy of that turn.
    if (!existing) existing = local.find((candidate, index) => index > lastMatched && candidate.local && !candidate.persistedId && !consumed.has(candidate.id) && equivalent(candidate, item));
    if (existing) {
      consumed.add(existing.id);
      lastMatched = Math.max(lastMatched, local.indexOf(existing));
      return { ...item, ...existing, persistedId: item.id, content: existing.content.length >= item.content.length || existing.pending ? existing.content : item.content };
    }
    return item;
  });
  // Union by shared chronological anchors, not `[latestPage, ...oldRows]`:
  // previously loaded earlier pages must stay BEFORE the newest page.
  const result = [...merged];
  for (let index = 0; index < local.length; index++) {
    const item = local[index];
    if (consumed.has(item.id)) continue;
    const nextAnchor = local.slice(index + 1).find(candidate => consumed.has(candidate.id));
    const position = nextAnchor ? result.findIndex(candidate => candidate.id === nextAnchor.id) : -1;
    if (position >= 0) result.splice(position, 0, item); else result.push(item);
  }
  return result;
}

export function groupTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user" || !turns.length) turns.push({ id: message.id, user: message.role === "user" ? message : undefined, messages: [], nodes: [] });
    turns[turns.length - 1].messages.push(message);
  }
  for (const turn of turns) {
    const nodes: PathNode[] = [];
    if (turn.user) nodes.push({ id: turn.user.id, kind: "user", label: "You", text: turn.user.content.slice(0, 2000) });
    const thought = turn.messages.filter(item => item.role === "assistant").map(item => item.thinking?.trim() ?? "").filter(Boolean).join("\n\n");
    if (thought) nodes.push({ id: `${turn.id}-think`, kind: "think", label: "Think", text: thought.slice(0, 12_000) });
    const results = new Map(turn.messages.filter(item => item.role === "tool").map(item => [item.toolCallId, item]));
    const tools = new Set<string>();
    for (const message of turn.messages) {
      for (const call of message.toolCalls ?? []) {
        if (tools.has(call.id)) continue;
        tools.add(call.id);
        const result = results.get(call.id);
        nodes.push({ id: `tool-${call.id}`, kind: "tool", label: `${call.function.name}${result?.isError ? " · failed" : ""}`, text: `${call.function.arguments}\n${result?.content ?? ""}`.slice(0, 4000) });
      }
      if (message.role === "tool" && !tools.has(message.toolCallId ?? message.id)) {
        tools.add(message.toolCallId ?? message.id);
        nodes.push({ id: message.id, kind: "tool", label: `${message.toolName ?? "Tool"}${message.isError ? " · failed" : ""}`, text: `${message.arguments ?? ""}\n${message.content}`.trim().slice(0, 4000) });
      }
    }
    const answer = turn.messages.findLast(item => item.role === "assistant");
    if (answer) nodes.push({ id: answer.id, kind: "reply", label: "Reply", text: answer.content.slice(0, 4000) });
    turn.nodes = nodes;
  }
  return turns;
}

const INSPECT_MEDIA = /(?:png|svg|html?)$/i;
const INSPECT_FILE = /`([^`\n]+\.(?:png|jpe?g|gif|webp|svg|html?|md|txt|json|csv|js|mjs|cjs|ts|jsx|tsx|css|py|ya?ml|sh))`|\]\(([^)\n]+\.(?:png|jpe?g|gif|webp|svg|html?|md|txt|json|csv|js|mjs|cjs|ts|jsx|tsx|css|py|ya?ml|sh))\)|(?<![\w/])([\w./-]+\.(?:png|jpe?g|gif|webp|svg|html?|md|txt|json|csv|js|mjs|cjs|ts|jsx|tsx|css|py|ya?ml|sh))\b/gi;

export function normalizeInspectPath(raw: string, cwd = ""): string | undefined {
  let path = raw.trim();
  if (!path || /https?:|\.\.|(?:secret|token|password|credential|\.env)/i.test(path)) return;
  if (cwd && path.startsWith(cwd.replace(/\/$/, "") + "/")) path = path.slice(cwd.replace(/\/$/, "").length + 1);
  else if (path.startsWith("/")) path = path.split("/").pop()!;
  path = path.replace(/^\.\//, "");
  return path || undefined;
}

export function inspectableSpans(text: string, cwd = ""): { start: number; end: number; path: string; raw: string }[] {
  INSPECT_FILE.lastIndex = 0;
  const out: { start: number; end: number; path: string; raw: string }[] = [];
  for (const match of text.matchAll(INSPECT_FILE)) {
    const path = normalizeInspectPath(match[1] || match[2] || match[3] || "", cwd);
    if (!path || match.index == null) continue;
    out.push({ start: match.index, end: match.index + match[0].length, path, raw: match[0] });
  }
  return out.slice(0, 8);
}

export function inspectablePaths(text: string, cwd = ""): string[] {
  const out: string[] = [];
  for (const span of inspectableSpans(text, cwd)) if (!out.includes(span.path)) out.push(span.path);
  return out;
}

export function latestPresentation(messages: Message[], cwd = ""): string | undefined {
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 8); i--) {
    const message = messages[i];
    if (message.role === "user" || message.status === "running") continue;
    const paths = inspectablePaths(message.content, cwd).filter(path => INSPECT_MEDIA.test(path));
    if (paths.length) return paths.at(-1);
  }
}

export const frontendTools = [
  { name: "patchShell", description: "Change the visible shell and persist it through rein serve.", parameters: { type: "object", properties: { patch: { type: "array", items: { type: "object", properties: { op: { enum: ["add", "remove", "replace", "test"] }, path: { enum: Object.keys(SHELL_FIELDS) }, value: {} }, required: ["op", "path"], additionalProperties: false } } }, required: ["patch"], additionalProperties: false } },
  { name: "setPref", description: "Choose the last opened bot.", parameters: { type: "object", properties: { key: { const: "lastBotId" }, value: { type: "string" } }, required: ["key", "value"], additionalProperties: false } },
  { name: "navigateTo", description: "Open bots, chat, or settings.", parameters: { type: "object", properties: { dest: { enum: ["bots", "chat", "settings"] } }, required: ["dest"], additionalProperties: false } },
  { name: "confirmAction", description: "Ask the operator to explicitly confirm an action.", parameters: { type: "object", properties: { action: { type: "string" }, importance: { enum: ["low", "medium", "high", "critical"] } }, required: ["action"], additionalProperties: false } }
];
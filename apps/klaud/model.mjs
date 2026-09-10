// This browser-safe cache validator has no filesystem or agent-loop imports.
import { AVATAR_STYLES } from "./avatar-catalog.mjs";
const avatarIds = AVATAR_STYLES.map(style => style.id);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
const string = (value, max = 4000) => typeof value === "string" && value.length > 0 && value.length <= max;
const fields = {
  "/theme/accent": ["rain", "slate", "storm"],
  "/theme/density": ["compact", "regular", "roomy"],
  "/theme/dark": [true, false],
  "/chrome/sidebar": [true, false],
  "/chrome/tray": ["hidden", "quiet", "normal"],
  "/chrome/showActivity": [true, false],
};
export function validateShell(shell) {
  if (!keys(shell, ["version", "theme", "chrome"]) || shell.version !== 1 || !keys(shell.theme, ["accent", "density", "dark"]) || !keys(shell.chrome, ["sidebar", "tray", "showActivity"])) throw new Error("Invalid shell snapshot.");
  for (const [path, values] of Object.entries(fields)) {
    const [, section, key] = path.split("/");
    if (!values.includes(shell[section][key])) throw new Error("Invalid shell setting.");
  }
  return shell;
}
export function validateState(state) {
  if (!keys(state, ["shell", "prefs", "bots", "approvals"])) throw new Error("Invalid state snapshot.");
  validateShell(state.shell);
  if (!object(state.prefs) || Object.keys(state.prefs).some(key => key !== "lastBotId") || state.prefs.lastBotId !== undefined && !string(state.prefs.lastBotId, 160)) throw new Error("Invalid preferences.");
  if (!Array.isArray(state.bots) || state.bots.some(bot => !object(bot) || !string(bot.id, 160) || !string(bot.name) || !string(bot.sessionId, 160) || bot.avatar !== undefined && !avatarIds.includes(bot.avatar)) || new Set(state.bots.map(bot => bot.id)).size !== state.bots.length) throw new Error("Invalid bots.");
  if (!Array.isArray(state.approvals) || state.approvals.some(item => !keys(item, ["id", "tool", "summary"]) || !string(item.id, 160) || !string(item.tool) || typeof item.summary !== "string")) throw new Error("Invalid approvals.");
  return structuredClone(state);
}
export function applyShellPatch(shell, patch) {
  validateShell(shell);
  if (!Array.isArray(patch) || patch.length > 256) throw new Error("Invalid shell patch.");
  const next = structuredClone(shell);
  for (const item of patch) {
    if (!object(item) || !Object.hasOwn(fields, item.path) || !["add", "remove", "replace", "test"].includes(item.op) || item.op !== "remove" && !Object.hasOwn(item, "value")) throw new Error("Invalid shell patch operation.");
    const [, section, key] = item.path.split("/");
    if (item.op !== "add" && !Object.hasOwn(next[section], key)) throw new Error("Missing patch path.");
    if (item.op === "test") { if (next[section][key] !== item.value) throw new Error("Shell patch test failed."); }
    else if (item.op === "remove") { if (item.path === "/theme/dark") throw new Error("Cannot remove dark setting."); delete next[section][key]; }
    else next[section][key] = item.value;
  }
  return validateShell(next);
}
export function applyDelta(state, delta) {
  const next = validateState(state);
  if (!Array.isArray(delta) || delta.some(op => !object(op) || typeof op.path !== "string" || !op.path.startsWith("/shell/"))) throw new Error("Invalid state delta. Refresh the snapshot.");
  next.shell = applyShellPatch(next.shell, delta.map(op => ({ ...op, path: op.path.slice(6) })));
  return validateState(next);
}
export function validateConnection(url, token) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || !/^http:\/\/127\.0\.0\.1:[1-9]\d*\/?$/.test(url)) throw new Error("Use http://127.0.0.1:<port> with no path.");
  if (typeof token !== "string" || !/^[\x21-\x7e]{1,512}$/.test(token)) throw new Error("Enter a valid bearer token.");
  return { url: parsed.origin, token };
}
const id = value => { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value)) throw new Error("Invalid identifier."); return encodeURIComponent(value); };
export function requestRoute(operation, input = {}) {
  if (!object(input)) throw new Error("Invalid request.");
  switch (operation) {
    case "state": return { method: "GET", path: "/state" };
    case "getRunSettings": return { method: "GET", path: "/settings" };
    case "getActivity": return { method: "GET", path: "/activity" };
    case "saveRunSettings": return { method: "POST", path: "/settings", body: validateRunSettings(input, true) };
    case "getAccounts": return { method: "GET", path: "/accounts" };
    case "saveProvider": return { method: "PUT", path: "/accounts/provider", body: input };
    case "startLogin": return { method: "POST", path: "/accounts/logins", body: input };
    case "getLogin": return { method: "GET", path: `/accounts/logins/${id(input.id)}` };
    case "cancelLogin": return { method: "DELETE", path: `/accounts/logins/${id(input.id)}` };
    case "getSetup": return { method: "GET", path: "/setup" };
    case "saveSetup": return { method: "POST", path: "/setup", body: input };
    case "probeModel": return { method: "POST", path: "/setup/probe", body: {} };
    case "discoverModels": return { method: "POST", path: "/setup/discover", body: input };
    case "setBotAvatar":
      if (!avatarIds.includes(input.avatar)) throw new Error("Choose a supported bot avatar.");
      return { method: "PATCH", path: `/bots/${id(input.id)}`, body: { avatar: input.avatar } };
    case "bots": return { method: "GET", path: "/bots" };
    case "messages":
      if (input.before !== undefined && (!Number.isSafeInteger(input.before) || input.before < 0)) throw new Error("Invalid history cursor.");
      return { method: "GET", path: `/bots/${id(input.id)}/messages${input.before === undefined ? "" : `?before=${input.before}`}` };
    case "createBot":
      if (!string(input.name, 64) || !input.name.trim()) throw new Error("Enter a bot name of at most 64 characters.");
      if (input.avatar !== undefined && !avatarIds.includes(input.avatar)) throw new Error("Choose a supported bot avatar.");
      return { method: "POST", path: "/bots", body: { name: input.name.trim(), ...(input.avatar === undefined ? {} : { avatar: input.avatar }) } };
    case "patchShell":
      if (!Array.isArray(input.patch)) throw new Error("Invalid shell patch.");
      return { method: "POST", path: "/state", body: { patch: input.patch } };
    case "setPref":
      if (input.key !== "lastBotId" || !string(input.value, 160)) throw new Error("Invalid preference.");
      return { method: "POST", path: "/prefs", body: { key: "lastBotId", value: input.value } };
    default: throw new Error("Unsupported backend operation.");
  }
}
export async function* sseEvents(body) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
      if (buffer.length > 1024 * 1024) throw new Error("Backend event is too large.");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data === "[DONE]") return;
        if (data) { const event = JSON.parse(data); if (!object(event) || !string(event.type, 100)) throw new Error("Invalid backend event."); yield event; }
      }
      if (done) { if (buffer.trim()) throw new Error("Incomplete backend event."); return; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.some(item => !object(item) || !string(item.id, 300) || !["user", "assistant", "tool"].includes(item.role) || typeof item.content !== "string" || item.toolCalls !== undefined && (!Array.isArray(item.toolCalls) || item.toolCalls.some(call => !object(call) || !string(call.id, 160) || !object(call.function) || !string(call.function.name, 160) || typeof call.function.arguments !== "string")))) throw new Error("Invalid bot transcript.");
  return structuredClone(messages);
}
const runSettingsValues = { bashApproval: ["auto", "ask"], reasoningEffort: ["default", "off", "low", "medium", "high"] };
export function validateRunSettings(value, partial = false) {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).some(key => key === "reasoningControl" && !partial ? false : !Object.hasOwn(runSettingsValues, key) || !runSettingsValues[key].includes(value[key])) || !partial && Object.keys(runSettingsValues).some(key => !Object.hasOwn(value, key))) throw new Error("Invalid run settings.");
  if (value.reasoningControl !== undefined) {
    const control = value.reasoningControl;
    if (!object(control) || Object.keys(control).some(key => !["supported", "mode", "description", "field"].includes(key)) || !Array.isArray(control.supported) || !control.supported.includes("default") || control.supported.some(effort => !runSettingsValues.reasoningEffort.includes(effort)) || !["supported", "server-dependent", "unsupported"].includes(control.mode) || !string(control.description) || control.field !== undefined && !string(control.field, 100)) throw new Error("Invalid reasoning control description.");
  }
  return { ...value };
}
export function publicProgress(value) {
  if (!object(value) || !["working", "thinking", "responding", "tool", "journaling", "autonomy"].includes(value.phase) || !Number.isSafeInteger(value.turn) || value.turn < 1) return null;
  return { phase: value.phase, turn: value.turn, ...(string(value.toolName, 160) ? { toolName: value.toolName } : {}) };
}
export function validateActivity(value) {
  const item = object(value) ? value.autonomy : undefined;
  if (!object(item) || !["inactive", "running", "unavailable"].includes(item.status) || (item.status === "running" ? !["scan", "routine"].includes(item.kind) : item.kind !== undefined)) throw new Error("Invalid activity status.");
  return { autonomy: { status: item.status, ...(item.status === "running" ? { kind: item.kind } : {}) } };
}
export const transcriptViews = ["replies", "activity", "full"];
const transcriptViewKey = "rein.klaud.transcript-view";
export function readTranscriptView(storage) {
  try { const value = (storage ?? globalThis.localStorage)?.getItem(transcriptViewKey); return transcriptViews.includes(value) ? value : "activity"; }
  catch { return "activity"; }
}
export function saveTranscriptView(value, storage) {
  if (!transcriptViews.includes(value)) throw new Error("Invalid transcript view.");
  try { (storage ?? globalThis.localStorage)?.setItem(transcriptViewKey, value); } catch { /* The selection still applies when device storage is unavailable. */ }
  return value;
}
const textContent = content => typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
/** Stream only public text, tool records and reported completion metadata. */
export function updateTranscript(messages, event) {
  let messageId, transform;
  if (["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"].includes(event.type)) {
    if (!string(event.messageId, 300)) throw new Error("Invalid transcript message identifier.");
    if (event.type === "TEXT_MESSAGE_CONTENT" && typeof event.delta !== "string") throw new Error("Invalid transcript text delta.");
    if (event.type === "TEXT_MESSAGE_END" && event.content !== undefined && typeof event.content !== "string") throw new Error("Invalid completed transcript text.");
    messageId = event.messageId;
    transform = existing => ({ ...existing, id: messageId, role: "assistant", content: event.type === "TEXT_MESSAGE_END" && event.content !== undefined ? event.content : (existing?.content ?? "") + (event.type === "TEXT_MESSAGE_CONTENT" ? event.delta : ""), ...(event.completion ? { completion: publicCompletion(event.completion) } : {}) });
  } else if (["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_RESULT"].includes(event.type)) {
    if (!string(event.toolCallId, 160)) throw new Error("Invalid tool call identifier.");
    if (event.type === "TOOL_CALL_ARGS" && typeof event.delta !== "string") throw new Error("Invalid tool argument delta.");
    messageId = messages.find(item => item.role === "tool" && item.toolCallId === event.toolCallId)?.id ?? `tool-${event.toolCallId}`;
    transform = existing => ({ ...existing, id: messageId, role: "tool", toolCallId: event.toolCallId,
      toolName: event.toolCallName ?? event.toolName ?? existing?.toolName ?? "Tool call",
      arguments: (existing?.arguments ?? "") + (event.type === "TOOL_CALL_ARGS" ? event.delta : ""),
      content: event.type === "TOOL_CALL_RESULT" ? textContent(event.content) : existing?.content ?? "",
      status: event.type === "TOOL_CALL_RESULT" ? "complete" : existing?.status ?? "running",
      isError: event.type === "TOOL_CALL_RESULT" ? event.isError === true : existing?.isError === true,
    });
  } else return messages;
  const index = messages.findIndex(item => item.id === messageId), next = [...messages];
  const message = transform(index < 0 ? undefined : messages[index]);
  if (index < 0) next.push(message); else next[index] = message;
  return next;
}
export function publicCompletion(value) {
  const result = {};
  if (object(value) && ["stop", "length", "toolUse", "error", "aborted", "budget"].includes(value.stopReason)) result.stopReason = value.stopReason;
  if (object(value) && Number.isSafeInteger(value.reasoningTokens) && value.reasoningTokens > 0) result.reasoningTokens = value.reasoningTokens;
  return result;
}
/** Coalesce historical call/result pairs while retaining failures in every view. */
export function presentTranscript(messages, view = "activity") {
  if (!transcriptViews.includes(view)) throw new Error("Invalid transcript view.");
  const results = new Map(messages.filter(item => item.role === "tool" && item.toolCallId).map(item => [item.toolCallId, item]));
  const rendered = new Set(), rows = [];
  const toolRow = (call, result) => ({ ...result, id: result?.id ?? `tool-${call.id}`, role: "tool", toolCallId: call.id,
    toolName: result?.toolName ?? call.function?.name ?? "Tool call", arguments: result?.arguments ?? call.function?.arguments ?? "", content: result?.content ?? "", status: result ? result.status ?? "complete" : "recorded", isError: result?.isError === true });
  for (const item of messages) {
    if (item.role === "user" || item.role === "assistant" && item.content.trim()) rows.push({ ...item, toolCalls: undefined, ...(item.completion ? { completion: publicCompletion(item.completion) } : {}) });
    if (item.role === "assistant") for (const call of item.toolCalls ?? []) {
      if (rendered.has(call.id)) continue;
      rendered.add(call.id); rows.push(toolRow(call, results.get(call.id)));
    }
    if (item.role === "tool" && (!item.toolCallId || !rendered.has(item.toolCallId))) {
      if (item.toolCallId) rendered.add(item.toolCallId);
      rows.push({ ...item, toolName: item.toolName ?? "Tool call", arguments: item.arguments ?? "", status: item.status ?? "complete" });
    }
  }
  return rows.filter(item => view !== "replies" || item.role !== "tool" || item.isError === true);
}
export function replayEvents(run) {
  // Finished turns may already be durable. Replay only against the saved pre-run baseline.
  if (run.replayTruncated) return [...run.pending.values()].filter(pending => !pending.prompting).map(pending => pending.event);
  return run.events.filter(event => !["STATE_SNAPSHOT", "STATE_DELTA"].includes(event.type) && (event.type !== "CUSTOM" || run.pending.has(event.value?.toolCallId ?? event.value?.id) && !run.pending.get(event.value?.toolCallId ?? event.value?.id).prompting));
}
export const frontendTools = [
  { name: "patchShell", description: "Change the visible shell and persist it through rein serve.", parameters: { type: "object", properties: { patch: { type: "array", items: { type: "object", properties: { op: { enum: ["add", "remove", "replace", "test"] }, path: { enum: Object.keys(fields) }, value: {} }, required: ["op", "path"], additionalProperties: false } } }, required: ["patch"], additionalProperties: false } },
  { name: "setPref", description: "Choose the last opened bot.", parameters: { type: "object", properties: { key: { const: "lastBotId" }, value: { type: "string" } }, required: ["key", "value"], additionalProperties: false } },
  { name: "navigateTo", description: "Open bots, chat, or settings.", parameters: { type: "object", properties: { dest: { enum: ["bots", "chat", "settings"] } }, required: ["dest"], additionalProperties: false } },
  { name: "confirmAction", description: "Ask the user to explicitly confirm an action.", parameters: { type: "object", properties: { action: { type: "string" }, importance: { enum: ["low", "medium", "high", "critical"] } }, required: ["action"], additionalProperties: false } },
];

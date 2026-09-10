/** Loopback AG-UI transport. The runner owns execution and session persistence. */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "../../agent/agent-loop.ts";
import { createSession, loadSession, sessionPath } from "../../agent/session.ts";
import type { AssistantMessage, AssistantMessageEvent, Tool } from "../../ai/types.ts";
import { stateDelta, stateSnapshot, toAgUiEvents } from "../../ai/ag-ui.ts";
import type { AgUiEvent } from "../../ai/ag-ui.ts";
import { createRunner } from "../runner.ts";
import { applyKlaudPatch, loadKlaudShell, saveKlaudShell } from "./shell.ts";
import type { JsonPatchOp, KlaudSharedState } from "./shell.ts";
import { createKlaudTools } from "./tools.ts";
import { createBot, getBot, listBots, setBotAvatar, validateBotAvatar } from "./bots.ts";
import type { KlaudBot } from "./bots.ts";
import { loadKlaudRunSettings, saveKlaudRunSettings, validateRunSettingsPatch } from "./settings.ts";
import { reasoningCapabilities, type ReasoningCapabilities } from "../../ai/reasoning.ts";
import { klaudActivity } from "./activity.ts";
import { loadConfig, guessProvider, normalizeBaseUrl, PROVIDER_PRESETS } from "../../ai/models.ts";

import { createMobileAccounts, MobileAccountError } from "./mobile-accounts.ts";
import { readKlaudSetup, saveKlaudSetup, probeKlaudModel, discoverKlaudModels } from "./setup.ts";
import { inspectHardware } from "../../hardware/inspection.ts";

export interface ServeOptions {
	host?: "127.0.0.1";
	port?: number;
	home?: string;
	token?: string;
	cwd?: string;
	/** Tests only. Production always uses createRunner and persisted sessions. */
	run?: (msg: string, tools?: Tool[]) => AsyncIterable<AssistantMessageEvent>;
}
export interface ServeHandle { url: string; token: string; close(): Promise<void>; }

const MAX_BODY = 256 * 1024;
// A phone may lock or change networks while the host waits. Keep the prompt
// recoverable long enough for a normal mobile return, then fail closed.
const PENDING_TIMEOUT = 30 * 60_000;
const FRONTEND_NAMES = new Set(["patchShell", "setPref", "navigateTo", "confirmAction"]);
const PUBLIC_STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted", "budget"]);
const processHome = () => resolve(process.env.REIN_HOME || join(homedir(), ".rein"));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const invalid = (message: string): never => { throw new HttpError(400, message); };
function json(res: ServerResponse, status: number, value: unknown) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
}
function checkStorage(file: string) {
	for (const [path, directory] of [[dirname(dirname(file)), true], [dirname(file), true], [file, false]] as const) {
		try {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("rein-klaʊd storage must use ordinary files and directories, never symlinks.");
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}
function privateRead(file: string): string | undefined {
	checkStorage(file);
	let fd: number;
	try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	try { if (fstatSync(fd).size > MAX_BODY) throw new Error("rein-klaʊd state file is too large."); return readFileSync(fd, "utf8"); }
	finally { closeSync(fd); }
}
function privateWrite(file: string, content: string) {
	checkStorage(file);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	checkStorage(file);
	const temp = `${file}.${randomUUID()}.tmp`;
	try { writeFileSync(temp, content, { flag: "wx", mode: 0o600 }); checkStorage(file); renameSync(temp, file); }
	finally { if (existsSync(temp)) unlinkSync(temp); }
}
function readPrefs(file: string): KlaudSharedState["prefs"] {
	const raw = privateRead(file), prefs: unknown = raw === undefined ? {} : JSON.parse(raw);
	if (!object(prefs) || Object.keys(prefs).some(key => key !== "lastBotId") || (prefs.lastBotId !== undefined && (typeof prefs.lastBotId !== "string" || !prefs.lastBotId || prefs.lastBotId.length > 160))) throw new Error("Invalid rein-klaʊd preferences.");
	return prefs as KlaudSharedState["prefs"];
}
function requestedBot(id: unknown, home: string): KlaudBot {
	if (typeof id !== "string") invalid("A bot id is required.");
	try { return getBot(id, home); }
	catch (error) {
		if (error instanceof Error && error.message === "Invalid bot id.") invalid(error.message);
		if (error instanceof Error && error.message.startsWith("No such bot:")) throw new HttpError(404, "No such bot.");
		throw error;
	}
}
function publicCompletion(message: AssistantMessage): { stopReason?: string; reasoningTokens?: number } | undefined {
	const stopReason = typeof message.stopReason === "string" && PUBLIC_STOP_REASONS.has(message.stopReason) ? message.stopReason : undefined;
	const reasoning = object(message.usage) ? message.usage.reasoning : undefined;
	const reasoningTokens = typeof reasoning === "number" && Number.isSafeInteger(reasoning) && reasoning > 0 ? reasoning : undefined;
	return stopReason === undefined && reasoningTokens === undefined ? undefined : {
		...(stopReason ? { stopReason } : {}),
		...(reasoningTokens ? { reasoningTokens } : {}),
	};
}
// Provider IDs may be reused across turns and may already be at the UI length
// limit. Stable scoped digests keep display identities distinct and bounded.
function displayToolId(scope: string, providerId: string): string { return `tool-${createHash("sha256").update(`${scope}\0${providerId}`).digest("hex")}`; }
function botMessages(bot: KlaudBot, home: string, before?: number) {
	const file = sessionPath(bot.sessionId, home);
	checkStorage(file);
	if (!existsSync(file)) throw new HttpError(404, "Bot session is missing.");
	const toolIds = new Map<string, string>();
	const messages = loadSession(bot.sessionId, home).messages.flatMap(message => {
		if (message.role === "user") return [{ id: message.id, role: "user", content: message.content }];
		const content = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		if (message.role === "toolResult") return [{ id: message.id, role: "tool", content, toolCallId: toolIds.get(message.toolCallId) ?? displayToolId(message.id, message.toolCallId), providerToolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError === true }];
		const toolCalls = message.content.filter(part => part.type === "toolCall").map(part => {
			const id = displayToolId(message.id, part.id); toolIds.set(part.id, id);
			return { id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.arguments) } };
		});
		const completion = publicCompletion(message);
		// Only display text and tool records; never serialize thinking or private session metadata.
		return content || toolCalls.length ? [{ id: message.id, role: "assistant", content, ...(toolCalls.length ? { toolCalls } : {}), ...(completion ? { completion } : {}) }] : [];
	});
	const end = Math.min(before ?? messages.length, messages.length);
	const page: Record<string, unknown>[] = [];
	let start = end, bytes = 0;
	while (start > 0 && page.length < 100) {
		const message: any = structuredClone(messages[start - 1]);
		const preview = (value: string, limit: number) => { if (value.length <= limit) return value; message.truncated = true; return value.slice(0, limit) + "\n[Preview shortened; full text remains in session history.]"; };
		message.content = preview(message.content, 32_768);
		if (message.toolCalls) {
			if (message.toolCalls.length > 16) message.truncated = true;
			message.toolCalls = message.toolCalls.slice(0, 16).map((call: any) => ({ ...call, function: { ...call.function, arguments: preview(call.function.arguments, 4096) } }));
		}
		const size = Buffer.byteLength(JSON.stringify(message));
		if (page.length && bytes + size > 2 * 1024 * 1024) break;
		bytes += size; page.unshift(message); start--;
	}
	return { messages: page, before: start || null };
}
function body(req: IncomingMessage): Promise<Record<string, unknown>> {
	if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return Promise.reject(new HttpError(415, "Use application/json."));
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		const cleanup = () => { clearTimeout(timer); req.removeListener("data", data); req.removeListener("end", end); req.removeListener("aborted", aborted); req.removeListener("error", fail); };
		const fail = (error: Error) => { cleanup(); chunks.length = 0; req.resume(); reject(error); };
		const aborted = () => fail(new HttpError(400, "Request aborted."));
		const data = (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY) fail(new HttpError(413, "Request body is too large.")); else chunks.push(chunk); };
		const end = () => {
			cleanup();
			try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!object(value)) invalid("Expected a JSON object."); resolve(value); }
			catch (error) { reject(error instanceof HttpError ? error : new HttpError(400, "Invalid JSON.")); }
		};
		const timer = setTimeout(() => fail(new HttpError(408, "Request body timed out.")), 10_000); timer.unref();
		req.on("data", data); req.once("end", end); req.once("aborted", aborted); req.once("error", fail);
	});
}
function frontendDeclarations(value: unknown): Tool[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > FRONTEND_NAMES.size) invalid("Invalid frontend tools.");
	const names = new Set<string>();
	return value.map(raw => {
		if (!object(raw) || typeof raw.name !== "string" || !FRONTEND_NAMES.has(raw.name) || names.has(raw.name) || typeof raw.description !== "string" || raw.description.length > 4000 || !object(raw.parameters) || raw.parameters.type !== "object") invalid("Only distinct declared rein-klaʊd frontend tools are supported.");
		names.add(raw.name);
		return { name: raw.name, description: raw.description, parameters: raw.parameters as Tool["parameters"] };
	});
}
function validateFrontend(name: string, args: Record<string, unknown>) {
	if (name === "patchShell") {
		if (Object.keys(args).some(key => key !== "patch") || !Array.isArray(args.patch)) invalid("patchShell requires {patch}.");
	} else if (name === "setPref") {
		if (Object.keys(args).some(key => !["key", "value"].includes(key)) || args.key !== "lastBotId" || typeof args.value !== "string" || !args.value || args.value.length > 160) invalid("setPref supports only lastBotId.");
	} else if (name === "navigateTo") {
		if (Object.keys(args).some(key => key !== "dest") || !["bots", "chat", "settings"].includes(String(args.dest))) invalid("Invalid navigation destination.");
	} else if (Object.keys(args).some(key => !["action", "importance"].includes(key)) || typeof args.action !== "string" || !args.action.trim() || args.action.length > 4000 || (args.importance !== undefined && !["low", "medium", "high", "critical"].includes(String(args.importance)))) invalid("Invalid confirmAction arguments.");
}
interface Pending {
	kind: "tool" | "approval";
	tool: string;
	args: Record<string, unknown>;
	summary: string;
	settle(value: AgentToolResult | boolean): void;
}
interface ActiveRun {
	id: string;
	threadId: string;
	controller: AbortController;
	pending: Map<string, Pending>;
	emit(event: AgUiEvent): void;
}
/** Race a stalled test producer against cancellation without holding HTTP shutdown open. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("Run cancelled."));
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Run cancelled."));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export async function startKlaudServe(opts: ServeOptions = {}): Promise<ServeHandle> {
	if (opts.host !== undefined && opts.host !== "127.0.0.1") throw new Error("rein serve binds only to 127.0.0.1.");
	if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)) throw new Error("Invalid port, expected 0 through 65535.");
	const home = resolve(opts.home ?? processHome()), cwd = resolve(opts.cwd ?? process.cwd());
	// Runner, model config, and session APIs are process-scoped. Never switch env for a request.
	const checkHome = () => { if (!opts.run && home !== processHome()) throw new Error("Set REIN_HOME to the requested home before starting rein serve; the runner uses process-wide configuration and sessions."); };
	checkHome();
	loadKlaudShell(home);
	loadKlaudRunSettings(home);
	const prefsFile = join(home, "klaud", "prefs.json");
	readPrefs(prefsFile);
	const reasoningControl = (): ReasoningCapabilities => {
		// Read configured identity only. Opening Settings must not discover a
		// network or call a model. Runtime resolution revalidates before a run.
		const config = loadConfig(), envBase = process.env.REIN_BASE_URL?.trim();
		const provider = envBase ? guessProvider(envBase, "custom") : config.provider?.toLowerCase() ?? (config.auth?.type === "cli" ? config.auth.provider : undefined) ?? (config.baseUrl ? guessProvider(config.baseUrl, "custom") : "unconfigured");
		if (provider === "unconfigured") return { supported: ["default"], mode: "unsupported", description: "Connect a model to configure its reasoning effort. Provider default keeps the serving model's own settings." };
		const baseUrl = envBase || (["codex", "copilot", "grok"].includes(provider) ? `cli://${provider}` : config.baseUrl ?? PROVIDER_PRESETS[provider]?.baseUrl ?? "");
		let sameEndpoint = !envBase;
		try { if (envBase) sameEndpoint = normalizeBaseUrl(envBase) === normalizeBaseUrl(config.baseUrl ?? PROVIDER_PRESETS[provider]?.baseUrl ?? ""); } catch { /* Keep unknown model identity unknown. */ }
		const model = process.env.REIN_MODEL?.trim() || (sameEndpoint ? config.model : undefined) || "unknown";
		return reasoningCapabilities({ id: model, provider, baseUrl });
	};
	const accounts = createMobileAccounts({ home });
	const runSettingsResponse = () => ({ ...loadKlaudRunSettings(home), reasoningControl: reasoningControl() });
	const token = opts.token ?? randomBytes(24).toString("hex");
	if (!/^[\x21-\x7e]{1,512}$/.test(token)) throw new Error("The bearer token must be nonempty printable ASCII without spaces.");
	const authorization = Buffer.from(`Bearer ${token}`);
	const active = new Map<string, ActiveRun>(), threads = new Set<string>();
	const executions = new Set<Promise<void>>();
	let url = "", tokenFile: string | undefined, closing: Promise<void> | undefined;
	const snapshot = (): KlaudSharedState => {
		const bots = listBots(home), prefs = readPrefs(prefsFile);
		return { shell: loadKlaudShell(home), prefs: bots.some(bot => bot.id === prefs.lastBotId) ? prefs : {}, bots,
			approvals: [...active.values()].flatMap(run => [...run.pending.entries()].filter(([, pending]) => pending.kind === "approval" || pending.tool === "confirmAction").map(([id, pending]) => ({ id, tool: pending.tool, summary: pending.summary }))) };
	};
	const savePref = (value: unknown) => { const bot = requestedBot(value, home); privateWrite(prefsFile, JSON.stringify({ lastBotId: bot.id }) + "\n"); };
	const broadcast = (event: AgUiEvent) => { for (const run of active.values()) run.emit(event); };
	const publishState = () => broadcast(stateSnapshot(snapshot()));
	function waitFor(run: ActiveRun, id: string, kind: Pending["kind"], tool: string, args: Record<string, unknown>): Promise<AgentToolResult | boolean> {
		if (run.controller.signal.aborted) return Promise.reject(new Error("Run cancelled."));
		if (run.pending.has(id)) return Promise.reject(new Error("Duplicate pending tool call id."));
		return new Promise((resolve, reject) => {
			const signal = run.controller.signal;
			const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); run.pending.delete(id); };
			const abort = () => { cleanup(); reject(new Error("Run cancelled.")); };
			const settle = (value: AgentToolResult | boolean) => { cleanup(); resolve(value); };
			const timer = setTimeout(() => { settle(kind === "approval" ? false : { content: "The renderer did not answer before the timeout.", isError: true }); publishState(); }, PENDING_TIMEOUT); timer.unref();
			const summary = JSON.stringify(args).slice(0, 1000);
			run.pending.set(id, { kind, tool, args: structuredClone(args), summary, settle });
			signal.addEventListener("abort", abort, { once: true });
			publishState();
			run.emit({ type: "CUSTOM", name: kind === "approval" ? "klaud.approval" : "klaud.frontend_tool", value: kind === "approval" ? { runId: run.id, id, tool, summary } : { runId: run.id, toolCallId: id, toolName: tool, args } });
		});
	}
	function runTools(run: ActiveRun, declarations: Tool[]): AgentTool[] {
		const backend = createKlaudTools(home).map(tool => ({ ...tool, async execute(id: string, args: Record<string, unknown>, signal?: AbortSignal) {
			if (run.controller.signal.aborted || signal?.aborted) throw new Error("Run cancelled.");
			const result = await tool.execute(id, args, signal);
			if (tool.name === "klaud_patch_shell" && !result.isError) { broadcast(stateDelta(args.patch as JsonPatchOp[])); publishState(); }
			return result;
		} }));
		const frontend = declarations.map(tool => ({ ...tool, executionMode: "sequential" as const, async execute(id: string, args: Record<string, unknown>): Promise<AgentToolResult> {
			validateFrontend(tool.name, args);
			if (tool.name === "patchShell") applyKlaudPatch(loadKlaudShell(home), args.patch as JsonPatchOp[]);
			if (tool.name === "setPref") requestedBot(args.value, home);
			return await waitFor(run, id, "tool", tool.name, args) as AgentToolResult;
		} }));
		return [...backend, ...frontend];
	}
	async function streamRun(res: ServerResponse, input: Record<string, unknown>, declarations: Tool[], sessionId: string, bot?: KlaudBot) {
		const threadId = input.threadId as string, id = randomUUID(), controller = new AbortController();
		const run: ActiveRun = { id, threadId, controller, pending: new Map(), emit(event) {
			if (res.destroyed || res.writableEnded) return;
			res.write(`data: ${JSON.stringify(event)}\n\n`);
			// Bound queued output for clients that stop reading. Don't buffer a whole run.
			if (res.writableLength > MAX_BODY * 4) { controller.abort(); res.destroy(); }
		} };
		active.set(id, run); threads.add(sessionId);
		const disconnected = () => controller.abort();
		res.once("close", disconnected);
		res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
		res.flushHeaders();
		let turn = 0, failure: string | undefined;
		const toolIds = new Map<string, string>(), startedTools = new Set<string>();
		const startTool = (providerId: string, name: string) => {
			const scopedId = toolIds.get(providerId) ?? displayToolId(`${id}:${Math.max(0, turn - 1)}`, providerId);
			toolIds.set(providerId, scopedId);
			if (!startedTools.has(scopedId)) {
				startedTools.add(scopedId);
				run.emit({ type: "TOOL_CALL_START", toolCallId: scopedId, providerToolCallId: providerId, toolCallName: name });
			}
			return scopedId;
		};
		const endAssistant = (message: AssistantMessage) => {
			for (const [contentIndex, part] of message.content.entries()) {
				if (part.type === "text") run.emit({ type: "TEXT_MESSAGE_END", messageId: `${id}:${turn}:${contentIndex}`, content: part.text, completion: publicCompletion(message) });
			}
			turn++;
		};
		let completion: { stopReason: AssistantMessage["stopReason"]; reasoningTokens?: number } | undefined;
		const onAssistant = (event: AssistantMessageEvent) => {
			if (controller.signal.aborted) return;
			if (event.type === "done") { failure = undefined; endAssistant(event.message); return; }
			if (event.type === "error") { failure = event.error.errorMessage || event.reason; endAssistant(event.error); return; }
			if (event.type === "thinking_start" || event.type === "text_start") run.emit({ type: "CUSTOM", name: "klaud.progress", value: { phase: event.type === "thinking_start" ? "thinking" : "responding", turn: turn + 1 } });
			if (event.type === "toolcall_start" || event.type === "toolcall_end") {
				const call = event.type === "toolcall_end" ? event.toolCall : event.partial.content[event.contentIndex];
				if (call?.type === "toolCall") { toolIds.set(call.id, displayToolId(`${id}:${turn}`, call.id)); startTool(call.id, call.name); }
			}
			for (const encoded of toAgUiEvents(event, { threadId, runId: `${id}:${turn}` })) {
				if (encoded.type === "TOOL_CALL_START") continue; // One canonical start per scoped call.
				if (typeof encoded.toolCallId === "string") run.emit({ ...encoded, providerToolCallId: encoded.toolCallId, toolCallId: toolIds.get(encoded.toolCallId) ?? displayToolId(`${id}:${turn}`, encoded.toolCallId) });
				else run.emit(encoded);
			}
		};
		const finalStatus = (message: AssistantMessage) => {
			completion = {
				stopReason: message.stopReason,
				...(Number.isSafeInteger(message.usage.reasoning) && (message.usage.reasoning ?? 0) > 0
					? { reasoningTokens: message.usage.reasoning }
					: {}),
			};
			if (["error", "aborted", "budget", "length", "pending"].includes(message.stopReason)) failure = message.errorMessage || (message.stopReason === "budget" ? "Turn budget reached. Continue the run to resume." : `Run stopped: ${message.stopReason}.`);
			else failure = undefined;
		};
		try {
			run.emit({ type: "RUN_STARTED", threadId, runId: id });
			run.emit(stateSnapshot(snapshot()));
			const additions = runTools(run, declarations);
			if (opts.run) {
				const iterator = opts.run(input.message as string, additions)[Symbol.asyncIterator]();
				try {
					while (!controller.signal.aborted) {
						const next = await abortable(iterator.next(), controller.signal);
						if (next.done) break;
						onAssistant(next.value);
						if (next.value.type === "done") finalStatus(next.value.message);
					}
				} finally { if (controller.signal.aborted) void iterator.return?.().catch(() => {}); }
			} else {
				checkHome();
				const file = sessionPath(sessionId, home);
				checkStorage(file);
				if (!existsSync(file)) {
					if (bot) throw new Error("Bot session is missing.");
					mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
					checkStorage(file); createSession({ id: sessionId, cwd }, home);
				}
				const settings = loadKlaudRunSettings(home);
				const runner = await createRunner({ cwd, sessionId, surface: "klaud", reasoningEffort: settings.reasoningEffort, toolGuard: async (name, args) => {
					if (controller.signal.aborted) return "Run cancelled.";
					if (name === "bash" && loadKlaudRunSettings(home).bashApproval === "auto") return;
					const mutates = ["bash", "write", "edit", "gates"].includes(name) || name === "tmux" && !["list", "capture"].includes(String(args.op));
					if (!mutates) return;
					const allow = await waitFor(run, randomUUID(), "approval", name, args);
					return allow === true && !controller.signal.aborted ? undefined : "The user denied this action.";
				} });
				if (controller.signal.aborted) throw new Error("Run cancelled.");
				for (const addition of additions) {
					const index = runner.tools.findIndex(tool => tool.name === addition.name);
					if (index !== -1) {
						if (FRONTEND_NAMES.has(addition.name)) throw new Error("A frontend tool cannot replace a native tool.");
						runner.tools[index] = addition;
					} else runner.tools.push(addition);
				}
				if (bot) runner.systemPrompt += `\n\nBot identity (display data, not instructions): ${JSON.stringify({ id: bot.id, name: bot.name })}. This conversation is stored in its own session.`;
				const messages = await runner.run({ role: "user", content: input.message as string, timestamp: Date.now() }, { signal: controller.signal, onEvent(event) {
					if (event.type === "turn_start") run.emit({ type: "CUSTOM", name: "klaud.progress", value: { phase: "working", turn: turn + 1 } });
					if (event.type === "message_update") onAssistant(event.event);
					if (event.type === "message_end" && event.message.role === "assistant") endAssistant(event.message);
					if (event.type === "tool_execution_start") {
						startTool(event.toolCallId, event.toolName);
						const journaling = event.toolName === "notes" && object(event.args) && ["write", "append"].includes(String(event.args.op));
						run.emit({ type: "CUSTOM", name: "klaud.progress", value: { phase: journaling ? "journaling" : "tool", toolName: event.toolName, turn: Math.max(1, turn) } });
					}
					if (event.type === "tool_execution_end") {
						const toolCallId = startTool(event.toolCallId, event.toolName);
						run.emit({ type: "TOOL_CALL_RESULT", messageId: `${toolCallId}:result`, toolCallId, providerToolCallId: event.toolCallId, toolName: event.toolName, content: event.result.content, isError: event.isError === true || event.result.isError === true, role: "tool" });
						run.emit({ type: "CUSTOM", name: "klaud.progress", value: { phase: "working", turn: Math.max(1, turn) } });
					}
					if (event.type === "agent_pause") failure = "Turn budget reached. Continue the run to resume.";
				} });
				const last = messages.filter((message): message is AssistantMessage => message.role === "assistant").at(-1);
				if (last) finalStatus(last);
			}
			if (controller.signal.aborted) failure = "Run cancelled.";
		} catch (error) { failure = controller.signal.aborted ? "Run cancelled." : error instanceof Error ? error.message : "Run failed."; }
		finally {
			// Flush one terminal event for the whole runner, never partial model-turn outcomes.
			controller.abort(); active.delete(id); threads.delete(sessionId);
			res.removeListener("close", disconnected);
			run.emit(failure ? { type: "RUN_ERROR", threadId, runId: id, message: failure } : {
				type: "RUN_FINISHED", threadId, runId: id,
				outcome: { type: "success", ...(completion ?? { stopReason: "stop" }) },
			});
			if (!res.destroyed && !res.writableEnded) res.end("data: [DONE]\n\n");
			publishState();
		}
	}
	const server = createServer((req, res) => {
		res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "DENY");
		void (async () => {
			if (closing) throw new HttpError(503, "Server is closing.");
			if (req.headers.host !== url.slice(7) || req.headers.origin && req.headers.origin !== url) throw new HttpError(403, "Invalid Host or Origin.");
			if (req.method === "GET" && req.url === "/health") { json(res, 200, { ok: true, name: "rein-klaud" }); return; }
			const provided = Buffer.from(req.headers.authorization ?? "");
			if (provided.length !== authorization.length || !timingSafeEqual(provided, authorization)) throw new HttpError(401, "Bearer token required.");
			if (req.method === "GET" && req.url === "/state") { json(res, 200, snapshot()); return; }
			if (req.method === "GET" && req.url === "/settings") { json(res, 200, runSettingsResponse()); return; }
			if (req.method === "GET" && req.url === "/activity") { json(res, 200, klaudActivity(home)); return; }
			if (req.method === "POST" && req.url === "/settings") {
				try {
					const input = await body(req); validateRunSettingsPatch(input);
					const control = reasoningControl();
					if (input.reasoningEffort && !control.supported.includes(input.reasoningEffort)) invalid(control.description);
					saveKlaudRunSettings(input, home); json(res, 200, runSettingsResponse());
				}
				catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, error instanceof Error ? error.message : "Invalid run settings."); }
				return;
			}

            if (req.method === "GET" && req.url === "/accounts") { json(res, 200, await accounts.list()); return; }
            if (req.method === "PUT" && req.url === "/accounts/provider") {
                if (active.size) throw new HttpError(409, "Finish or stop the current run before changing its model connection.");
                const input = await body(req);
                // A run can start while the request body is still arriving.
                if (active.size) throw new HttpError(409, "Finish or stop the current run before changing its model connection.");
                json(res, 200, accounts.select(input)); return;
            }
            if (req.method === "POST" && req.url === "/accounts/logins") { json(res, 202, accounts.start(await body(req))); return; }
            const loginRoute = /^\/accounts\/logins\/([a-f0-9-]+)$/.exec(req.url ?? "");
            if (loginRoute && req.method === "GET") { json(res, 200, accounts.get(loginRoute[1])); return; }
            if (loginRoute && req.method === "DELETE") { json(res, 200, accounts.cancel(loginRoute[1])); return; }
            if (req.url?.startsWith("/setup")) {
                if (active.size && req.method !== "GET") throw new HttpError(409, "Finish or stop the current run before changing setup.");
                try {
                    if (req.method === "GET" && req.url === "/setup") { json(res, 200, readKlaudSetup(home)); return; }
                    if (req.method === "POST" && ["/setup", "/setup/probe", "/setup/discover", "/setup/hardware"].includes(req.url ?? "")) {
                        const input = await body(req);
                        if (active.size) throw new HttpError(409, "Finish or stop the current run before changing setup.");
                        if (req.url === "/setup") { json(res, 200, saveKlaudSetup(input, home)); return; }
                        if (req.url === "/setup/probe") { json(res, 200, await probeKlaudModel(home)); return; }
                        if (req.url === "/setup/hardware") { json(res, 200, await inspectHardware(input)); return; }
                        json(res, 200, await discoverKlaudModels(input)); return;
                    }
                } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, error instanceof Error ? error.message : "Setup could not be saved."); }
            }
			if (req.method === "GET" && req.url === "/bots") { json(res, 200, listBots(home)); return; }
			if (req.method === "POST" && req.url === "/bots") {
				const input = await body(req);
				if (Object.keys(input).some(key => !["name", "avatar"].includes(key)) || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.name)) invalid("Use a bot name of 1 to 64 characters without control characters.");
				if (input.avatar !== undefined) { try { validateBotAvatar(input.avatar); } catch { invalid("Choose a supported bot avatar."); } }
				const bot = createBot(input.name, home, cwd, input.avatar as KlaudBot["avatar"]); publishState(); json(res, 201, bot); return;
			}
            const avatarRoute = /^\/bots\/([^/]+)$/.exec(req.url ?? "");
            if (req.method === "PATCH" && avatarRoute) {
                const input = await body(req);
                if (Object.keys(input).length !== 1 || !("avatar" in input)) invalid("Use {avatar} to change a bot's headwear.");
                try { validateBotAvatar(input.avatar); } catch { invalid("Choose a supported bot avatar."); }
                const bot = requestedBot(avatarRoute[1], home);
                const updated = setBotAvatar(bot.id, input.avatar, home); publishState(); json(res, 200, updated); return;
            }
			const messagesRoute = /^\/bots\/([^/]+)\/messages(?:\?before=(\d+))?$/.exec(req.url ?? "");
			if (req.method === "GET" && messagesRoute) {
				const before = messagesRoute[2] === undefined ? undefined : Number(messagesRoute[2]);
				if (before !== undefined && !Number.isSafeInteger(before)) invalid("Invalid history cursor.");
				json(res, 200, botMessages(requestedBot(messagesRoute[1], home), home, before)); return;
			}
			if (req.method === "POST" && req.url === "/prefs") {
				const input = await body(req); validateFrontend("setPref", input); savePref(input.value); publishState(); json(res, 200, snapshot()); return;
			}
			if (req.method === "POST" && req.url === "/state") {
				const input = await body(req);
				try { const next = applyKlaudPatch(loadKlaudShell(home), input.patch as JsonPatchOp[]); saveKlaudShell(next, home); }
				catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Invalid shell patch."); }
				broadcast(stateDelta(input.patch as JsonPatchOp[])); publishState(); json(res, 200, snapshot()); return;
			}
			if (req.method === "POST" && req.url === "/run") {
				const input = await body(req);
				if (typeof input.threadId !== "string" || !input.threadId.trim() || input.threadId.length > 160 || typeof input.message !== "string" || !input.message.trim() || input.message.length > 128 * 1024) invalid("A run requires a threadId and nonempty message.");
				const bot = input.botId === undefined ? undefined : requestedBot(input.botId, home);
				if (bot && input.threadId !== bot.sessionId) invalid("threadId must match the selected bot's sessionId.");
				const sessionId = bot?.sessionId ?? `klaud-thread-${createHash("sha256").update(input.threadId).digest("hex").slice(0, 32)}`;
				const declarations = frontendDeclarations(input.tools);
				if (closing) throw new HttpError(503, "Server is closing.");
				if (threads.has(sessionId)) throw new HttpError(409, "This thread already has an active run.");
				if (active.size >= 8) throw new HttpError(429, "Too many active runs.");
				const execution = streamRun(res, input, declarations, sessionId, bot); executions.add(execution);
				try { await execution; } finally { executions.delete(execution); } return;
			}
			const route = /^\/runs\/([a-f0-9-]+)\/(cancel|tools\/([^/]+)|approvals\/([^/]+))$/.exec(req.url ?? "");
			if (req.method === "POST" && route) {
				const input = await body(req), run = active.get(route[1]);
				if (!run || run.controller.signal.aborted) throw new HttpError(404, "No active run.");
				if (route[2] === "cancel") { run.controller.abort(); json(res, 200, { ok: true }); return; }
				const id = decodeURIComponent(route[3] ?? route[4]), pending = run.pending.get(id);
				if (!pending || pending.kind !== (route[3] ? "tool" : "approval")) throw new HttpError(404, "No pending action.");
				if (pending.kind === "approval") {
					if (typeof input.allow !== "boolean") invalid("Approval requires {allow: boolean}.");
					pending.settle(input.allow);
				} else {
					if (typeof input.result !== "string" || input.isError !== undefined && typeof input.isError !== "boolean") invalid("A tool result requires {result: string, isError?: boolean}.");
					if (!input.isError && pending.tool === "setPref") savePref(pending.args.value);
					pending.settle({ content: input.result, isError: input.isError === true });
				}
				publishState(); json(res, 200, { ok: true }); return;
			}
			throw new HttpError(404, "Not found.");
		})().catch(error => {
			if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); return; }
			res.setHeader("Connection", "close");
			json(res, error instanceof HttpError || error instanceof MobileAccountError ? error.status : 500, { error: error instanceof HttpError || error instanceof MobileAccountError ? error.message : "klaʊdbot request failed." });
		});
	});
	server.requestTimeout = 15_000; server.headersTimeout = 5000;
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(opts.port ?? 0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	try {
		if (opts.token === undefined) { tokenFile = join(home, "klaud", `serve-${new URL(url).port}.token`); privateWrite(tokenFile, token + "\n"); }
	} catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
	return { url, token, close() {
		if (!closing) closing = (async () => {
			for (const run of active.values()) run.controller.abort();
			await accounts.close();
			await new Promise<void>((resolve, reject) => {
				server.close(error => error ? reject(error) : resolve());
				(server as typeof server & { closeAllConnections?: () => void }).closeAllConnections?.();
			});
				await Promise.allSettled([...executions]);
			if (tokenFile) { try { if (privateRead(tokenFile) === token + "\n") unlinkSync(tokenFile); } catch { /* Preserve replaced or linked files. */ } }
		})();
		return closing;
	} };
}

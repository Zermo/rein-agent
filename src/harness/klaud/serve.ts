/** Loopback AG-UI transport. The runner owns execution and session persistence. */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool, AgentToolResult } from "../../agent/agent-loop.ts";
import { createSession, loadSession, sessionPath } from "../../agent/session.ts";
import type { AssistantMessage, AssistantMessageEvent, Tool } from "../../ai/types.ts";
import { stateDelta, stateSnapshot, toAgUiEvents } from "../../ai/ag-ui.ts";
import type { AgUiEvent } from "../../ai/ag-ui.ts";
import { createRunner } from "../runner.ts";
import { applyKlaudPatch, loadKlaudShell, saveKlaudShell } from "./shell.ts";
import type { JsonPatchOp, KlaudSharedState } from "./shell.ts";
import { createKlaudTools } from "./tools.ts";
import { klaudBotPrompt } from "./prompt.ts";
import { flagDrift, operatorInterrupt } from "../interrupt.ts";
import { pinJournal } from "../journal.ts";
import { avatarFor, createBot, ensureOwnComputers, getBot, listBots, setBotAvatar } from "./bots.ts";
import { inspectRoot, listInspectFiles, readInspectFile, resolveInspectFile } from "./inspect.ts";
import type { KlaudBot } from "./bots.ts";

export interface ServeOptions {
	host?: string;
	port?: number;
	home?: string;
	token?: string;
	cwd?: string;
	/** Tests only. Production always uses createRunner and persisted sessions. */
	run?: (msg: string, tools?: Tool[]) => AsyncIterable<AssistantMessageEvent>;
}
export interface ServeHandle { url: string; token: string; close(): Promise<void>; }

const MAX_BODY = 256 * 1024;
const PENDING_TIMEOUT = 120_000;
const FRONTEND_NAMES = new Set(["patchShell", "setPref", "navigateTo", "confirmAction"]);
const processHome = () => resolve(process.env.REIN_HOME || join(homedir(), ".rein"));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const privateHosts = new BlockList();
privateHosts.addSubnet("127.0.0.0", 8, "ipv4");
privateHosts.addSubnet("10.0.0.0", 8, "ipv4");
privateHosts.addSubnet("172.16.0.0", 12, "ipv4");
privateHosts.addSubnet("192.168.0.0", 16, "ipv4");
privateHosts.addSubnet("169.254.0.0", 16, "ipv4");
privateHosts.addSubnet("100.64.0.0", 10, "ipv4");
privateHosts.addSubnet("::1", 128, "ipv6");
privateHosts.addSubnet("fc00::", 7, "ipv6");
privateHosts.addSubnet("fe80::", 10, "ipv6");
const PUBLIC_FILES: Record<string, string> = {
	"/": "index.html", "/index.html": "index.html", "/browser.js": "browser.js", "/renderer.js": "renderer.js",
	"/styles.css": "styles.css", "/tokens.css": "tokens.css", "/setup.css": "setup.css", "/avatars.css": "avatars.css",
	"/icon.svg": "icon.svg", "/icon.png": "icon.png", "/favicon.ico": "icon.png", "/rein-logo.svg": "rein-logo.svg",
	"/rein-field-guide-card.jpg": "rein-field-guide-card.jpg",
};
const PUBLIC_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
const FALLBACK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>rein-klaʊd</title></head><body><p>rein-klaʊd</p><p>API on this origin. Bearer required except <code>/</code> and <code>/health</code>.</p></body></html>`;
/** Explicit numeric private/loopback/mesh bind. Never 0.0.0.0, ::, hostnames, or public addresses. */
export function validateBindHost(value: string): string {
	if (typeof value !== "string" || !value || value !== value.trim()) throw new Error("rein serve --host must be an explicit numeric interface address.");
	const zoneAt = value.indexOf("%");
	const host = zoneAt === -1 ? value : value.slice(0, zoneAt);
	const zone = zoneAt === -1 ? undefined : value.slice(zoneAt + 1);
	const family = isIP(host);
	if (!family || zone !== undefined && (family !== 6 || !zone || !/^[A-Za-z0-9_.-]{1,64}$/.test(zone))) throw new Error("rein serve --host must be an explicit numeric interface address.");
	if (!privateHosts.check(host, family === 4 ? "ipv4" : "ipv6")) throw new Error("rein serve may bind only to loopback, private, link-local, ULA, or private-mesh addresses; wildcard and public addresses are refused.");
	if (family === 4) return host;
	const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
	return zone === undefined ? canonical : `${canonical}%${zone}`;
}
function klaudUiRoot(): string | undefined {
	const here = dirname(fileURLToPath(import.meta.url));
	for (const candidate of [join(here, "../../../apps/klaud/dist"), join(here, "../apps/klaud/dist")]) {
		try {
			const index = join(candidate, "index.html");
			const stat = lstatSync(index);
			if (!stat.isSymbolicLink() && stat.isFile()) return resolve(candidate);
		} catch { /* missing checkout UI */ }
	}
}
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
function botMessages(bot: KlaudBot, home: string, before?: number) {
	const file = sessionPath(bot.sessionId, home);
	checkStorage(file);
	if (!existsSync(file)) throw new HttpError(404, "Bot session is missing.");
	const messages = loadSession(bot.sessionId, home).messages.flatMap(message => {
		if (message.role === "user") return [{ id: message.id, role: "user", content: message.content }];
		const content = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		if (message.role === "toolResult") return [{ id: message.id, role: "tool", content, toolCallId: message.toolCallId }];
		const toolCalls = message.content.filter(part => part.type === "toolCall").map(part => ({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.arguments) } }));
		const thinking = message.content.filter(part => part.type === "thinking").map(part => part.thinking).filter(Boolean).join("\n\n");
		return content || toolCalls.length || thinking ? [{ id: message.id, role: "assistant", content, ...(thinking ? { thinking } : {}), ...(toolCalls.length ? { toolCalls } : {}) }] : [];
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
	steer?(text: string, quote?: string): { id: string; path: string };
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
	const bindHost = validateBindHost(opts.host ?? "127.0.0.1");
	if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)) throw new Error("Invalid port, expected 0 through 65535.");
	const uiRoot = klaudUiRoot();
	const home = resolve(opts.home ?? processHome()), cwd = resolve(opts.cwd ?? process.cwd());
	// Runner, model config, and session APIs are process-scoped. Never switch env for a request.
	const checkHome = () => { if (!opts.run && home !== processHome()) throw new Error("Set REIN_HOME to the requested home before starting rein serve; the runner uses process-wide configuration and sessions."); };
	checkHome();
	loadKlaudShell(home);
	ensureOwnComputers(home, cwd);
	const prefsFile = join(home, "klaud", "prefs.json");
	readPrefs(prefsFile);
	const settingsFile = join(home, "klaud", "run-settings.json");
	const defaultRunSettings = { bashApproval: "always" as const, reasoningEffort: "default" as const, toolWhitelist: [] as string[] };
	const readRunSettings = () => {
		try {
			const value = JSON.parse(readFileSync(settingsFile, "utf8")) as { bashApproval?: string; reasoningEffort?: string; toolWhitelist?: string[] };
			const bashApproval = ["always", "auto", "ask", "whitelist"].includes(String(value?.bashApproval)) ? value.bashApproval as typeof defaultRunSettings.bashApproval : defaultRunSettings.bashApproval;
			const reasoningEffort = ["default", "off", "low", "medium", "high"].includes(String(value?.reasoningEffort)) ? value.reasoningEffort as string : defaultRunSettings.reasoningEffort;
			const toolWhitelist = Array.isArray(value?.toolWhitelist) ? value.toolWhitelist.filter((name): name is string => typeof name === "string" && name.length > 0 && name.length < 80) : [];
			return { bashApproval, reasoningEffort, toolWhitelist };
		} catch { /* default */ }
		return { ...defaultRunSettings, toolWhitelist: [] };
	};
	const writeRunSettings = (next: { bashApproval: string; reasoningEffort: string; toolWhitelist?: string[] }) => {
		privateWrite(settingsFile, JSON.stringify({ bashApproval: next.bashApproval, reasoningEffort: next.reasoningEffort, toolWhitelist: next.toolWhitelist ?? readRunSettings().toolWhitelist }) + "\n");
	};
	const publicRunSettings = () => {
		const value = readRunSettings();
		return { bashApproval: value.bashApproval, reasoningEffort: value.reasoningEffort };
	};
	const intendedPort = opts.port ?? 0;
	const existingTokenFile = intendedPort ? join(home, "klaud", `serve-${intendedPort}.token`) : "";
	let persisted = "";
	if (!opts.token && existingTokenFile) {
		try {
			const existing = privateRead(existingTokenFile).trim();
			if (/^[\x21-\x7e]{1,512}$/.test(existing)) persisted = existing;
		} catch { /* mint */ }
	}
	const token = opts.token ?? (persisted || randomBytes(24).toString("hex"));
	if (!/^[\x21-\x7e]{1,512}$/.test(token)) throw new Error("The bearer token must be nonempty printable ASCII without spaces.");
	const authorization = Buffer.from(`Bearer ${token}`);
	const persistToken = intendedPort > 0 && opts.token === undefined;
	const active = new Map<string, ActiveRun>(), threads = new Set<string>();
	const executions = new Set<Promise<void>>();
	let url = "", tokenFile: string | undefined, closing: Promise<void> | undefined;
	const snapshot = (): KlaudSharedState => {
		const bots = listBots(home).map(bot => ({ ...bot, avatar: avatarFor(bot.id, home) })), prefs = readPrefs(prefsFile);
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
	function runTools(run: ActiveRun, declarations: Tool[], toolCwd: string): AgentTool[] {
		const backend = createKlaudTools(home, toolCwd).map(tool => ({ ...tool, async execute(id: string, args: Record<string, unknown>, signal?: AbortSignal) {
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
	const live = { origin: String(input.message ?? "").slice(0, 800), thinking: "", tools: [] as string[] };
		const disconnected = () => controller.abort();
		res.once("close", disconnected);
		res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
		res.flushHeaders();
		let turn = 0, failure: string | undefined;
		const onAssistant = (event: AssistantMessageEvent) => {
			if (controller.signal.aborted) return;
			if ("partial" in event && event.partial) {
				const thinking = event.partial.content.filter(part => part.type === "thinking").map(part => part.thinking).join("\n");
				if (thinking) live.thinking = thinking.slice(-4000);
				const calls = event.partial.content.filter(part => part.type === "toolCall").map(part => part.name);
				if (calls.length) live.tools = calls.slice(-8);
			}
			if (event.type === "done") { failure = undefined; turn++; return; }
			if (event.type === "error") { failure = event.error.errorMessage || event.reason; turn++; return; }
			for (const encoded of toAgUiEvents(event, { threadId, runId: `${id}:${turn}` })) run.emit(encoded);
		};
		const finalStatus = (message: AssistantMessage) => {
			if (["error", "aborted", "budget", "length", "pending"].includes(message.stopReason)) failure = message.errorMessage || (message.stopReason === "budget" ? "Turn budget reached. Continue the run to resume." : `Run stopped: ${message.stopReason}.`);
			else failure = undefined;
		};
		try {
			run.emit({ type: "RUN_STARTED", threadId, runId: id });
			run.emit(stateSnapshot(snapshot()));
			const workCwd = bot?.cwd ?? cwd;
			const additions = runTools(run, declarations, workCwd);
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
					checkStorage(file); createSession({ id: sessionId, cwd: workCwd }, home);
				}
				const runner = await createRunner({ cwd: workCwd, sessionId, surface: "klaud", toolGuard: async (name, args) => {
					if (controller.signal.aborted) return "Run cancelled.";
					const mutates = ["bash", "write", "edit", "gates"].includes(name) || name === "tmux" && !["list", "capture"].includes(String(args.op));
					if (!mutates) return;
					const settings = readRunSettings();
					if (settings.bashApproval === "always") return;
					if (settings.bashApproval === "auto" && name === "bash") return;
					if (settings.bashApproval === "whitelist") {
						if (!settings.toolWhitelist.includes(name)) writeRunSettings({ ...settings, toolWhitelist: [...settings.toolWhitelist, name] });
						return;
					}
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
				if (bot) runner.systemPrompt = `${klaudBotPrompt(bot, home)}\n\n${runner.systemPrompt}`;
				run.steer = (text: string, quote?: string) => {
					const selected = quote?.trim() || "";
					if (selected) pinJournal(selected, home, workCwd);
					const origin = selected || live.origin;
					const flagged = flagDrift({ runId: id, sessionId, origin, thinking: live.thinking, tools: [...live.tools] }, text, home);
					runner.steer({ role: "user", content: operatorInterrupt(text, { runId: id, sessionId, origin, thinking: live.thinking, tools: [...live.tools], driftId: flagged.id, file: flagged.path, quote: selected }), timestamp: Date.now() });
					run.emit({ type: "CUSTOM", name: "klaud.drift", value: { id: flagged.id, path: flagged.path } });
					return flagged;
				};
				const messages = await runner.run({ role: "user", content: input.message as string, timestamp: Date.now() }, { signal: controller.signal, onEvent(event) {
					if (event.type === "message_update") onAssistant(event.event);
					if (event.type === "tool_execution_end") run.emit({ type: "TOOL_CALL_RESULT", messageId: `${id}:result:${event.toolCallId}`, toolCallId: event.toolCallId, content: event.result.content, role: "tool" });
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
			run.emit(failure ? { type: "RUN_ERROR", threadId, runId: id, message: failure } : { type: "RUN_FINISHED", threadId, runId: id, outcome: { type: "success" } });
			if (!res.destroyed && !res.writableEnded) res.end("data: [DONE]\n\n");
			publishState();
		}
	}
	const server = createServer((req, res) => {
		res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "DENY");
		void (async () => {
			if (closing) throw new HttpError(503, "Server is closing.");
			const stripDefaultPort = (value: string) => value.replace(/:(?:443|80)$/, "");
			const requestHost = stripDefaultPort((req.headers.host ?? "").split(",")[0].trim().toLowerCase());
			let requestOrigin = req.headers.origin;
			if (requestOrigin) {
				try {
					const parsed = new URL(requestOrigin);
					if (parsed.port === "443" && parsed.protocol === "https:" || parsed.port === "80" && parsed.protocol === "http:") parsed.port = "";
					requestOrigin = parsed.origin;
				} catch { /* keep raw origin; allowlist still rejects unknown values */ }
			}
			const expectedHost = new URL(url).host;
			const allowedHosts = new Set([expectedHost, "reinklaud.zermo.org"]);
			const allowedOrigins = new Set([url, "https://reinklaud.zermo.org", "http://10.0.0.56:4317", "http://127.0.0.1:4317"]);
			if (!allowedHosts.has(requestHost) || (requestOrigin && !allowedOrigins.has(requestOrigin))) throw new HttpError(403, "Invalid Host or Origin.");
			const path = (req.url ?? "/").split("?")[0];
			if (req.method === "GET" && path === "/health") { json(res, 200, { ok: true, name: "rein-klaud" }); return; }
			if (req.method === "GET" && Object.hasOwn(PUBLIC_FILES, path)) {
				const name = PUBLIC_FILES[path];
				if (uiRoot) {
					try {
						const file = join(uiRoot, name);
						const stat = lstatSync(file);
						if (stat.isSymbolicLink() || !stat.isFile() || resolve(file) !== join(uiRoot, name)) throw new HttpError(404, "Not found.");
						res.writeHead(200, { "Content-Type": PUBLIC_TYPES[extname(name)] ?? "application/octet-stream" }).end(readFileSync(file));
						return;
					} catch (error) { if (error instanceof HttpError) throw error; }
				}
				if (name === "index.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(FALLBACK_HTML); return; }
				throw new HttpError(404, "Not found.");
			}
			const remoteUser = String(req.headers["remote-user"] ?? req.headers["remote-email"] ?? "").trim();
			const autheliaOk = requestHost === "reinklaud.zermo.org" && /^[A-Za-z0-9._@-]{1,128}$/.test(remoteUser);
			if (!autheliaOk) {
				const provided = Buffer.from(req.headers.authorization ?? "");
				if (provided.length !== authorization.length || !timingSafeEqual(provided, authorization)) throw new HttpError(401, "Bearer token required.");
			}
			if (req.method === "GET" && req.url === "/state") { json(res, 200, snapshot()); return; }
			if (req.method === "POST" && req.url === "/journal/pin") {
				const input = await body(req);
				if (typeof input.quote !== "string") invalid("Pin requires the selected thinking string.");
				json(res, 200, pinJournal(input.quote, home, cwd)); return;
			}
			if (req.method === "GET" && req.url === "/bots") { json(res, 200, listBots(home)); return; }
			if (req.method === "POST" && req.url === "/bots") {
				const input = await body(req);
				if (Object.keys(input).some(key => key !== "name") || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.name)) invalid("Use a bot name of 1 to 64 characters without control characters.");
				const bot = createBot(input.name, home, cwd); publishState(); json(res, 201, bot); return;
			}
			const messagesRoute = /^\/bots\/([^/]+)\/messages(?:\?before=(\d+))?$/.exec(req.url ?? "");
			if (req.method === "GET" && messagesRoute) {
				const before = messagesRoute[2] === undefined ? undefined : Number(messagesRoute[2]);
				if (before !== undefined && !Number.isSafeInteger(before)) invalid("Invalid history cursor.");
				json(res, 200, botMessages(requestedBot(messagesRoute[1], home), home, before)); return;
			}
			const inspectList = /^\/bots\/([^/]+)\/inspect-list$/.exec(path);
			if (req.method === "GET" && inspectList) {
				const bot = requestedBot(inspectList[1], home);
				const root = inspectRoot(bot.cwd, cwd);
				json(res, 200, { files: listInspectFiles(root) }); return;
			}
			const inspectFile = /^\/bots\/([^/]+)\/inspect(?:\/(.*))?$/.exec(path);
			if (req.method === "GET" && inspectFile && inspectFile[0] !== `/bots/${inspectFile[1]}/inspect-list`) {
				const bot = requestedBot(inspectFile[1], home);
				const rel = decodeURIComponent((inspectFile[2] ?? "").replace(/\+/g, "%20")) || (new URL(req.url ?? "/", "http://klaud.local").searchParams.get("path") ?? "");
				try {
					const found = resolveInspectFile(inspectRoot(bot.cwd, cwd), rel);
					const body = readInspectFile(found.file);
					res.writeHead(200, { "Content-Type": found.type, "Content-Length": body.length, "X-Inspect-Kind": found.kind, "X-Inspect-Path": found.path }).end(body);
				} catch (error) {
					const message = error instanceof Error ? error.message : "Not found.";
					const code = /must stay|Invalid inspect/.test(message) ? 400 : 404;
					throw new HttpError(code, message);
				}
				return;
			}
			if (req.method === "GET" && req.url === "/settings") { json(res, 200, publicRunSettings()); return; }
			if (req.method === "POST" && req.url === "/settings") {
				const input = await body(req);
				const current = readRunSettings();
				const bashApproval = ["always", "auto", "ask", "whitelist"].includes(String(input.bashApproval)) ? input.bashApproval : current.bashApproval;
				const reasoningEffort = ["default", "off", "low", "medium", "high"].includes(String(input.reasoningEffort)) ? input.reasoningEffort : current.reasoningEffort;
				const next = { bashApproval, reasoningEffort, toolWhitelist: current.toolWhitelist };
				writeRunSettings(next);
				json(res, 200, publicRunSettings()); return;
			}
			if (req.method === "GET" && req.url === "/activity") { json(res, 200, { autonomy: { status: "inactive" } }); return; }
			if (req.method === "PATCH" && req.url && /^\/bots\/[^/]+$/.test(req.url)) {
				const id = req.url.slice("/bots/".length);
				requestedBot(id, home);
				const input = await body(req);
				if (typeof input.avatar !== "string") invalid("An avatar id is required.");
				let bot: KlaudBot;
				try { bot = setBotAvatar(id, input.avatar, home); }
				catch (error) {
					if (error instanceof Error && error.message === "Invalid avatar.") invalid(error.message);
					throw error;
				}
				publishState();
				json(res, 200, bot); return;
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
			const route = /^\/runs\/([a-f0-9-]+)\/(cancel|steer|tools\/([^/]+)|approvals\/([^/]+))$/.exec(req.url ?? "");
			if (req.method === "POST" && route) {
				const input = await body(req), run = active.get(route[1]);
				if (!run || run.controller.signal.aborted) throw new HttpError(404, "No active run.");
				if (route[2] === "cancel") { run.controller.abort(); json(res, 200, { ok: true }); return; }
				if (route[2] === "steer") {
					if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 8000) invalid("Interrupt requires a nonempty message.");
					if (!run.steer) throw new HttpError(409, "This run cannot accept an interrupt.");
					const quote = typeof input.quote === "string" ? input.quote : undefined;
					const flagged = run.steer(input.message, quote);
					json(res, 200, { ok: true, driftId: flagged.id, path: flagged.path }); return;
				}
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
				json(res, 200, { ok: true }); return;
			}
			throw new HttpError(404, "Not found.");
		})().catch(error => {
			if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); return; }
			res.setHeader("Connection", "close");
			json(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : "rein-klaʊd request failed." });
		});
	});
	server.requestTimeout = 15_000; server.headersTimeout = 5000;
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(opts.port ?? 0, bindHost, () => { server.removeListener("error", reject); resolve(); }); });
	const addr = server.address() as { address: string; port: number; family: string };
	url = addr.family === "IPv6" || addr.family === "6" ? `http://[${addr.address}]:${addr.port}` : `http://${addr.address}:${addr.port}`;
	try {
		if (opts.token === undefined) {
			tokenFile = join(home, "klaud", `serve-${new URL(url).port}.token`);
			privateWrite(tokenFile, token + "\n");
			if (persistToken) tokenFile = undefined; // keep the file across restarts
		}
	} catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
	return { url, token, close() {
		if (!closing) closing = (async () => {
			for (const run of active.values()) run.controller.abort();
				await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
				await Promise.allSettled([...executions]);
			if (tokenFile && !persistToken) { try { if (privateRead(tokenFile) === token + "\n") unlinkSync(tokenFile); } catch { /* Preserve replaced or linked files. */ } }
		})();
		return closing;
	} };
}

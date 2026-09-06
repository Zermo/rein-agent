/**
 * Opt-in mobile transport for rein-klaʊd.
 *
 * The desktop server remains loopback-only and ties one run to one SSE socket.
 * This gateway owns that loopback socket instead, so a native client can
 * disconnect, reconnect with a cursor, and answer pending work without
 * cancelling the runner.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AssistantMessageEvent } from "../../ai/types.ts";
import type { AgUiEvent } from "../../ai/ag-ui.ts";
import { advertiseMobileGateway, mobileAdvertisementHost } from "./mdns.ts";
import type { MobileAdvertisementHandle, MobileAdvertiser } from "./mdns.ts";
import { startKlaudServe } from "./serve.ts";

export interface MobileGatewayOptions {
	/** A numeric private, loopback, link-local, ULA, or private-mesh address. */
	host: string;
	port?: number;
	home?: string;
	token?: string;
	cwd?: string;
	/** Exact HTTPS origin used by an explicitly configured private-mesh proxy. */
	trustedOrigin?: string;
	/** false disables discovery; a function supplies a tested custom publisher. */
	advertise?: false | MobileAdvertiser;
	/** Tests only. Production delegates to the persisted runner through serve.ts. */
	run?: (msg: string, tools?: import("../../ai/types.ts").Tool[]) => AsyncIterable<AssistantMessageEvent>;
}

export interface MobileGatewayHandle {
	url: string;
	token: string;
	tokenFile?: string;
	trustedOrigin?: string;
	close(): Promise<void>;
}

type MobileRunStatus = "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled";
type TerminalMobileRunStatus = Extract<MobileRunStatus, "completed" | "failed" | "cancelled">;
type PendingKind = "approval" | "tool";

interface PendingAction {
	id: string;
	kind: PendingKind;
	tool: string;
	summary: string;
	args?: Record<string, unknown>;
}

interface StoredEvent {
	sequence: number;
	event: AgUiEvent;
	bytes: number;
}

interface MobileRun {
	id: string;
	threadId: string;
	requestHash: string;
	status: MobileRunStatus;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	backendRunId?: string;
	error?: string;
	nextSequence: number;
	oldestSequence: number;
	eventBytes: number;
	events: StoredEvent[];
	pending: Map<string, PendingAction>;
	subscribers: Map<ServerResponse, NodeJS.Timeout>;
	controller: AbortController;
	cancelRequested: boolean;
}

interface MobileRunTombstone {
	id: string;
	threadId: string;
	requestHash: string;
	status: TerminalMobileRunStatus;
	createdAt: string;
	updatedAt: string;
	completedAt: string;
	error?: string;
	lastSequence: number;
	expiresAt: number;
}

const API_ROOT = "/v1/mobile";
const MAX_BODY = 256 * 1024;
const MAX_PROXY_RESPONSE = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const MAX_RUNS = 64;
const MAX_ACTIVE_RUNS = 8;
// Keep lightweight receipts after event buffers are evicted. This bounds memory
// while covering delayed mobile retries after an ambiguous run-start response.
const MAX_RUN_TOMBSTONES = 16_384;
const RUN_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60_000;
const privateHosts = new BlockList();
privateHosts.addSubnet("127.0.0.0", 8, "ipv4");
privateHosts.addSubnet("10.0.0.0", 8, "ipv4");
privateHosts.addSubnet("172.16.0.0", 12, "ipv4");
privateHosts.addSubnet("192.168.0.0", 16, "ipv4");
privateHosts.addSubnet("169.254.0.0", 16, "ipv4");
// Common private mesh allocation (RFC 6598 shared address space).
privateHosts.addSubnet("100.64.0.0", 10, "ipv4");
privateHosts.addSubnet("::1", 128, "ipv6");
privateHosts.addSubnet("fc00::", 7, "ipv6");
privateHosts.addSubnet("fe80::", 10, "ipv6");

const processHome = () => resolve(process.env.REIN_HOME || join(homedir(), ".rein"));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}

const invalid = (message: string): never => { throw new HttpError(400, message); };

function json(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
}

/** Validate before listen(), so the gateway can never fall back to a public or wildcard bind. */
export function validateMobileBindHost(value: string): string {
	if (typeof value !== "string" || !value || value !== value.trim()) throw new Error("--host must be an explicit numeric interface address.");
	const zoneAt = value.indexOf("%");
	const host = zoneAt === -1 ? value : value.slice(0, zoneAt);
	const zone = zoneAt === -1 ? undefined : value.slice(zoneAt + 1);
	const family = isIP(host);
	if (!family || zone !== undefined && (family !== 6 || !zone || !/^[A-Za-z0-9_.-]{1,64}$/.test(zone))) {
		throw new Error("--host must be an explicit numeric interface address.");
	}
	if (!privateHosts.check(host, family === 4 ? "ipv4" : "ipv6")) {
		throw new Error("The mobile gateway may bind only to loopback, private, link-local, ULA, or private-mesh addresses; wildcard and public addresses are refused.");
	}
	if (zone !== undefined && (!privateHosts.check(host, "ipv6") || !host.toLowerCase().startsWith("fe"))) {
		throw new Error("An IPv6 scope identifier is supported only for a link-local address.");
	}
	if (family === 4) return host;
	const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
	return zone === undefined ? canonical : `${canonical}%${zone}`;
}

export function validateMobileTrustedOrigin(value: string): string {
	let parsed: URL;
	try { parsed = new URL(value); } catch { throw new Error("--trusted-origin must be an HTTPS origin."); }
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || !parsed.hostname || parsed.hostname.includes("*")) {
		throw new Error("--trusted-origin must be an exact HTTPS origin without credentials, path, query, fragment, or wildcard.");
	}
	return parsed.origin;
}

function validatePort(value: number | undefined): number {
	const port = value ?? 4318;
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port, expected 0 through 65535.");
	return port;
}

function validateToken(token: string): string {
	if (!/^[\x21-\x7e]{24,512}$/.test(token)) throw new Error("The mobile bearer token must be at least 24 printable ASCII characters without spaces.");
	return token;
}

function checkCredentialPath(file: string): void {
	for (const [path, directory] of [[dirname(dirname(file)), true], [dirname(file), true], [file, false]] as const) {
		try {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("Mobile gateway credentials must use ordinary files and directories, never symlinks.");
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}

function readCredential(file: string): string | undefined {
	checkCredentialPath(file);
	let fd: number;
	try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	try {
		const stat = fstatSync(fd);
		if (stat.size > 1024) throw new Error("Mobile gateway credential file is too large.");
		if ((stat.mode & 0o077) !== 0) throw new Error("Mobile gateway credential file must not be accessible by group or other users.");
		return readFileSync(fd, "utf8").trim();
	} finally { closeSync(fd); }
}

function writeCredential(file: string, token: string): void {
	checkCredentialPath(file);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	checkCredentialPath(file);
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, token + "\n", { flag: "wx", mode: 0o600 });
		checkCredentialPath(file);
		renameSync(temp, file);
	} finally { if (existsSync(temp)) unlinkSync(temp); }
}

function credentialPath(home: string, host: string, port: number): string {
	const id = createHash("sha256").update(`${host}:${port}`).digest("hex").slice(0, 16);
	return join(home, "klaud", `mobile-${id}.token`);
}

function requestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return Promise.reject(new HttpError(415, "Use application/json."));
	return new Promise((resolveBody, reject) => {
		let size = 0, settled = false;
		const chunks: Buffer[] = [];
		const cleanup = () => { clearTimeout(timer); req.removeListener("data", data); req.removeListener("end", end); req.removeListener("aborted", aborted); req.removeListener("error", fail); };
		const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); chunks.length = 0; req.resume(); reject(error); };
		const aborted = () => fail(new HttpError(400, "Request aborted."));
		const data = (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY) fail(new HttpError(413, "Request body is too large.")); else chunks.push(chunk); };
		const end = () => {
			if (settled) return;
			settled = true; cleanup();
			try {
				const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (!object(value)) invalid("Expected a JSON object.");
				resolveBody(value);
			} catch (error) { reject(error instanceof HttpError ? error : new HttpError(400, "Invalid JSON.")); }
		};
		const timer = setTimeout(() => fail(new HttpError(408, "Request body timed out.")), 10_000); timer.unref();
		req.on("data", data); req.once("end", end); req.once("aborted", aborted); req.once("error", fail);
	});
}

function displayUrl(host: string, port: number): string {
	const suffix = port === 80 ? "" : `:${port}`;
	if (isIP(host.split("%")[0]) === 6) return `http://[${host.replace("%", "%25")}]${suffix}`;
	return `http://${host}${suffix}`;
}

function authorities(host: string, port: number): Set<string> {
	const suffixes = port === 80 ? ["", ":80"] : [`:${port}`];
	if (isIP(host.split("%")[0]) !== 6) return new Set(suffixes.map(suffix => host + suffix));
	return new Set(suffixes.flatMap(suffix => [`[${host}]${suffix}`, `[${host.replace("%", "%25")}]${suffix}`]));
}

function origins(host: string, port: number, protocol = "http"): Set<string> {
	return new Set([...authorities(host, port)].map(authority => `${protocol}://${authority}`));
}

function publicRun(run: MobileRun) {
	return {
		id: run.id,
		threadId: run.threadId,
		status: run.status,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		...(run.completedAt ? { completedAt: run.completedAt } : {}),
		...(run.error ? { error: run.error } : {}),
		oldestSequence: run.oldestSequence,
		lastSequence: run.nextSequence - 1,
		pending: [...run.pending.values()].map(item => structuredClone(item)),
	};
}

function publicTombstone(run: MobileRunTombstone) {
	return {
		id: run.id,
		threadId: run.threadId,
		status: run.status,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		completedAt: run.completedAt,
		...(run.error ? { error: run.error } : {}),
		oldestSequence: run.lastSequence + 1,
		lastSequence: run.lastSequence,
		pending: [],
	};
}

function validateRunInput(input: Record<string, unknown>): void {
	if (Object.keys(input).some(key => !["runId", "threadId", "message", "botId", "tools"].includes(key))) invalid("A mobile run contains an unknown field.");
	if (input.runId !== undefined && (typeof input.runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.runId))) {
		invalid("Invalid client runId.");
	}
	if (typeof input.threadId !== "string" || !input.threadId.trim() || input.threadId.length > 160
		|| typeof input.message !== "string" || !input.message.trim() || input.message.length > 128 * 1024) {
		invalid("A run requires a threadId and nonempty message.");
	}
	if (input.botId !== undefined && (typeof input.botId !== "string" || !input.botId || input.botId.length > 160)) invalid("Invalid botId.");
	if (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 4)) invalid("Invalid frontend tools.");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

function runRequestHash(input: Record<string, unknown>): string {
	const { runId: _runId, ...request } = input;
	return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

/** Parse one desktop SSE stream without exposing its connection to mobile clients. */
async function desktopEvents(body: ReadableStream<Uint8Array>, receive: (event: AgUiEvent) => void): Promise<void> {
	const reader = body.getReader(), decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			let boundary: number;
			while ((boundary = buffer.indexOf("\n\n")) !== -1) {
				const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
				for (const line of block.split("\n")) {
					if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
					const event: unknown = JSON.parse(line.slice(6));
					if (!object(event) || typeof event.type !== "string") throw new Error("The desktop bridge emitted an invalid event.");
					receive(event as AgUiEvent);
				}
			}
		}
	} finally { reader.releaseLock(); }
}

export async function startKlaudMobileGateway(opts: MobileGatewayOptions): Promise<MobileGatewayHandle> {
	const host = validateMobileBindHost(opts?.host), requestedPort = validatePort(opts.port);
	const trustedOrigin = opts.trustedOrigin === undefined ? undefined : validateMobileTrustedOrigin(opts.trustedOrigin);
	const home = resolve(opts.home ?? processHome()), cwd = resolve(opts.cwd ?? process.cwd());
	let tokenFile = opts.token === undefined && requestedPort !== 0 ? credentialPath(home, host, requestedPort) : undefined;
	const storedToken = tokenFile ? readCredential(tokenFile) : undefined;
	const token = validateToken(opts.token ?? storedToken ?? randomBytes(32).toString("hex"));
	const authorization = Buffer.from(`Bearer ${token}`);
	const backend = await startKlaudServe({ home, cwd, run: opts.run, token: randomBytes(32).toString("hex") });
	const runs = new Map<string, MobileRun>(), tombstones = new Map<string, MobileRunTombstone>(), executions = new Set<Promise<void>>();
	let closing: Promise<void> | undefined, url = "", allowedAuthorities = new Set<string>(), allowedOrigins = new Set<string>(), advertisement: MobileAdvertisementHandle | undefined;

	function pruneTombstones(now = Date.now()): void {
		while (tombstones.size) {
			const [id, receipt] = tombstones.entries().next().value!;
			if (receipt.expiresAt > now && tombstones.size <= MAX_RUN_TOMBSTONES) break;
			tombstones.delete(id);
		}
	}

	function retainedReceipt(id: string): MobileRunTombstone | undefined {
		const receipt = tombstones.get(id);
		if (receipt && receipt.expiresAt <= Date.now()) { tombstones.delete(id); return; }
		return receipt;
	}

	function retainReceipt(run: MobileRun): void {
		if (!run.completedAt || !["completed", "failed", "cancelled"].includes(run.status)) return;
		tombstones.delete(run.id);
		tombstones.set(run.id, {
			id: run.id,
			threadId: run.threadId,
			requestHash: run.requestHash,
			status: run.status as TerminalMobileRunStatus,
			createdAt: run.createdAt,
			updatedAt: run.updatedAt,
			completedAt: run.completedAt,
			...(run.error ? { error: run.error.slice(0, 4096) } : {}),
			lastSequence: run.nextSequence - 1,
			expiresAt: Date.now() + RUN_TOMBSTONE_TTL_MS,
		});
		pruneTombstones();
	}

	function finishSubscriber(run: MobileRun, res: ServerResponse): void {
		const timer = run.subscribers.get(res);
		if (timer) clearInterval(timer);
		run.subscribers.delete(res);
		if (!res.destroyed && !res.writableEnded) {
			res.write(`event: rein.run.done\ndata: ${JSON.stringify({ lastSequence: run.nextSequence - 1, status: run.status })}\n\n`);
			res.end();
		}
	}

	function writeStored(res: ServerResponse, stored: StoredEvent): void {
		if (res.destroyed || res.writableEnded) return;
		res.write(`id: ${stored.sequence}\nevent: rein.run.event\ndata: ${JSON.stringify({ sequence: stored.sequence, event: stored.event })}\n\n`);
		// A stalled phone loses only this subscription. The host-side run continues.
		if (res.writableLength > 1024 * 1024) res.destroy();
	}

	function adoptEvent(run: MobileRun, source: AgUiEvent): AgUiEvent {
		const event = structuredClone(source);
		if (event.type === "RUN_STARTED" && typeof event.runId === "string") {
			run.backendRunId = event.runId;
			run.status = "running";
			event.runId = run.id;
		}
		if (typeof event.runId === "string" && event.runId === run.backendRunId) event.runId = run.id;
		if (run.backendRunId && typeof event.messageId === "string" && event.messageId.startsWith(`${run.backendRunId}:`)) {
			event.messageId = run.id + event.messageId.slice(run.backendRunId.length);
		}
		if (event.type === "CUSTOM" && object(event.value)) {
			const value = event.value as Record<string, unknown>;
			if (value.runId === run.backendRunId) value.runId = run.id;
			if (event.name === "klaud.approval" && typeof value.id === "string" && typeof value.tool === "string" && typeof value.summary === "string") {
				run.pending.set(value.id, { id: value.id, kind: "approval", tool: value.tool, summary: value.summary });
				run.status = "waiting";
			}
			if (event.name === "klaud.frontend_tool" && typeof value.toolCallId === "string" && typeof value.toolName === "string" && object(value.args)) {
				const summary = value.toolName === "confirmAction" && typeof value.args.action === "string" ? value.args.action : JSON.stringify(value.args).slice(0, 1000);
				run.pending.set(value.toolCallId, { id: value.toolCallId, kind: "tool", tool: value.toolName, summary, args: structuredClone(value.args) });
				run.status = "waiting";
			}
		}
		if (event.type === "TOOL_CALL_RESULT" && typeof event.toolCallId === "string") {
			run.pending.delete(event.toolCallId);
			if (run.status === "waiting" && run.pending.size === 0) run.status = "running";
		}
		if (event.type === "STATE_SNAPSHOT" && object(event.snapshot) && Array.isArray(event.snapshot.approvals)) {
			const live = new Set(event.snapshot.approvals.flatMap(item => object(item) && typeof item.id === "string" ? [item.id] : []));
			for (const [id, pending] of run.pending) if (pending.kind === "approval" && !live.has(id)) run.pending.delete(id);
			if (run.status === "waiting" && run.pending.size === 0) run.status = "running";
		}
		if (event.type === "RUN_FINISHED") run.status = "completed";
		if (event.type === "RUN_ERROR") {
			run.error = typeof event.message === "string" ? event.message : "Run failed.";
			// The private bridge emits this canonical message only after its run
			// controller aborts. Keep an ambiguous request from relabeling an
			// unrelated provider failure as cancellation.
			run.status = run.cancelRequested && run.error === "Run cancelled." ? "cancelled" : "failed";
		}
		return event;
	}

	function append(run: MobileRun, source: AgUiEvent): void {
		const event = adoptEvent(run, source), sequence = run.nextSequence++;
		const bytes = Buffer.byteLength(JSON.stringify(event));
		const stored = { sequence, event, bytes };
		run.events.push(stored); run.eventBytes += bytes;
		while (run.events.length > MAX_EVENTS || run.eventBytes > MAX_EVENT_BYTES && run.events.length > 1) {
			const removed = run.events.shift()!;
			run.eventBytes -= removed.bytes;
			run.oldestSequence = removed.sequence + 1;
		}
		run.updatedAt = new Date().toISOString();
		for (const res of run.subscribers.keys()) writeStored(res, stored);
		if (["completed", "failed", "cancelled"].includes(run.status)) {
			run.completedAt = run.updatedAt;
			run.pending.clear();
			for (const res of [...run.subscribers.keys()]) finishSubscriber(run, res);
			const terminal = [...runs.values()].filter(item => ["completed", "failed", "cancelled"].includes(item.status));
			for (const old of terminal.slice(0, Math.max(0, runs.size - MAX_RUNS))) { retainReceipt(old); runs.delete(old.id); }
		}
	}

	async function execute(run: MobileRun, input: Record<string, unknown>): Promise<void> {
		try {
			const response = await fetch(backend.url + "/run", {
				method: "POST",
				headers: { Authorization: `Bearer ${backend.token}`, "Content-Type": "application/json" },
				body: JSON.stringify(input), signal: run.controller.signal,
			});
			if (!response.ok) {
				const detail = await response.json().catch(() => ({})) as { error?: unknown };
				throw new Error(typeof detail.error === "string" ? detail.error : `Desktop bridge returned HTTP ${response.status}.`);
			}
			if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("Desktop bridge did not return an event stream.");
			await desktopEvents(response.body, event => append(run, event));
			if (!["completed", "failed", "cancelled"].includes(run.status)) throw new Error("Desktop bridge ended before the run reached a terminal state.");
		} catch (error) {
			if (!["completed", "failed", "cancelled"].includes(run.status)) {
				append(run, { type: "RUN_ERROR", threadId: run.threadId, runId: run.id, message: run.cancelRequested || run.controller.signal.aborted ? "Run cancelled." : error instanceof Error ? error.message : "Run failed." });
			}
		}
	}

	async function cancel(run: MobileRun): Promise<void> {
		if (["completed", "failed", "cancelled"].includes(run.status)) throw new HttpError(409, "Run has already finished.");
		run.cancelRequested = true;
		if (!run.backendRunId) {
			run.controller.abort();
			return;
		}
		try {
			const response = await fetch(`${backend.url}/runs/${run.backendRunId}/cancel`, {
				method: "POST", headers: { Authorization: `Bearer ${backend.token}`, "Content-Type": "application/json" }, body: "{}",
			});
			if (!response.ok && response.status !== 404) throw new HttpError(502, "Desktop bridge could not cancel the run.");
		} catch (error) {
			// A concrete bridge rejection means cancellation did not start. A
			// transport error is ambiguous: keep the intent so the terminal event
			// can still reconcile an accepted cancellation correctly.
			if (error instanceof HttpError) { run.cancelRequested = false; throw error; }
			throw new HttpError(502, "Cancellation outcome is unknown; retry or reconnect to reconcile the run.");
		}
	}

	async function proxy(res: ServerResponse, method: "GET" | "POST", path: string, input?: Record<string, unknown>): Promise<void> {
		const response = await fetch(backend.url + path, {
			method,
			headers: { Authorization: `Bearer ${backend.token}`, ...(input ? { "Content-Type": "application/json" } : {}) },
			...(input ? { body: JSON.stringify(input) } : {}),
		});
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length > MAX_PROXY_RESPONSE) throw new HttpError(502, "Desktop bridge response is too large.");
		res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") ?? "application/json; charset=utf-8" }).end(bytes);
	}

	const server = createServer((req, res) => {
		res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "DENY");
		void (async () => {
			if (closing) throw new HttpError(503, "Mobile gateway is closing.");
			if (!req.headers.host || !allowedAuthorities.has(req.headers.host.toLowerCase())) throw new HttpError(403, "Invalid Host.");
			if (req.headers.origin && !allowedOrigins.has(req.headers.origin.toLowerCase())) throw new HttpError(403, "Invalid Origin.");
			const provided = Buffer.from(req.headers.authorization ?? "");
			if (provided.length !== authorization.length || !timingSafeEqual(provided, authorization)) throw new HttpError(401, "Bearer token required.");
			const parsed = new URL(req.url ?? "/", "http://rein.invalid");
			if (parsed.pathname === API_ROOT && req.method === "GET") {
				json(res, 200, { name: "rein-klaʊd-mobile", apiVersion: "v1", capabilities: ["resumable-events", "cancellation", "pending-actions", "bots", "shared-state"], ...(trustedOrigin ? { trustedOrigin } : {}) }); return;
			}
			if (parsed.pathname === `${API_ROOT}/health` && req.method === "GET") { json(res, 200, { ok: true, name: "rein-klaʊd-mobile", apiVersion: "v1" }); return; }

			const relative = parsed.pathname.slice(API_ROOT.length) + parsed.search;
			if (req.method === "GET" && (parsed.pathname === `${API_ROOT}/state` || parsed.pathname === `${API_ROOT}/bots` || /^\/v1\/mobile\/bots\/[^/]+\/messages$/.test(parsed.pathname))) {
				await proxy(res, "GET", relative); return;
			}
			if (req.method === "POST" && [`${API_ROOT}/state`, `${API_ROOT}/bots`, `${API_ROOT}/prefs`].includes(parsed.pathname)) {
				await proxy(res, "POST", relative, await requestBody(req)); return;
			}
			if (req.method === "POST" && parsed.pathname === `${API_ROOT}/runs`) {
				const input = await requestBody(req); validateRunInput(input);
				const id = typeof input.runId === "string" ? input.runId : randomUUID();
				pruneTombstones();
				const requestHash = runRequestHash(input), existing = runs.get(id), retained = retainedReceipt(id);
				if (existing) {
					if (existing.requestHash !== requestHash) throw new HttpError(409, "This client runId already belongs to different input.");
					json(res, 202, { runId: id, status: existing.status, eventsUrl: `${API_ROOT}/runs/${id}/events`, statusUrl: `${API_ROOT}/runs/${id}` }); return;
				}
				if (retained) {
					if (retained.requestHash !== requestHash) throw new HttpError(409, "This client runId already belongs to different input.");
					json(res, 202, { runId: id, status: retained.status, eventsUrl: `${API_ROOT}/runs/${id}/events`, statusUrl: `${API_ROOT}/runs/${id}` }); return;
				}
				const activeRuns = [...runs.values()].filter(item => !["completed", "failed", "cancelled"].includes(item.status));
				if (activeRuns.length >= MAX_ACTIVE_RUNS) throw new HttpError(429, "Too many active mobile runs.");
				if (activeRuns.some(item => item.threadId === input.threadId)) throw new HttpError(409, "This thread already has an active mobile run.");
				const now = new Date().toISOString();
				const run: MobileRun = { id, threadId: input.threadId as string, requestHash, status: "starting", createdAt: now, updatedAt: now, nextSequence: 1, oldestSequence: 1, eventBytes: 0, events: [], pending: new Map(), subscribers: new Map(), controller: new AbortController(), cancelRequested: false };
				runs.set(id, run);
				const { runId: _runId, ...backendInput } = input;
				const execution = execute(run, backendInput); executions.add(execution); void execution.finally(() => executions.delete(execution));
				json(res, 202, { runId: id, status: run.status, eventsUrl: `${API_ROOT}/runs/${id}/events`, statusUrl: `${API_ROOT}/runs/${id}` }); return;
			}
			const runRoute = new RegExp(`^${API_ROOT}/runs/([a-f0-9-]+)$`).exec(parsed.pathname);
			if (req.method === "GET" && runRoute) {
				pruneTombstones();
				const run = runs.get(runRoute[1]);
				if (run) { json(res, 200, publicRun(run)); return; }
				const retained = retainedReceipt(runRoute[1]); if (!retained) throw new HttpError(404, "No such mobile run.");
				json(res, 200, publicTombstone(retained)); return;
			}
			const eventsRoute = new RegExp(`^${API_ROOT}/runs/([a-f0-9-]+)/events$`).exec(parsed.pathname);
			if (req.method === "GET" && eventsRoute) {
				pruneTombstones();
				const run = runs.get(eventsRoute[1]), retained = retainedReceipt(eventsRoute[1]);
				if (!run && !retained) throw new HttpError(404, "No such mobile run.");
				const rawAfter = parsed.searchParams.has("after") ? parsed.searchParams.get("after") : req.headers["last-event-id"];
				const after = rawAfter === undefined || rawAfter === null || rawAfter === "" ? 0 : Number(rawAfter);
				if (!Number.isSafeInteger(after) || after < 0) invalid("The event cursor must be a nonnegative integer.");
				if (retained) {
					if (after > retained.lastSequence) throw new HttpError(409, "The event cursor is ahead of this run.");
					res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
					res.end(`event: rein.run.done\ndata: ${JSON.stringify({ lastSequence: retained.lastSequence, status: retained.status, eventsRetained: false })}\n\n`);
					return;
				}
				if (!run) throw new HttpError(404, "No such mobile run.");
				if (after > run.nextSequence - 1) throw new HttpError(409, "The event cursor is ahead of this run.");
				if (after < run.oldestSequence - 1) throw new HttpError(410, "The event cursor is older than the retained event window.");
				res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" }); res.flushHeaders();
				for (const stored of run.events) if (stored.sequence > after) writeStored(res, stored);
				if (["completed", "failed", "cancelled"].includes(run.status)) { finishSubscriber(run, res); return; }
				const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(": keepalive\n\n"); }, 15_000); heartbeat.unref();
				run.subscribers.set(res, heartbeat);
				res.once("close", () => { clearInterval(heartbeat); run.subscribers.delete(res); });
				return;
			}
			const cancelRoute = new RegExp(`^${API_ROOT}/runs/([a-f0-9-]+)/cancel$`).exec(parsed.pathname);
			if (req.method === "POST" && cancelRoute) {
				await requestBody(req);
				const run = runs.get(cancelRoute[1]); if (!run) throw new HttpError(404, "No such mobile run.");
				await cancel(run); json(res, 202, { ok: true, status: "cancelling" }); return;
			}
			const pendingRoute = new RegExp(`^${API_ROOT}/runs/([a-f0-9-]+)/(approvals|tools)/([^/]+)$`).exec(parsed.pathname);
			if (req.method === "POST" && pendingRoute) {
				const input = await requestBody(req), run = runs.get(pendingRoute[1]);
				if (!run || !run.backendRunId || ["completed", "failed", "cancelled"].includes(run.status)) throw new HttpError(404, "No active mobile run.");
				if (run.cancelRequested) throw new HttpError(409, "Run cancellation is in progress.");
				let id: string;
				try { id = decodeURIComponent(pendingRoute[3]); } catch { invalid("Invalid pending action id."); }
				const pending = run.pending.get(id), requestedKind = pendingRoute[2] === "approvals" ? "approval" : "tool";
				if (!pending || pending.kind !== requestedKind) throw new HttpError(404, "No matching pending action.");
				if (requestedKind === "approval") {
					if (Object.keys(input).some(key => key !== "allow") || typeof input.allow !== "boolean") invalid("Approval requires {allow: boolean}.");
				} else if (Object.keys(input).some(key => !["result", "isError"].includes(key)) || typeof input.result !== "string" || input.result.length > 128 * 1024 || input.isError !== undefined && typeof input.isError !== "boolean") {
					invalid("A tool result requires {result: string, isError?: boolean}.");
				}
				const backendPath = `/runs/${run.backendRunId}/${pendingRoute[2]}/${encodeURIComponent(id)}`;
				const response = await fetch(backend.url + backendPath, { method: "POST", headers: { Authorization: `Bearer ${backend.token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
				if (!response.ok) {
					if (response.status === 404) run.pending.delete(id);
					throw new HttpError(response.status === 404 ? 404 : 502, response.status === 404 ? "Pending action has expired." : "Desktop bridge rejected the pending action.");
				}
				run.pending.delete(id); run.status = run.pending.size ? "waiting" : "running"; run.updatedAt = new Date().toISOString();
				json(res, 200, { ok: true }); return;
			}
			throw new HttpError(404, "Not found.");
		})().catch(error => {
			if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); return; }
			if (error instanceof HttpError && error.status === 401) res.setHeader("WWW-Authenticate", "Bearer");
			res.setHeader("Connection", "close");
			json(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : "Mobile gateway request failed." });
		});
	});
	server.requestTimeout = 15_000; server.headersTimeout = 5000;
	try {
		await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(requestedPort, host, () => { server.removeListener("error", reject); resolveListen(); }); });
		const port = (server.address() as { port: number }).port;
		url = displayUrl(host, port);
		const localNames = [mobileAdvertisementHost(host)];
		allowedAuthorities = new Set([
			...authorities(host, port),
			...localNames.flatMap(name => [...authorities(name, port), ...authorities(name + ".", port)]),
			...(trustedOrigin ? [new URL(trustedOrigin).host] : []),
		].map(value => value.toLowerCase()));
		allowedOrigins = new Set([
			...origins(host, port),
			...localNames.flatMap(name => [...origins(name, port), ...origins(name + ".", port)]),
			...(trustedOrigin ? [trustedOrigin] : []),
		].map(value => value.toLowerCase()));
		if (opts.token === undefined) {
			tokenFile ??= credentialPath(home, host, port);
			if (!storedToken) writeCredential(tokenFile, token);
		}
		if (opts.advertise !== false) {
			try {
				advertisement = await (opts.advertise ?? advertiseMobileGateway)({ name: "rein-klaʊd", serviceType: "_rein-klaud._tcp", domain: "local", host, port, txt: { path: "/v1/mobile", version: "1" } });
			} catch { /* Discovery is optional; the explicit address remains usable. */ }
		}
	} catch (error) {
		await new Promise<void>(resolveClose => server.close(() => resolveClose()));
		await backend.close();
		throw error;
	}

	return {
		url, token, tokenFile, trustedOrigin,
		close() {
			if (!closing) closing = (async () => {
				try { await advertisement?.close(); } catch { /* Optional discovery cannot block shutdown. */ }
				for (const run of runs.values()) if (!["completed", "failed", "cancelled"].includes(run.status)) await cancel(run).catch(() => run.controller.abort());
				await Promise.allSettled([...executions]);
				for (const run of runs.values()) for (const res of [...run.subscribers.keys()]) { res.destroy(); finishSubscriber(run, res); }
				await new Promise<void>((resolveClose, reject) => {
					server.close(error => error ? reject(error) : resolveClose());
					(server as typeof server & { closeIdleConnections?: () => void }).closeIdleConnections?.();
				});
				await backend.close();
			})();
			return closing;
		},
	};
}

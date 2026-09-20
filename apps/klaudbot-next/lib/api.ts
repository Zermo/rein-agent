import { frontendTools, object, validateMessages, validateSettings, validateSnapshot } from "./model.ts";
import type { Activity, AgEvent, Bot, InspectDoc, InspectFile, Patch, RunSettings } from "./types.ts";

export const SIGN_IN_URL = "https://auth.zermo.org/?rd=https%3A%2F%2Fopenbot.zermo.org%2F";
export const MAX_INPUT_BYTES = 128 * 1024;
export const MAX_INSPECT_BYTES = 5 * 1024 * 1024;
export function protectedHtml(text: string): string {
  // HTTP response CSP does not survive conversion to a blob URL. Carry an
  // early restrictive resource policy into the document, in addition to the
  // iframe's empty sandbox. No network, base URL, forms, frames, or scripts.
  return '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:; base-uri \'none\'; form-action \'none\'">' + text;
}
export class ApiError extends Error {
  status: number;
  authRequired: boolean;
  constructor(message: string, status = 0, authRequired = false) { super(message); this.name = "ApiError"; this.status = status; this.authRequired = authRequired; }
}
export const isPublicHost = (hostname: string) => hostname.toLowerCase() === "openbot.zermo.org";
export function signIn(): void { window.location.assign(SIGN_IN_URL); }

/** One parser handles CRLF split across packets, multiline data and UTF-8 boundaries. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AgEvent> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "", terminal = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (data === "[DONE]") { if (!terminal) throw new Error("Run ended without a terminal event."); return; }
        if (!data) continue;
        if (data.length > 2 * 1024 * 1024) throw new Error("Backend event is too large.");
        const event: unknown = JSON.parse(data);
        if (!object(event) || typeof event.type !== "string") throw new Error("Invalid backend event.");
        terminal ||= event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";
        yield event as AgEvent;
      }
      if (buffer.length > 2 * 1024 * 1024) throw new Error("Backend event is too large.");
      if (done) {
        if (buffer.trim()) throw new Error("Incomplete backend event.");
        if (!terminal) throw new Error("Run connection closed before completion.");
        return;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function safeInspectPath(raw: string): string {
  if (!raw.trim() || raw.length > 1024 || /[\x00-\x1f\\]/.test(raw) || raw.includes("..") || raw.startsWith("/") || /^[a-z]+:/i.test(raw)) throw new ApiError("Invalid inspect path.", 400);
  const path = raw.replace(/^\.\//, "");
  if (/(?:^|\/)(?:\.env[^/]*|[^/]*(?:secret|token|password|credential)[^/]*|(?:.*[._-])?keys?(?:[._-].*)?|id_rsa[^/]*|id_ed25519[^/]*)(?:\/|$)/i.test(path)) throw new ApiError("That file is not inspectable.", 404);
  if (!/\.(?:png|svg|html?|md|txt|json|csv|jpe?g|webp|gif|js|mjs|cjs|ts|jsx|tsx|css|py|ya?ml|sh)$/i.test(path)) throw new ApiError("Unsupported inspect extension.", 400);
  return path;
}

export class KlaudApi {
  private token = "";
  private fetcher: typeof fetch;
  private base: string;
  constructor(base = "", fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) { this.base = base; this.fetcher = fetcher; }
  setToken(value: string): void {
    if (typeof window !== "undefined" && isPublicHost(window.location.hostname)) { this.token = ""; return; }
    if (value && !/^[\x21-\x7e]{1,512}$/.test(value)) throw new Error("Enter a valid LAN bearer.");
    this.token = value;
    // Deliberately memory-only. Never serialize credentials to localStorage or an URL.
  }
  async http(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const publicHost = typeof window !== "undefined" && isPublicHost(window.location.hostname);
    let response: Response;
    try { response = await this.fetcher(this.base + path, {
      method, signal, credentials: "same-origin", redirect: "error", cache: "no-store",
      headers: { ...(this.token && !publicHost ? { Authorization: `Bearer ${this.token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }); } catch (error) {
      // A future direct Caddy API route may reject before reaching our shim.
      // redirect:error intentionally hides the 302 status as a TypeError.
      // A healthy public /health distinguishes a reachable house-login door
      // from a total network outage; never follow a login redirect in fetch.
      if (publicHost && error instanceof TypeError && !signal?.aborted && path !== "/health") {
        const health = await this.fetcher(this.base + "/health", { credentials: "same-origin", redirect: "error", cache: "no-store", signal }).catch(() => null);
        if (health?.ok) { signIn(); throw new ApiError("Sign in to connect to the field console.", 401, true); }
      }
      throw error;
    }
    if (!response.ok) {
      let detail: Record<string, unknown> = {};
      if (response.headers.get("content-type")?.includes("json")) { try { const value: unknown = await response.json(); if (object(value)) detail = value; } catch { /* No HTML or private upstream body in a fault banner. */ } }
      const auth = response.status === 401 || detail.code === "auth_required" || detail.authRequired === true;
      // The shim converts upstream login redirects to 401, so fetch never follows them.
      if (auth && publicHost) signIn();
      throw new ApiError(auth ? "Sign in to connect to the field console." : typeof detail.error === "string" ? detail.error : `Console request returned HTTP ${response.status}.`, response.status, auth);
    }
    return response;
  }
  async json<T>(method: string, path: string, body?: unknown): Promise<T> { return (await this.http(method, path, body)).json() as Promise<T>; }
  health() { return this.json<{ ok: boolean; name: string }>("GET", "/health"); }
  async state() { return validateSnapshot(await this.json("GET", "/state")); }
  async patchShell(patch: Patch[]) { return validateSnapshot(await this.json("POST", "/state", { patch })); }
  bots() { return this.json<Bot[]>("GET", "/bots"); }
  createBot(name: string) { return this.json<Bot>("POST", "/bots", { name: name.trim() }); }
  avatar(id: string, avatar: string) { return this.json<Bot>("PATCH", `/bots/${encodeURIComponent(id)}`, { avatar }); }
  async pref(value: string) { return validateSnapshot(await this.json("POST", "/prefs", { key: "lastBotId", value })); }
  async settings() { return validateSettings(await this.json("GET", "/settings")); }
  async saveSettings(patch: Partial<RunSettings>) { return validateSettings(await this.json("POST", "/settings", patch)); }
  activity() { return this.json<Activity>("GET", "/activity"); }
  async messages(id: string, before?: number) {
    const page = await this.json<{ messages: unknown; before: number | null }>("GET", `/bots/${encodeURIComponent(id)}/messages${before === undefined ? "" : `?before=${before}`}`);
    return { messages: validateMessages(page.messages), before: page.before };
  }
  async inspectList(id: string) {
    const result = await this.json<{ files: InspectFile[] }>("GET", `/bots/${encodeURIComponent(id)}/inspect-list`);
    return result.files.filter(file => { try { safeInspectPath(file.path); return file.size <= MAX_INSPECT_BYTES; } catch { return false; } });
  }
  async inspect(id: string, raw: string, signal?: AbortSignal): Promise<InspectDoc> {
    const path = safeInspectPath(raw);
    const get = (rel: string) => this.http("GET", `/bots/${encodeURIComponent(id)}/inspect?path=${encodeURIComponent(rel)}`, undefined, signal);
    let response: Response;
    try { response = await get(path); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404 || !path.includes("/")) throw error;
      // Retry a basename (including spaces); never switch to the legacy path-style route.
      response = await get(path.split("/").pop()!);
    }
    if (Number(response.headers.get("content-length")) > MAX_INSPECT_BYTES) { await response.body?.cancel(); throw new ApiError("Inspect file exceeds 5 MiB.", 413); }
    if (!response.body) throw new Error("Empty inspect response.");
    const chunks: ArrayBuffer[] = [], reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_INSPECT_BYTES) throw new ApiError("Inspect file exceeds 5 MiB.", 413);
        chunks.push(value.slice().buffer as ArrayBuffer);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const type = response.headers.get("content-type") ?? "text/plain";
    const kind = type.includes("html") ? "html" : type.startsWith("image/") ? "image" : "text";
    let blob = new Blob(chunks, { type });
    if (kind === "html") blob = new Blob([protectedHtml(await blob.text())], { type });
    return { path, name: path.split("/").pop()!, kind, url: kind === "text" ? "" : URL.createObjectURL(blob), ...(kind === "text" ? { text: await blob.text() } : {}) };
  }
  async run(bot: Bot, message: string, signal: AbortSignal, onEvent: (event: AgEvent) => void): Promise<void> {
    if (!message.trim() || new TextEncoder().encode(message).byteLength > MAX_INPUT_BYTES) throw new Error("Operator input must be between 1 byte and 128 KiB.");
    const response = await this.http("POST", "/run", { botId: bot.id, threadId: bot.sessionId, message, tools: frontendTools }, signal);
    if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) throw new Error("Expected a live SSE run stream.");
    // Do not await frontend actions in the read loop: approvals must not stall event consumption.
    for await (const event of sseEvents(response.body)) onEvent(event);
  }
  cancel(runId: string) { return this.json("POST", `/runs/${encodeURIComponent(runId)}/cancel`, {}); }
  approve(runId: string, id: string, allow: boolean) { return this.json("POST", `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(id)}`, { allow }); }
  toolResult(runId: string, id: string, result: string, isError = false) { return this.json("POST", `/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(id)}`, { result, isError }); }
  onboardingInspect() { return Promise.resolve({ version: 1, completed: true, prepared: true, browser: true }); }
}

export function syncApprovalPolicy(settings: RunSettings, fingerprint?: string): void {
  try {
    const previous: unknown = JSON.parse(localStorage.getItem("rein.klaud.approve") ?? "{}");
    const commands = object(previous) && Array.isArray(previous.commands) ? previous.commands.filter((item): item is string => typeof item === "string") : [];
    if (fingerprint && !commands.includes(fingerprint)) commands.push(fingerprint.slice(0, 500));
    localStorage.setItem("rein.klaud.approve", JSON.stringify({ all: settings.bashApproval === "always", remember: settings.bashApproval === "whitelist", commands: commands.slice(-100) }));
  } catch { /* Device storage may be disabled; the server remains authoritative. */ }
}
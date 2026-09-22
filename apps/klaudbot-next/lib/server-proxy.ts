import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export const MAX_INSPECT_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 256 * 1024;
export const PUBLIC_ORIGIN = "https://reinklaud.zermo.org";
export const PUBLIC_ORIGINS = ["https://reinklaud.zermo.org", "https://openbot.zermo.org"] as const;
export const SIGN_IN_URL = "https://auth.zermo.org/?rd=https%3A%2F%2Freinklaud.zermo.org%2F";

export interface ProxyConfig {
  origin: string;
  bindHost: string;
  port: number;
  sandboxOrigin: string;
  /**
   * OFF by default. Only enable behind a trusted ingress that strips/replaces
   * remote-user/remote-email, with Next reachable exclusively over loopback.
   * Next Request does not expose a trustworthy socket peer address. Checking
   * bindHost is a fail-closed configuration guard, NOT proof of the peer's
   * identity: the operator must enforce this boundary and trust local peers.
   * Client-supplied Forwarded/X-Forwarded-* never establish identity.
   */
  trustAuthProxy: boolean;
}

export interface UpstreamInit {
  method: string;
  headers: Headers;
  body?: Uint8Array;
  signal: AbortSignal;
}

/** Inject this transport in tests; production never follows redirects. */
export type UpstreamTransport = (url: URL, init: UpstreamInit) => Promise<Response>;

class ProxyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const json = (status: number, value: unknown, headers?: HeadersInit) => Response.json(value, {
  status,
  headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
});

function exactOrigin(value: string): URL {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.origin !== value || url.username || url.password) {
    throw new Error("Expected an exact HTTP(S) origin without credentials, path, or query.");
  }
  return url;
}

const authority = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port}`;
const loopbackBind = (host: string) => host === "::1" || (isIP(host) === 4 && host.startsWith("127."));

/** Only reads these non-secret configuration variables; never loads a token. */
export function getProxyConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  const bindHost = overrides.bindHost ?? process.env.KLAUD_BIND_HOST ?? "127.0.0.1";
  const port = overrides.port ?? Number(process.env.KLAUD_PORT ?? 4322);
  const config: ProxyConfig = {
    origin: overrides.origin ?? process.env.KLAUD_ORIGIN ?? "http://10.0.0.56:4317",
    bindHost,
    port,
    sandboxOrigin: overrides.sandboxOrigin ?? process.env.KLAUD_SANDBOX_ORIGIN ?? `http://${authority(bindHost, port)}`,
    trustAuthProxy: overrides.trustAuthProxy ?? process.env.KLAUD_TRUST_AUTH_PROXY === "1",
  };
  if (!isIP(bindHost) || bindHost === "0.0.0.0" || bindHost === "::" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Proxy requires an explicit numeric bind address and valid port.");
  }
  exactOrigin(config.origin);
  const sandbox = exactOrigin(config.sandboxOrigin);
  const hosts = localHosts(config);
  if (!hosts.has(sandbox.host) || sandbox.protocol !== "http:") throw new Error("Sandbox origin must match a configured HTTP bind/loopback authority.");
  if (config.trustAuthProxy && !loopbackBind(bindHost)) throw new Error("Trusted auth ingress requires a loopback-only bind.");
  return config;
}

function localHosts(config: ProxyConfig): Set<string> {
  return new Set([authority(config.bindHost, config.port), `localhost:${config.port}`, `127.0.0.1:${config.port}`, `[::1]:${config.port}`]);
}

/** Shared with middleware: validate BEFORE any Host/Origin translation, on ALL paths. */
export function validateRequestBoundary(request: Request, config: ProxyConfig): Response | null {
  const host = request.headers.get("host")?.toLowerCase();
  const hosts = localHosts(config);
  hosts.add("openbot.zermo.org");
  hosts.add("openbot.zermo.org:443");
  hosts.add("openbot.zermo.org:80");
  hosts.add("reinklaud.zermo.org");
  hosts.add("reinklaud.zermo.org:443");
  hosts.add("reinklaud.zermo.org:80");
  if (!host || !hosts.has(host)) return json(403, { error: "Invalid Host or Origin." });
  const origin = request.headers.get("origin");
  const origins = new Set([config.sandboxOrigin, ...PUBLIC_ORIGINS, "http://10.0.0.56:4317", "http://127.0.0.1:4317"]);
  // Compare the complete header, not URL.origin: paths, userinfo, multiple values,
  // null, alternate ports and lookalike hosts must not become allowlisted.
  if (origin !== null && !origins.has(origin)) return json(403, { error: "Invalid Host or Origin." });
  return null;
}

const INSPECT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png", svg: "image/svg+xml", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", md: "text/plain; charset=utf-8", txt: "text/plain; charset=utf-8",
  json: "application/json", csv: "text/plain; charset=utf-8", js: "text/plain; charset=utf-8", mjs: "text/plain; charset=utf-8",
  cjs: "text/plain; charset=utf-8", ts: "text/plain; charset=utf-8", jsx: "text/plain; charset=utf-8", tsx: "text/plain; charset=utf-8",
  css: "text/plain; charset=utf-8", py: "text/plain; charset=utf-8", yml: "text/plain; charset=utf-8", yaml: "text/plain; charset=utf-8", sh: "text/plain; charset=utf-8",
};

/**
 * Stricter than the harness: reject ALL dotfiles, backslashes, percent remnants,
 * controls, absolute/drive paths, and sensitive substrings in ANY segment.
 * Thus ordinary names containing "key" (e.g. keyboard.ts) are also refused.
 * No basename fallback is implemented here. Harness remains responsible for
 * realpath/symlink confinement; the proxy never reads the workspace filesystem.
 */
export function validateInspectPath(path: string): string {
  if (!path || path.length > 1024 || path !== path.trim() || /[\u0000-\u001f\u007f-\u009f%\\:]/u.test(path) || path.startsWith("/") || path.includes("..")) {
    throw new ProxyError(400, "Invalid inspect path.");
  }
  const clean = path.startsWith("./") ? path.slice(2) : path;
  if (clean.split("/").some(part => !part || part.startsWith(".") || /secret|token|password|credential|key|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(part))) {
    throw new ProxyError(403, "That file is not inspectable.");
  }
  const extension = clean.split("/").at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
  if (!Object.hasOwn(INSPECT_TYPES, extension) || !clean.split("/").at(-1)?.includes(".")) throw new ProxyError(403, "File extension is not inspectable.");
  return clean;
}

type Route = { path: string; kind: "api" | "inspect" | "inspect-list" | "run"; inspectPath?: string };

function matchRoute(request: Request): Route {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const fixed: Record<string, string[]> = {
    "/health": ["GET"], "/state": ["GET", "POST"], "/bots": ["GET", "POST"],
    "/settings": ["GET", "POST"], "/activity": ["GET"], "/prefs": ["POST"], "/run": ["POST"],
  };
  if (Object.hasOwn(fixed, path)) {
    if (!fixed[path]?.includes(method)) throw new ProxyError(405, "Method not allowed.");
    // The harness matches these routes against req.url, not only pathname.
    if (url.search && path !== "/health") throw new ProxyError(400, "Unexpected query parameters.");
    return { path: path + url.search, kind: path === "/run" ? "run" : "api" };
  }
  const bot = /^\/bots\/(klaud-bot-[0-9a-f]{8})(?:\/(messages|inspect-list|inspect)(?:\/(.*))?)?$/.exec(path);
  if (bot) {
    if (!bot[2]) {
      if (method !== "PATCH") throw new ProxyError(405, "Method not allowed.");
      if (url.search) throw new ProxyError(400, "Unexpected query parameters.");
      return { path, kind: "api" };
    }
    if (method !== "GET") throw new ProxyError(405, "Method not allowed.");
    if (bot[2] === "inspect") {
      if ([...url.searchParams.keys()].some(key => key !== "path") || url.searchParams.getAll("path").length > 1) throw new ProxyError(400, "Invalid inspect query.");
      let suffix: string | undefined;
      if (bot[3]) {
        try { suffix = validateInspectPath(decodeURIComponent(bot[3].replace(/\+/g, "%20"))); }
        catch (error) { if (error instanceof ProxyError) throw error; throw new ProxyError(400, "Invalid inspect path."); }
      }
      // Query-first, canonical query-only upstream request avoids double decoding.
      // Validate an unused suffix too: supplying a safe query cannot hide traversal.
      const inspectPath = validateInspectPath(url.searchParams.has("path") ? url.searchParams.get("path") ?? "" : suffix ?? "");
      return { path: `/bots/${bot[1]}/inspect?${new URLSearchParams({ path: inspectPath })}`, kind: "inspect", inspectPath };
    }
    if (bot[3] !== undefined) throw new ProxyError(404, "Not found.");
    if (bot[2] === "inspect-list") {
      if (url.search) throw new ProxyError(400, "Unexpected query parameters.");
      return { path, kind: "inspect-list" };
    }
    if (url.search) {
      const before = url.searchParams.get("before");
      if (url.searchParams.size !== 1 || before === null || !/^\d+$/.test(before) || !Number.isSafeInteger(Number(before))) throw new ProxyError(400, "Invalid history cursor.");
      return { path: `${path}?before=${before}`, kind: "api" };
    }
    return { path, kind: "api" };
  }
  const run = /^\/runs\/[a-f0-9-]+\/(cancel|tools\/[^/]+|approvals\/[^/]+)$/.exec(path);
  if (run) {
    if (method !== "POST") throw new ProxyError(405, "Method not allowed.");
    if (url.search) throw new ProxyError(400, "Unexpected query parameters.");
    try {
      if (/[%\u0000-\u001f\u007f]/u.test(decodeURIComponent(path))) throw new Error("Invalid encoding");
    } catch { throw new ProxyError(400, "Invalid action id."); }
    return { path, kind: "api" };
  }
  throw new ProxyError(404, "Not found.");
}

async function readLimited(stream: ReadableStream<Uint8Array> | null, max: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Request aborted.", "AbortError");
      const next = await reader.read();
      if (signal?.aborted) throw new DOMException("Request aborted.", "AbortError");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new ProxyError(413, "Body exceeds the allowed size.");
      }
      chunks.push(next.value);
    }
  } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function requestBody(request: Request, path: string): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ProxyError(415, "Use application/json.");
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)) throw new ProxyError(413, "Request body is too large.");
  const bytes = await readLimited(request.body, MAX_REQUEST_BYTES, request.signal);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ProxyError(400, "Invalid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProxyError(400, "Expected a JSON object.");
  const input = value as Record<string, unknown>;
  if (path === "/bots" && request.method === "POST" && (Object.keys(input).some(key => key !== "name") || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.name))) {
    throw new ProxyError(400, "Use only a bot name of 1 to 64 characters without control characters.");
  }
  if (path === "/prefs" && (Object.keys(input).some(key => !["key", "value"].includes(key)) || input.key !== "lastBotId" || typeof input.value !== "string" || !input.value || input.value.length > 160)) {
    throw new ProxyError(400, "setPref requires {key: 'lastBotId', value: botId}.");
  }
  return bytes;
}

const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

/**
 * Node's HTTP client has no fetch/undici five-minute headers/read deadline.
 * agent:false avoids inherited pooled-socket timeouts; setTimeout(0) disables
 * socket inactivity deadlines. Response consumption uses native pause/resume
 * backpressure through Readable.toWeb, without buffering the complete stream.
 */
export const nodeUpstream: UpstreamTransport = (url, init) => new Promise((resolve, reject) => {
  if (init.signal.aborted) { reject(new DOMException("Request aborted.", "AbortError")); return; }
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = Object.fromEntries(init.headers);
  const req = send(url, { method: init.method, headers, agent: false, timeout: 0 });
  let incoming: import("node:http").IncomingMessage | undefined;
  const cleanup = () => init.signal.removeEventListener("abort", abort);
  const abort = () => {
    const error = new DOMException("Request aborted.", "AbortError");
    incoming?.destroy(error);
    req.destroy(error);
  };
  init.signal.addEventListener("abort", abort, { once: true });
  req.setTimeout(0);
  req.once("error", error => { cleanup(); reject(error); });
  req.once("response", response => {
    incoming = response;
    response.setTimeout(0);
    response.once("close", cleanup);
    // Never expose a Set-Cookie or connection-nominated header accidentally.
    const responseHeaders = new Headers();
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      const name = response.rawHeaders[i];
      const value = response.rawHeaders[i + 1];
      if (name && value !== undefined) responseHeaders.append(name, value);
    }
    const status = response.statusCode ?? 502;
    try {
      if ([204, 205, 304].includes(status) || init.method === "HEAD") {
        response.resume();
        resolve(new Response(null, { status, headers: responseHeaders }));
      } else {
        const body = Readable.toWeb(response, { strategy: { highWaterMark: 0 } }) as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status, headers: responseHeaders }));
      }
    } catch (error) { response.destroy(); reject(error); }
  });
  req.end(init.body);
});

function upstreamHeaders(request: Request, config: ProxyConfig, target: URL): Headers {
  // Positive list: never forward client identity, Forwarded, X-Forwarded-*,
  // proxy credentials, client Host or cookies to the private harness by default.
  const headers = new Headers({ "accept-encoding": "identity" });
  const nominated = new Set((request.headers.get("connection") ?? "").toLowerCase().split(",").map(value => value.trim()));
  for (const name of ["accept", "content-type", "authorization"]) {
    const value = request.headers.get(name);
    if (value !== null && !nominated.has(name)) headers.set(name, value);
  }
  const publicRequest = /^(?:openbot|reinklaud)\.zermo\.org(?::(?:80|443))?$/.test(request.headers.get("host")?.toLowerCase() ?? "");
  const trustedIdentity = config.trustAuthProxy && publicRequest && loopbackBind(config.bindHost);
  headers.set("host", publicRequest ? "openbot.zermo.org" : target.host);
  const origin = request.headers.get("origin");
  if (origin !== null) {
    // The sandbox cannot be allowlisted in the original harness. Only after
    // validation may its exact origin be translated to a backend-allowed one.
    headers.set("origin", origin === config.sandboxOrigin ? (trustedIdentity ? PUBLIC_ORIGIN : config.origin) : origin);
  }
  if (trustedIdentity) {
    for (const name of ["remote-user", "remote-email"]) {
      const value = request.headers.get(name);
      if (value !== null && /^[A-Za-z0-9._@-]{1,128}$/.test(value) && !nominated.has(name)) headers.set(name, value);
    }
  }
  // Authentication cookies belong only to the known HTTPS public endpoint;
  // never forward them to a LAN/loopback HTTP harness or arbitrary origin.
  if (config.origin === PUBLIC_ORIGIN && !nominated.has("cookie")) {
    const cookie = request.headers.get("cookie");
    if (cookie) headers.set("cookie", cookie);
  }
  return headers;
}

function downstreamHeaders(upstream: Response, config: ProxyConfig): Headers {
  const headers = new Headers({ "cache-control": "no-store, no-transform", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  const blocked = new Set([...HOP_HEADERS, ...(upstream.headers.get("connection") ?? "").toLowerCase().split(",").map(value => value.trim())]);
  for (const name of ["content-type", "content-length", "content-encoding", "www-authenticate", "retry-after", "x-inspect-kind", "x-inspect-path"]) {
    const value = upstream.headers.get(name);
    if (value !== null && !blocked.has(name)) headers.set(name, value);
  }
  if (config.origin === PUBLIC_ORIGIN && !blocked.has("set-cookie")) {
    for (const cookie of upstream.headers.getSetCookie()) headers.append("set-cookie", cookie);
  }
  return headers;
}

function relayBody(body: ReadableStream<Uint8Array>, signal: AbortSignal, cancel: () => void, cleanup: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => { signal.removeEventListener("abort", onAbort); cleanup(); };
  const onAbort = () => {
    if (closed) return;
    closed = true;
    controller.error(new DOMException("Request aborted.", "AbortError"));
    void reader.cancel().catch(() => {});
    cancel();
    finish();
  };
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(value) {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) { closed = true; value.close(); reader.releaseLock(); finish(); }
        else value.enqueue(next.value);
      } catch (error) {
        if (!closed) { closed = true; value.error(error); cancel(); finish(); }
      }
    },
    async cancel() {
      if (closed) return;
      closed = true;
      cancel();
      finish();
      await reader.cancel().catch(() => {});
    },
  }, { highWaterMark: 0 });
}

/** Server-only root API shim; request and transport injection do not open sockets in tests. */
export async function proxyRequest(request: Request, overrides: Partial<ProxyConfig> = {}, upstream: UpstreamTransport = nodeUpstream): Promise<Response> {
  let cleanup = () => {};
  let cancel = () => {};
  try {
    const config = getProxyConfig(overrides);
    const denied = validateRequestBoundary(request, config);
    if (denied) return denied;
    const route = matchRoute(request);
    if (request.signal.aborted) throw new DOMException("Request aborted.", "AbortError");
    const body = await requestBody(request, new URL(request.url).pathname);
    const controller = new AbortController();
    cancel = () => controller.abort();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    cleanup = () => request.signal.removeEventListener("abort", abort);
    if (request.signal.aborted) controller.abort();
    // route.path is an internally matched root path, never a client origin.
    const target = new URL(route.path, config.origin);
    const response = await upstream(target, { method: request.method, headers: upstreamHeaders(request, config, target), body, signal: controller.signal });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      void response.body?.cancel().catch(() => {});
      cancel(); cleanup();
      // Do not trust Location: no arbitrary redirect target or token is reflected.
      return json(401, { error: "auth_required", signIn: SIGN_IN_URL });
    }
    const headers = downstreamHeaders(response, config);
    const streaming = route.kind === "run" && response.ok;
    if ((streaming || route.kind === "inspect" || route.kind === "inspect-list") && response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") {
      void response.body?.cancel().catch(() => {});
      throw new ProxyError(502, "Upstream ignored identity encoding.");
    }
    if (streaming) {
      headers.set("content-type", "text/event-stream; charset=utf-8");
      headers.set("x-accel-buffering", "no");
      headers.delete("content-length");
      headers.delete("content-encoding");
    }
    if ((route.kind === "inspect" || route.kind === "inspect-list") && response.ok) {
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_INSPECT_BYTES)) {
        void response.body?.cancel().catch(() => {});
        throw new ProxyError(413, "Inspect response exceeds 5 MiB.");
      }
      // Only inspect is bounded-buffered: reject oversized files before exposing
      // any bytes. /run and all ordinary API responses remain incremental.
      const bytes = await readLimited(response.body, MAX_INSPECT_BYTES, request.signal);
      cleanup();
      if (route.kind === "inspect-list") {
        let value: unknown;
        try { value = JSON.parse(new TextDecoder().decode(bytes)); }
        catch { throw new ProxyError(502, "Invalid inspect listing."); }
        if (!value || typeof value !== "object" || !("files" in value) || !Array.isArray(value.files)) throw new ProxyError(502, "Invalid inspect listing.");
        const files = value.files.filter((file: unknown) => {
          if (!file || typeof file !== "object" || !("path" in file) || typeof file.path !== "string" || !("size" in file) || typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_INSPECT_BYTES) return false;
          try { validateInspectPath(file.path); return true; } catch { return false; }
        });
        return json(response.status, { files });
      }
      const returnedPath = response.headers.get("x-inspect-path");
      // The harness may resolve a safe basename to a different directory: check
      // the resolved path as well so its fallback cannot reveal a blocked file.
      const safePath = validateInspectPath(returnedPath ?? route.inspectPath ?? "");
      headers.set("content-type", INSPECT_TYPES[safePath.split(".").at(-1)?.toLowerCase() ?? ""] ?? "text/plain; charset=utf-8");
      headers.set("content-length", String(bytes.byteLength));
      headers.set("content-security-policy", "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'");
      headers.set("x-frame-options", "SAMEORIGIN");
      return new Response(bytes, { status: response.status, headers });
    }
    if (!response.body) { cleanup(); return new Response(null, { status: response.status, headers }); }
    return new Response(relayBody(response.body, request.signal, cancel, cleanup), { status: response.status, headers });
  } catch (error) {
    cancel(); cleanup();
    if (request.signal.aborted || error instanceof Error && error.name === "AbortError") return json(499, { error: "Request aborted." });
    if (error instanceof ProxyError) return json(error.status, { error: error.message });
    // Deliberately never log/reflect exception strings, request headers or URLs:
    // transport errors can contain credentials and private connection details.
    return json(502, { error: "upstream_unavailable" });
  }
}
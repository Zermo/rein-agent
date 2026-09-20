import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import {
  getProxyConfig, MAX_INSPECT_BYTES, MAX_REQUEST_BYTES, nodeUpstream, proxyRequest,
  PUBLIC_ORIGIN, SIGN_IN_URL, validateInspectPath, validateRequestBoundary,
} from "../lib/server-proxy.ts";
import type { ProxyConfig, UpstreamInit, UpstreamTransport } from "../lib/server-proxy.ts";

const BOT = "klaud-bot-1234abcd";
const RUN = "a1b2c3-d4e5";
const config: ProxyConfig = {
  origin: "http://10.0.0.56:4317", bindHost: "127.0.0.1", port: 4322,
  sandboxOrigin: "http://127.0.0.1:4322", trustAuthProxy: false,
};
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
function request(path: string, method = "GET", body?: unknown, headers: HeadersInit = {}, signal?: AbortSignal): Request {
  return new Request(`${config.sandboxOrigin}${path}`, {
    method, headers: { host: "127.0.0.1:4322", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}),
  });
}

function mock(response: () => Response = () => Response.json({ ok: true })) {
  const calls: { url: URL; init: UpstreamInit }[] = [];
  const upstream: UpstreamTransport = async (url, init) => { calls.push({ url, init }); return response(); };
  return { calls, upstream };
}

test("root API routes preserve exact method, path, query and JSON payload", async t => {
  const cases: [string, string, unknown?][] = [
    ["GET", "/health"], ["GET", "/health?probe=1"], ["GET", "/state"],
    ["POST", "/state", { patch: [{ op: "replace", path: "/view", value: "chat" }] }],
    ["GET", "/bots"], ["POST", "/bots", { name: "Field bot" }],
    ["PATCH", `/bots/${BOT}`, { avatar: "aviator" }],
    ["GET", `/bots/${BOT}/messages`], ["GET", `/bots/${BOT}/messages?before=17`],
    ["GET", "/settings"], ["POST", "/settings", { bashApproval: "ask", reasoningEffort: "high" }],
    ["GET", "/activity"], ["POST", "/prefs", { key: "lastBotId", value: BOT }],
    ["POST", "/run", { threadId: "thread-1", botId: BOT, message: "hello", tools: [] }],
    ["POST", `/runs/${RUN}/cancel`, {}],
    ["POST", `/runs/${RUN}/tools/call%3A1`, { result: "done", isError: false }],
    ["POST", `/runs/${RUN}/approvals/approval-1`, { allow: false }],
  ];
  for (const [method, path, body] of cases) await t.test(`${method} ${path}`, async () => {
    const { calls, upstream } = mock();
    const response = await proxyRequest(request(path, method, body), config, upstream);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"ok":true}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url.href, config.origin + path);
    assert.equal(calls[0]?.init.method, method);
    assert.equal(calls[0]?.init.headers.get("host"), "10.0.0.56:4317");
    assert.equal(calls[0]?.init.headers.get("accept-encoding"), "identity");
    assert.deepEqual(calls[0]?.init.body && JSON.parse(decode(calls[0].init.body)), body);
  });
});

test("reject unknown root API/methods and unsupported query parameters before any upstream call", async () => {
  const { calls, upstream } = mock();
  const paths = ["/api/bots", "/other", "/bots/not-a-bot/messages", `/bots/${BOT}/messages?before=1&before=2`, `/bots/${BOT}/messages?before=-1`, `/bots/${BOT}/messages?before=9007199254740992`, `/bots/${BOT}/messages?other=1`, `/bots/${BOT}/inspect-list/extra`, `/state?other=1`, `/settings?x=1`];
  for (const path of paths) assert.ok((await proxyRequest(request(path), config, upstream)).status >= 400, path);
  assert.equal((await proxyRequest(request("/bots", "DELETE"), config, upstream)).status, 405);
  assert.equal((await proxyRequest(request("/health", "OPTIONS"), config, upstream)).status, 405);
  assert.equal(calls.length, 0);
});

test("all incoming Host checks run even on health/static/Next asset paths", () => {
  const invalid = ["evil.example", "127.0.0.1:4317", "localhost:4323", "openbot.zermo.org.evil.test", "openbot.zermo.org, evil.test", "user@openbot.zermo.org", "openbot.zermo.org:444", "0.0.0.0:4322", "2130706433:4322", "127.1:4322"];
  for (const host of invalid) for (const path of ["/", "/health", "/_next/static/example.js", "/favicon.ico"]) {
    assert.equal(validateRequestBoundary(request(path, "GET", undefined, { host }), config)?.status, 403, `${host} ${path}`);
  }
  const missing = request("/health"); missing.headers.delete("host");
  assert.equal(validateRequestBoundary(missing, config)?.status, 403);
  for (const host of ["localhost:4322", "127.0.0.1:4322", "[::1]:4322", "openbot.zermo.org", "OPENBOT.ZERMO.ORG:443"]) {
    assert.equal(validateRequestBoundary(request("/", "GET", undefined, { host }), config), null, host);
  }
  const alternate = getProxyConfig({ ...config, bindHost: "10.2.3.4", sandboxOrigin: "http://10.2.3.4:4322" });
  assert.equal(validateRequestBoundary(request("/", "GET", undefined, { host: "10.2.3.4:4322" }), alternate), null);
});

test("strict exact Origin checks precede compatibility translation; proxy headers cannot bypass them", async () => {
  const { calls, upstream } = mock();
  const invalid = ["null", "https://evil.example", "http://127.0.0.1:4323", "http://localhost:4322", "http://[::1]:4322", "http://127.0.0.1:4322/", "https://openbot.zermo.org/path", "https://user@openbot.zermo.org", "https://openbot.zermo.org:444", "https://openbot.zermo.org, https://evil.example"];
  for (const origin of invalid) {
    const response = await proxyRequest(request("/health", "GET", undefined, { origin, "x-forwarded-host": "openbot.zermo.org", "x-forwarded-proto": "https" }), config, upstream);
    assert.equal(response.status, 403, origin);
  }
  const spoofed = await proxyRequest(request("/state", "GET", undefined, { host: "evil.example", "x-forwarded-host": "openbot.zermo.org", "remote-user": "admin" }), config, upstream);
  assert.equal(spoofed.status, 403);
  assert.equal(calls.length, 0);
  for (const origin of [config.sandboxOrigin, PUBLIC_ORIGIN, "http://10.0.0.56:4317", "http://127.0.0.1:4317"]) {
    const response = await proxyRequest(request("/health", "GET", undefined, { origin }), config, upstream);
    await response.text();
    assert.equal(calls.at(-1)?.init.headers.get("origin"), origin === config.sandboxOrigin ? config.origin : origin);
  }
});

test("strip spoofed identity and private cookies, preserve explicit Authorization without manufacturing credentials", async () => {
  const { calls, upstream } = mock();
  const response = await proxyRequest(request("/state", "GET", undefined, {
    host: "openbot.zermo.org", origin: PUBLIC_ORIGIN, authorization: "Bearer test-only-not-a-real-token",
    cookie: "test_session=private", "remote-user": "admin", "remote-email": "admin@example.test", "x-forwarded-user": "admin",
    "x-forwarded-host": "evil.example", "x-forwarded-for": "127.0.0.1", forwarded: "for=127.0.0.1", "proxy-authorization": "Basic fake",
  }), config, upstream);
  await response.text();
  const headers = calls[0]?.init.headers;
  assert.equal(headers?.get("authorization"), "Bearer test-only-not-a-real-token");
  for (const name of ["cookie", "remote-user", "remote-email", "x-forwarded-user", "x-forwarded-host", "x-forwarded-for", "forwarded", "proxy-authorization"]) assert.equal(headers?.get(name), null, name);
  const health = await proxyRequest(request("/health"), config, upstream); await health.text();
  assert.equal(calls[1]?.init.headers.get("authorization"), null);
  assert.equal(calls[1]?.init.headers.get("remote-user"), null);
});

test("trusted ingress is explicit, loopback-only, public-Host-only, validated identity-only", async () => {
  const trusted = { ...config, trustAuthProxy: true };
  const { calls, upstream } = mock();
  for (const [host, user, expected] of [["openbot.zermo.org", "example.user", "example.user"], ["127.0.0.1:4322", "admin", null], ["openbot.zermo.org", "admin,attacker", null]] as const) {
    const response = await proxyRequest(request("/state", "GET", undefined, { host, "remote-user": user, origin: config.sandboxOrigin }), trusted, upstream);
    await response.text();
    assert.equal(calls.at(-1)?.init.headers.get("remote-user"), expected);
    assert.equal(calls.at(-1)?.init.headers.get("origin"), host === "openbot.zermo.org" ? PUBLIC_ORIGIN : config.origin);
  }
  assert.throws(() => getProxyConfig({ ...trusted, bindHost: "10.0.0.56", sandboxOrigin: "http://10.0.0.56:4322" }), /loopback/);
  assert.throws(() => getProxyConfig({ ...trusted, bindHost: "0.0.0.0" }), /bind/);
});

test("public HTTPS upstream alone receives cookies; public auth redirects become 401 JSON with a fixed sign-in target", async () => {
  let cancelled = false;
  const { calls, upstream } = mock(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    status: 302, headers: { location: "https://evil.example/steal", "set-cookie": "upstream_cookie=fake; Secure" },
  }));
  const response = await proxyRequest(request("/bots", "GET", undefined, { cookie: "authelia_session=test-only", authorization: "Bearer explicit-test" }), { ...config, origin: PUBLIC_ORIGIN }, upstream);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "auth_required", signIn: SIGN_IN_URL });
  assert.equal(response.headers.get("location"), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init.headers.get("host"), "openbot.zermo.org");
  assert.equal(calls[0]?.init.headers.get("origin"), null);
  assert.equal(calls[0]?.init.headers.get("cookie"), "authelia_session=test-only");
  assert.equal(calls[0]?.init.headers.get("authorization"), "Bearer explicit-test");
  assert.equal(calls[0]?.init.signal.aborted, true);
  assert.equal(cancelled, true);
  const privateResponse = mock(() => new Response("ok", { headers: { "set-cookie": "must_not_leak=1" } }));
  const privateResult = await proxyRequest(request("/state"), config, privateResponse.upstream);
  assert.equal(privateResult.headers.get("set-cookie"), null); await privateResult.text();
});

test("JSON bots body is strictly name-only and prefs is exactly key/value", async () => {
  const { calls, upstream } = mock();
  for (const body of [{}, { name: "" }, { name: "   " }, { name: "ok", cwd: "/tmp" }, { name: "ok", avatar: "medic" }, { name: "a".repeat(65) }, { name: "a\u0000b" }, [], null, "bot"]) {
    assert.equal((await proxyRequest(request("/bots", "POST", body), config, upstream)).status, 400, JSON.stringify(body));
  }
  for (const body of [{ lastBotId: BOT }, { key: "theme", value: "dark" }, { key: "lastBotId", value: BOT, extra: true }, { key: "lastBotId", value: "" }]) {
    assert.equal((await proxyRequest(request("/prefs", "POST", body), config, upstream)).status, 400);
  }
  const wrongType = request("/bots", "POST", { name: "ok" }, { "content-type": "text/plain" });
  assert.equal((await proxyRequest(wrongType, config, upstream)).status, 415);
  const malformed = new Request(`${config.sandboxOrigin}/bots`, { method: "POST", headers: { host: "127.0.0.1:4322", "content-type": "application/json" }, body: "{" });
  assert.equal((await proxyRequest(malformed, config, upstream)).status, 400);
  assert.equal((await proxyRequest(request("/run", "POST", { message: "x".repeat(MAX_REQUEST_BYTES) }), config, upstream)).status, 413);
  assert.equal(calls.length, 0);
});

test("inspect uses query first, supports suffix links and preserves spaces/unicode/nested paths", async () => {
  const { calls, upstream } = mock(() => new Response("safe text", { headers: { "content-type": "text/plain" } }));
  for (const [input, chosen] of [
    [`/bots/${BOT}/inspect?path=docs%2Fhello+world.md`, "docs/hello world.md"],
    [`/bots/${BOT}/inspect/docs/hello%20world.md`, "docs/hello world.md"],
    [`/bots/${BOT}/inspect/docs/hello+world.md`, "docs/hello world.md"],
    [`/bots/${BOT}/inspect/ignored.md?path=chosen.md`, "chosen.md"],
    [`/bots/${BOT}/inspect?path=${encodeURIComponent("docs/你好.md")}`, "docs/你好.md"],
    [`/bots/${BOT}/inspect?path=.%2Fnotes.md`, "notes.md"],
  ]) {
    const response = await proxyRequest(request(input ?? ""), config, upstream);
    assert.equal(response.status, 200, input);
    assert.equal(await response.text(), "safe text");
    assert.equal(calls.at(-1)?.url.pathname, `/bots/${BOT}/inspect`);
    assert.equal(calls.at(-1)?.url.searchParams.get("path"), chosen);
    assert.match(response.headers.get("content-security-policy") ?? "", /^sandbox;/);
  }
});

test("inspect blocks traversal, encoded/double-encoded forms, sensitive files and unsafe extensions before upstream", async () => {
  const { calls, upstream } = mock();
  const paths = ["../notes.md", "a/../../notes.md", "/notes.md", "C:/notes.md", "folder\\notes.md", ".env", ".env.local", "dir/.env.json", "secret.txt", "secrets/report.md", "my_token.json", "PASSWORD.txt", "credentials.yaml", "api-key.json", "key/id.json", "keyboard.ts", "id_rsa.json", "id_ed25519.txt", ".git/config.json", "a\u0000.md", "a\u0085.md", "file.exe", "file", "dir//file.md", "%2e%2e/file.md", "%252e%252e/file.md", "a%2fb.md", "notes.md "];
  for (const path of paths) {
    const response = await proxyRequest(request(`/bots/${BOT}/inspect?path=${encodeURIComponent(path)}`), config, upstream);
    assert.ok(response.status === 400 || response.status === 403, `${path}: ${response.status}`);
  }
  for (const path of [`/bots/${BOT}/inspect/%252e%252e%2Ffile.md`, `/bots/${BOT}/inspect/%2eenv.json`, `/bots/${BOT}/inspect/%zz.md`, `/bots/${BOT}/inspect/secret.txt?path=safe.md`, `/bots/${BOT}/inspect?path=a.md&path=b.md`, `/bots/${BOT}/inspect?path=`, `/bots/${BOT}/inspect?other=a.md`]) {
    assert.ok((await proxyRequest(request(path), config, upstream)).status >= 400, path);
  }
  assert.equal(calls.length, 0);
  for (const path of ["../a.md", "%2e%2e/a.md", "a/../a.md"]) assert.throws(() => validateInspectPath(path));
});

test("inspect enforces extension allowlist, including all authoritative image and source types", async () => {
  const { upstream } = mock(() => new Response("test"));
  for (const extension of ["png", "svg", "jpg", "jpeg", "webp", "gif", "html", "htm", "md", "txt", "json", "csv", "js", "mjs", "cjs", "ts", "jsx", "tsx", "css", "py", "yml", "yaml", "sh"]) {
    const response = await proxyRequest(request(`/bots/${BOT}/inspect?path=test.${extension}`), config, upstream);
    assert.equal(response.status, 200, extension); await response.text();
  }
});

test("inspect max 5MiB enforced against declared and actual streamed sizes; accepts exactly max", async () => {
  let cancelled = 0;
  for (const declared of [false, true]) {
    const { calls, upstream } = mock(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_INSPECT_BYTES)); controller.enqueue(encode("x")); },
      cancel() { cancelled++; },
    }), { headers: declared ? { "content-length": String(MAX_INSPECT_BYTES + 1) } : {} }));
    const response = await proxyRequest(request(`/bots/${BOT}/inspect?path=file.txt`), config, upstream);
    assert.equal(response.status, 413);
    assert.equal(calls[0]?.init.signal.aborted, true);
  }
  assert.equal(cancelled, 2);
  const exact = mock(() => new Response(new Uint8Array(MAX_INSPECT_BYTES)));
  const response = await proxyRequest(request(`/bots/${BOT}/inspect?path=file.txt`), config, exact.upstream);
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, MAX_INSPECT_BYTES);
});

test("inspect blocks sensitive upstream fallback paths and filters listings", async () => {
  const fallback = mock(() => new Response("must not be revealed", { headers: { "x-inspect-path": "secrets/report.md" } }));
  const response = await proxyRequest(request(`/bots/${BOT}/inspect?path=report.md`), config, fallback.upstream);
  assert.equal(response.status, 403);
  assert.ok(!(await response.text()).includes("must not be revealed"));
  const good = { path: "docs/report.md", size: 100, kind: "text", mtime: 1 };
  const list = mock(() => Response.json({ files: [good, { ...good, path: ".env.json" }, { ...good, path: "my-key.txt" }, { ...good, path: "a/../file.txt" }, { ...good, path: "large.md", size: MAX_INSPECT_BYTES + 1 }, { ...good, size: -1 }] }));
  const listing = await proxyRequest(request(`/bots/${BOT}/inspect-list`), config, list.upstream);
  assert.equal(listing.status, 200);
  assert.deepEqual(await listing.json(), { files: [good] });
});

test("SSE is incremental and backpressured with unchanged bytes, no compression or length", async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, pull() { pulls++; } }, { highWaterMark: 0 });
  const { upstream } = mock(() => new Response(body, { headers: { "content-type": "text/event-stream", "content-length": "999", connection: "keep-alive" } }));
  const response = await proxyRequest(request("/run", "POST", { threadId: "test", message: "hello" }), config, upstream);
  assert.equal(response.status, 200);
  assert.equal(pulls, 0, "must not consume upstream before downstream demand");
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("connection"), null);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.match(response.headers.get("cache-control") ?? "", /no-transform/);
  const reader = response.body!.getReader();
  const first = reader.read();
  source.enqueue(encode('data: {"type":"RUN_STARTED"}\n\n'));
  assert.equal(decode((await first).value!), 'data: {"type":"RUN_STARTED"}\n\n');
  assert.equal(pulls, 1);
  const second = reader.read();
  source.enqueue(encode("data: [DONE]\n\n"));
  source.close();
  assert.equal(decode((await second).value!), "data: [DONE]\n\n");
  assert.equal((await reader.read()).done, true);
});

test("downstream cancellation aborts upstream; incoming abort interrupts a pending read", async () => {
  for (const incoming of [false, true]) {
    let cancelled = false;
    const controller = new AbortController();
    const { calls, upstream } = mock(() => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }));
    const response = await proxyRequest(request("/run", "POST", { threadId: "test", message: "hello" }, {}, controller.signal), config, upstream);
    const reader = response.body!.getReader();
    if (incoming) {
      const pending = reader.read();
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
    } else await reader.cancel();
    assert.equal(calls[0]?.init.signal.aborted, true);
    assert.equal(cancelled, true);
  }
});

test("abort during a stalled incoming JSON body cancels it without reaching upstream", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const input = new Request(config.sandboxOrigin + "/run", {
    method: "POST", headers: { host: "127.0.0.1:4322", "content-type": "application/json" }, body, signal: controller.signal,
    // Node's native Request requires duplex for a streaming upload.
    ...{ duplex: "half" },
  });
  const { calls, upstream } = mock();
  const pending = proxyRequest(input, config, upstream);
  controller.abort();
  assert.equal((await pending).status, 499);
  assert.equal(cancelled, true);
  assert.equal(calls.length, 0);
});

test("upstream errors are sanitized, 401 preserved, compressed inspect/SSE refused", async () => {
  const throwing: UpstreamTransport = async () => { throw new Error("must-not-reflect-authorization-or-secrets"); };
  const failed = await proxyRequest(request("/state"), config, throwing);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: "upstream_unavailable" });
  const auth = mock(() => Response.json({ error: "Bearer token required." }, { status: 401, headers: { "www-authenticate": "Bearer" } }));
  const denied = await proxyRequest(request("/state"), config, auth.upstream);
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("www-authenticate"), "Bearer");
  await denied.text();
  const compressed = mock(() => new Response("not decoded", { headers: { "content-encoding": "gzip" } }));
  assert.equal((await proxyRequest(request("/run", "POST", { threadId: "t", message: "m" }), config, compressed.upstream)).status, 502);
  assert.equal((await proxyRequest(request(`/bots/${BOT}/inspect?path=a.txt`), config, compressed.upstream)).status, 502);
});

test("native Node transport streams a loopback-only mocked server and destroys its connection on cancel", { timeout: 5000 }, async () => {
  let closeResolve!: () => void;
  const closed = new Promise<void>(resolve => { closeResolve = resolve; });
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream", "x-accel-buffering": "no" });
    res.flushHeaders();
    res.write('data: {"type":"RUN_STARTED"}\n\n');
    res.once("close", closeResolve);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await proxyRequest(request("/run", "POST", { threadId: "t", message: "m" }), { ...config, origin: `http://127.0.0.1:${address.port}` }, nodeUpstream);
    const reader = response.body!.getReader();
    assert.equal(decode((await reader.read()).value!), 'data: {"type":"RUN_STARTED"}\n\n');
    assert.deepEqual(seen, ["POST /run"]);
    await reader.cancel();
    await closed;
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("native Node transport does not follow a mocked auth redirect", { timeout: 5000 }, async () => {
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.writeHead(302, { location: "/unexpected-follow" }); res.end(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await proxyRequest(request("/state"), { ...config, origin: `http://127.0.0.1:${address.port}` }, nodeUpstream);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "auth_required", signIn: SIGN_IN_URL });
    assert.equal(hits, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("spoofed public identity cannot authenticate against an auth-checking mocked upstream", async () => {
  const upstream: UpstreamTransport = async (_url, init) => {
    const authenticated = init.headers.get("remote-user") || init.headers.get("remote-email") || init.headers.get("authorization");
    return Response.json(authenticated ? { ok: true } : { error: "Bearer token required." }, { status: authenticated ? 200 : 401 });
  };
  const response = await proxyRequest(request("/state", "GET", undefined, { host: "openbot.zermo.org", "remote-user": "admin", "remote-email": "admin@example.test" }), config, upstream);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Bearer token required." });
});

test("native Node transport closes a stalled upstream before headers when the incoming request aborts", { timeout: 5000 }, async () => {
  let hitResolve!: () => void;
  let closeResolve!: () => void;
  const hit = new Promise<void>(resolve => { hitResolve = resolve; });
  const closed = new Promise<void>(resolve => { closeResolve = resolve; });
  const server = createServer((req, res) => { req.resume(); res.once("close", closeResolve); hitResolve(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const controller = new AbortController();
    const pending = proxyRequest(request("/run", "POST", { threadId: "t", message: "m" }, {}, controller.signal), { ...config, origin: `http://127.0.0.1:${address.port}` }, nodeUpstream);
    await hit;
    controller.abort();
    assert.equal((await pending).status, 499);
    await closed;
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
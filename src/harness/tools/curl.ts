/** Bundled CurL. Node fetch, not a shell-out and not an npm client. */
import type { AgentTool } from "../../agent/agent-loop.ts";
import { allowedHttpUrl } from "../net-guard.ts";

const MAX_BODY = 32_000;
const MAX_OUT = 24_000;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

function fail(message: string): never {
	throw new Error(`curl: ${message} This is the bundled CurL tool. Do not shell out to curl and do not npm-install a client.`);
}

function clip(text: string): string {
	return text.length > MAX_OUT ? text.slice(0, MAX_OUT) + "\n[truncated]" : text;
}

const curlTool: AgentTool = {
	name: "curl",
	description: "Bundled CurL. HTTP(S) request via the built-in client. op is the method. https preferred; http only on loopback, LAN, or tailscale. Do not shell out to curl. Do not npm-install a client. Do not put secrets in the URL.",
	parameters: { type: "object", properties: {
		url: { type: "string" },
		method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
		headers: { type: "object", description: "Optional headers. Values are sent, not stored, and not echoed back." },
		body: { type: "string", description: "Optional request body, max 32000 characters." },
	}, required: ["url"] },
	executionMode: "sequential",
	async execute(_id, args, signal) {
		try {
			const url = allowedHttpUrl(args.url, "curl url");
			const method = args.method === undefined ? "GET" : String(args.method).toUpperCase();
			if (!METHODS.has(method)) fail("method must be GET, POST, PUT, PATCH, DELETE, or HEAD.");
			if (args.body !== undefined && (typeof args.body !== "string" || args.body.length > MAX_BODY)) fail("body must be a string up to 32000 characters.");
			const headers: Record<string, string> = { accept: "application/json, text/plain, */*" };
			if (args.headers !== undefined) {
				if (!args.headers || typeof args.headers !== "object" || Array.isArray(args.headers)) fail("headers must be an object.");
				const entries = Object.entries(args.headers as Record<string, unknown>);
				if (entries.length > 20) fail("too many headers.");
				for (const [key, value] of entries) {
					if (!/^[A-Za-z0-9-]{1,40}$/.test(key) || typeof value !== "string" || value.length > 4000 || /[\r\n]/.test(value)) fail("a header is invalid.");
					headers[key] = value;
				}
			}
			const timeout = AbortSignal.timeout(20_000);
			const linked = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const response = await fetch(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : args.body as string | undefined, redirect: "manual", signal: linked });
			if (response.status >= 300 && response.status < 400) {
				return { content: `curl: HTTP ${response.status} redirect to ${response.headers.get("location") ?? "(no location)"}. Not followed. Call curl again with an allowed URL.` };
			}
			const text = await response.text();
			return { content: clip(`HTTP ${response.status}\n${text}`), isError: !response.ok };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { content: `curl: ${message}. This is the bundled CurL tool. Do not shell out to curl and do not npm-install a client.`, isError: true };
		}
	},
};

export default curlTool;

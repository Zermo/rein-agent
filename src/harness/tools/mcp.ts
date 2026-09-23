/** Bundled Streamable HTTP MCP client. There is no @stdlib/mcp package in this process. */
import type { AgentTool } from "../../agent/agent-loop.ts";
import { allowedHttpUrl } from "../net-guard.ts";

const PROTOCOL = "2025-03-26";
const MAX_BODY = 64_000;
const MAX_OUT = 24_000;

function fail(message: string): never {
	throw new Error(`mcp: ${message} Do not require('@stdlib/mcp') or @modelcontextprotocol/sdk — this tool is the bundled client.`);
}

function clip(text: string): string {
	return text.length > MAX_OUT ? text.slice(0, MAX_OUT) + "\n[truncated]" : text;
}

async function readBody(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < MAX_BODY) {
		const next = await reader.read();
		if (next.done) break;
		size += next.value.byteLength;
		chunks.push(next.value);
	}
	reader.cancel().catch(() => {});
	return new TextDecoder().decode(Buffer.concat(chunks)).slice(0, MAX_BODY);
}

function rpcResult(body: string, contentType: string): unknown {
	const raw = contentType.includes("text/event-stream")
		? body.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(line => line && line !== "[DONE]").at(-1) ?? ""
		: body;
	if (!raw) fail("MCP server returned an empty body.");
	let parsed: { error?: { message?: string }; result?: unknown };
	try { parsed = JSON.parse(raw); }
	catch { fail("MCP server did not return JSON-RPC."); }
	if (parsed.error) fail(parsed.error.message || "MCP server returned an error.");
	return parsed.result ?? parsed;
}

async function post(url: URL, body: unknown, session: string | undefined, signal: AbortSignal, token?: string): Promise<{ result: unknown; session?: string }> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		"mcp-protocol-version": PROTOCOL,
	};
	if (session) headers["mcp-session-id"] = session;
	if (token) headers.authorization = `Bearer ${token}`;
	const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal });
	if (response.status >= 300 && response.status < 400) fail("server redirected. Pass the final https URL.");
	const text = await readBody(response);
	if (!response.ok) fail(`HTTP ${response.status}. ${clip(text.slice(0, 400))}`);
	const next = response.headers.get("mcp-session-id") ?? session;
	return { result: rpcResult(text, response.headers.get("content-type") ?? ""), session: next ?? undefined };
}

const mcpTool: AgentTool = {
	name: "mcp",
	description: "Bundled Streamable HTTP MCP client for a digital account. op=list discovers tools; op=call runs one named tool. There is no @stdlib/mcp package and no @modelcontextprotocol/sdk in this process. Do not npm-install or node -e require a client. Account labels come from the accounts tool; do not store the token.",
	parameters: { type: "object", properties: {
		url: { type: "string", description: "MCP endpoint, https preferred. http only on loopback, LAN, or tailscale." },
		op: { type: "string", enum: ["list", "call"] },
		name: { type: "string", description: "Tool name for op=call." },
		arguments: { type: "object", description: "Arguments for op=call. Default {}." },
		token: { type: "string", description: "Optional bearer for this call only. Not stored." },
	}, required: ["url", "op"] },
	executionMode: "sequential",
	async execute(_id, args, signal) {
		try {
			const url = allowedHttpUrl(args.url, "mcp url");
			const op = args.op === "list" || args.op === "call" ? args.op : fail("op must be list or call.");
			if (op === "call" && (typeof args.name !== "string" || !args.name.trim())) fail("op=call requires name.");
			if (args.arguments !== undefined && (typeof args.arguments !== "object" || args.arguments === null || Array.isArray(args.arguments))) fail("arguments must be an object.");
			const token = args.token === undefined ? undefined : typeof args.token === "string" && args.token.length < 4000 ? args.token : fail("token must be a string for this call only.");
			const timeout = AbortSignal.timeout(20_000);
			const linked = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const init = await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "rein", version: "0" } } }, undefined, linked, token);
			await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, init.session, linked, token).catch(() => ({ result: null }));
			const call = op === "list"
				? { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
				: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: args.name, arguments: args.arguments ?? {} } };
			const done = await post(url, call, init.session, linked, token);
			return { content: clip(JSON.stringify(done.result)) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { content: message.startsWith("mcp:") ? message : `mcp: ${message}. Do not require('@stdlib/mcp').`, isError: true };
		}
	},
};

export default mcpTool;

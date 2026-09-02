/**
 * nodeterm integration — status reporting + canvas/phone approvals.
 *
 * Active only inside a nodeterm node: nodeterm injects NODETERM_NODE_ID and
 * the hook endpoint (port or unix socket) into every session's env. We speak
 * the two contracts nodeterm documents (docs/hook-reply-approvals.md and
 * src/core/agents/hooks/managed-script.ts):
 *
 *   status — POST Claude-style hook events (flat `hook_event_name` +
 *            `hookSpecificOutput`) form-encoded to the loopback hook server.
 *            Fire-and-forget, 1.5s timeout, never throws: a dead endpoint
 *            dims a badge, it must not break the agent.
 *
 *   approve — the pending-files protocol: write ~/.nodeterm/pending/<id>.json,
 *             POST a PermissionRequest tagged with the pending id, then poll
 *             <id>.answer (the phone or desktop badge writes "allow"|"deny")
 *             every 500ms until timeout. The filesystem is the answer channel
 *             because the answerer may be a phone over SSH with no route to
 *             loopback — so it works for us regardless of agent type.
 *
 *   title  — the terminal title doubles as the status surface for custom
 *            agent nodes (their only built-in status source is process/title).
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const AGENT_ID = "rein";

/** Inside a nodeterm node? (node id + a usable endpoint) */
export const active = (): boolean =>
	!!(process.env.NODETERM_NODE_ID && (process.env.NODETERM_HOOK_PORT || process.env.NODETERM_HOOK_SOCK));

const pendingDir = (): string =>
	process.env.NODETERM_PENDING_DIR ?? path.join(os.homedir(), ".nodeterm", "pending");

/** Per-node token, if the endpoint file advertised one. Absent ⇒ no header (nodeterm tolerates that). */
function token(): string | undefined {
	const dir = process.env.NODETERM_NODE_TOKEN_DIR;
	const id = process.env.NODETERM_NODE_ID;
	if (!dir || !id) return undefined;
	try {
		const t = fs.readFileSync(path.join(dir, id), "utf8").trim();
		return t || undefined;
	} catch {
		return undefined;
	}
}

/** Fire-and-forget status POST. Never throws; never awaits. */
export function postEvent(payload: Record<string, unknown>, extra: Record<string, string> = {}): void {
	const nodeId = process.env.NODETERM_NODE_ID;
	const sock = process.env.NODETERM_HOOK_SOCK;
	const port = process.env.NODETERM_HOOK_PORT;
	if (!nodeId || (!sock && !port)) return;

	const fields: Record<string, string> = {
		nodeId,
		version: process.env.NODETERM_HOOK_VERSION ?? "1",
		payload: JSON.stringify(payload),
		...extra,
	};
	const body = Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");

	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		"Content-Length": String(Buffer.byteLength(body)),
	};
	const tk = token();
	if (tk) headers["X-Nodeterm-Node-Token"] = tk;

	const reqPath = `/hook/${encodeURIComponent(AGENT_ID)}`;
	const opts: http.RequestOptions = sock
		? { socketPath: sock, path: reqPath, method: "POST", headers, timeout: 1500 }
		: { host: "127.0.0.1", port: Number(port), path: reqPath, method: "POST", headers, timeout: 1500 };

	try {
		const req = http.request(opts);
		req.on("error", () => {});
		req.on("timeout", () => req.destroy());
		req.end(body);
	} catch {
		/* a status blip is not an agent failure */
	}
}

/** High-level status events, mapped to the hook names nodeterm's mirror understands. */
export const status = {
	turnStart: (prompt?: string) =>
		postEvent({ hook_event_name: "UserPromptSubmit", prompt, hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }),
	toolStart: (toolName: string, toolInput: Record<string, unknown>) =>
		postEvent({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, hookSpecificOutput: { hookEventName: "PreToolUse" } }),
	toolEnd: (toolName: string) =>
		postEvent({ hook_event_name: "PostToolUse", tool_name: toolName, hookSpecificOutput: { hookEventName: "PostToolUse" } }),
	done: () => postEvent({ hook_event_name: "Stop", hookSpecificOutput: { hookEventName: "Stop" } }),
};

/**
 * Terminal title per state. Inside tmux (nodeterm's backend) the title goes
 * through a DCS passthrough so it reaches the outer terminal; plain OSC
 * otherwise. No-op when stdout is not a TTY.
 */
export function setTitle(text: string): void {
	if (!process.stdout.isTTY) return;
	const clean = text.replace(/[\n\r\x1b]/g, " ");
	if (process.env.TMUX) {
		process.stdout.write(`\x1bPtmux;set-title ${clean}\x1b\\`);
	} else {
		process.stdout.write(`\x1b]0;${clean}\x07`);
	}
}

/**
 * Approval via the pending-files protocol.
 *
 * Returns "allow" | "deny" | "timeout" — the caller decides what "timeout"
 * means (nodeterm's reference behavior is fail-open).
 */
export function requestApproval(
	toolName: string,
	toolInput: Record<string, unknown>,
	timeoutSec?: number,
): Promise<"allow" | "deny" | "timeout"> {
	const wait = Math.max(1, Number(timeoutSec ?? process.env.NODETERM_PERM_WAIT_SECS ?? 45));
	const nodeId = process.env.NODETERM_NODE_ID ?? "node";
	const pendingId = `${nodeId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
	const dir = pendingDir();
	const requestFile = path.join(dir, `${pendingId}.json`);
	const answerFile = path.join(dir, `${pendingId}.answer`);

	const request = {
		hook_event_name: "PermissionRequest",
		hookSpecificOutput: { hookEventName: "PermissionRequest" },
		tool_name: toolName,
		tool_input: toolInput,
		node_id: nodeId,
	};

	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(requestFile, JSON.stringify(request, null, 1), { mode: 0o600 });
	} catch {
		// no pending dir (permissions, read-only home) — answer inline: the
		// approval is moot, so report the event and let the caller fall back.
		postEvent(request);
		return Promise.resolve("timeout");
	}

	postEvent(request, { nodeterm_pending_id: pendingId });

	const deadline = Date.now() + wait * 1000;
	return new Promise((resolve) => {
		const tick = (): void => {
			let answer = "";
			try {
				answer = fs.readFileSync(answerFile, "utf8").trim().toLowerCase();
			} catch {
				answer = "";
			}
			if (answer === "allow" || answer === "deny") {
				for (const f of [requestFile, answerFile]) {
					try {
						fs.rmSync(f, { force: true });
					} catch {
						/* already gone */
					}
				}
				postEvent(
					{ hook_event_name: "PostToolUse", tool_name: toolName, hookSpecificOutput: { hookEventName: "PostToolUse" } },
					{ nodeterm_answered: answer },
				);
				resolve(answer);
				return;
			}
			if (Date.now() >= deadline) {
				try {
					fs.rmSync(requestFile, { force: true });
				} catch {
					/* already gone */
				}
				resolve("timeout");
				return;
			}
			setTimeout(tick, 500);
		};
		setTimeout(tick, 500);
	});
}

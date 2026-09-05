/** Persistent shells live on Rein's own tmux server, isolated by workspace. */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, delimiter } from "node:path";
import type { AgentTool } from "../agent/agent-loop.ts";
import { truncateTail } from "../../vendor/fold/Truncation.ts";

const exec = promisify(execFile);
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 20);
const validId = (id: string) => /^rein-[a-f0-9]{20}-[a-f0-9]{12}$/.test(id);
function validateInput(text: string): void {
	if (typeof text !== "string" || text.length > 32000 || text.includes("\0")) throw new Error("Shell input must be at most 32000 characters and contain no NUL bytes.");
}
export const shellQuote = (text: string): string => "'" + text.replace(/'/g, "'\\''") + "'";
export interface TmuxSession { id: string; created: number; }
export type TmuxKind = "shell" | "visual";

export class TmuxShells {
	readonly cwd: string;
	readonly socket: string;
	readonly scope: string;
	constructor(cwd = process.cwd(), kind: TmuxKind = "shell") {
		if (kind !== "shell" && kind !== "visual") throw new Error("Unknown Rein tmux session kind.");
		this.cwd = realpathSync(resolve(cwd));
		this.scope = digest(this.cwd);
		this.socket = `rein-${kind === "visual" ? "view-" : ""}${digest(resolve(process.env.REIN_HOME || join(homedir(), ".rein")))}`;
	}
	private executable(): string {
		for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
			const path = resolve(this.cwd, directory || ".", "tmux");
			try {
				accessSync(path, constants.X_OK);
				if (statSync(path).isFile()) return path;
			} catch { /* Try the next directory in the calling process's PATH. */ }
		}
		throw new Error("tmux is not installed. Install tmux, then retry; ordinary bash mode remains available.");
	}
	private async command(args: string[], signal?: AbortSignal, input?: string, environment?: NodeJS.ProcessEnv): Promise<string> {
		signal?.throwIfAborted();
		try {
			const pending = exec(this.executable(), ["-L", this.socket, "-f", "/dev/null", ...args], { cwd: this.cwd, encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024, signal, env: environment });
			if (input !== undefined) {
				// Keep environment values off argv and disk. The client transports
				// this configuration to its own server over the private tmux socket.
				pending.child.stdin?.on("error", () => {});
				pending.child.stdin?.end(input);
			}
			const { stdout } = await pending;
			return stdout;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("tmux is not installed. Install tmux, then retry; ordinary bash mode remains available.");
			throw error;
		}
	}
	private environment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
		const current = { ...process.env, ...overrides };
		for (const [name, value] of Object.entries(current)) {
			if (!name || /[=\0\n]/.test(name) || value !== undefined && (typeof value !== "string" || value.includes("\0"))) throw new Error("Invalid shell environment variable.");
		}
		return current;
	}
	private async syncEnvironment(id: string, current: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
		const existing = await Promise.all([
			this.command(["show-environment", "-g"], signal),
			this.command(["show-environment", "-t", id], signal),
		]);
		const names = new Set(existing.join("\n").split("\n").flatMap(line => {
			const equals = line.indexOf("=");
			if (equals > 0) return [line.slice(0, equals)];
			return line.startsWith("-") ? [line.slice(1)] : [];
		}));
		const commands: string[] = [];
		for (const name of names) if (name && (!Object.hasOwn(current, name) || current[name] === undefined)) commands.push(`set-environment -r -t ${id} -- ${shellQuote(name)}`);
		for (const [name, value] of Object.entries(current)) if (value !== undefined) commands.push(`set-environment -t ${id} -- ${shellQuote(name)} ${shellQuote(value)}`);
		try { await this.command(["source-file", "-"], signal, commands.join("\n") + "\n"); }
		catch (error) {
			if (signal?.aborted) signal.throwIfAborted();
			// A parser error could otherwise quote configuration containing a key.
			throw new Error("Could not initialize tmux with the current shell environment.");
		}
	}
	private async owned(id: string, signal?: AbortSignal): Promise<string> {
		if (!validId(id) || !id.startsWith(`rein-${this.scope}-`)) throw new Error("Choose a Rein tmux session from this workspace's list.");
		const owner = (await this.command(["show-options", "-t", id, "-v", "@rein-workspace"], signal)).trim();
		if (owner !== this.scope) throw new Error("This session is not owned by the current Rein workspace.");
		return `${id}:0.0`;
	}
	async list(signal?: AbortSignal): Promise<TmuxSession[]> {
		let text: string;
		try { text = await this.command(["list-sessions", "-F", "#{session_name}\t#{@rein-workspace}\t#{session_created}"], signal); }
		catch (error) {
			if (/no server running|error connecting to .*No such file|no sessions/i.test(String((error as any).stderr ?? ""))) return [];
			throw error;
		}
		return text.trim().split("\n").flatMap(line => {
			const [id, scope, created] = line.split("\t");
			return validId(id) && scope === this.scope && id.startsWith(`rein-${this.scope}-`) ? [{ id, created: Number(created) }] : [];
		});
	}
	async start(command?: string, signal?: AbortSignal, environment: NodeJS.ProcessEnv = {}): Promise<string> {
		if (command !== undefined) validateInput(command);
		const current = this.environment(environment);
		const id = `rein-${this.scope}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
		try {
			// A cancelled client may have already created the session on the server.
			// Keep creation inside the cleanup boundary, before ownership is tagged.
			// Keep the pane alive with an inert, clean-environment placeholder
			// until the real shell's current environment is installed.
			await this.command(["new-session", "-d", "-s", id, "-c", this.cwd, "-x", "120", "-y", "36", "/usr/bin/env", "-i", "/bin/sleep", "30"], signal);
			await this.command(["set-option", "-t", id, "@rein-workspace", this.scope], signal);
			await this.command(["set-option", "-t", id, "history-limit", "2000"], signal);
			await this.syncEnvironment(id, current, signal);
			// tmux gives an unattached spawning client's PATH precedence over
			// the session PATH, including when a child has an explicit override.
			await this.command(["respawn-pane", "-k", "-t", `${id}:0.0`, "bash", "--noprofile", "--norc", "-i"], signal, undefined, current);
			if (command) await this.send(id, command, true, signal);
			return id;
		} catch (error) { await this.command(["kill-session", "-t", id]).catch(() => {}); throw error; }
	}
	/** Add a visual side pane while leaving the owned main shell selected. */
	async split(id: string, command: string, signal?: AbortSignal, environment: NodeJS.ProcessEnv = {}): Promise<string> {
		validateInput(command);
		if (!command.trim()) throw new Error("A split pane requires a command.");
		const current = this.environment(environment);
		const target = await this.owned(id, signal);
		await this.syncEnvironment(id, current, signal);
		signal?.throwIfAborted();
		let pane: string | undefined;
		try {
			// Let this short, timeout-bounded RPC return its pane ID even when
			// cancellation arrives, so only the newly created pane is cleaned up.
			// Percentage sizes through -l also work on tmux 3.4, where -p is broken.
			pane = (await this.command(["split-window", "-d", "-h", "-l", "40%", "-t", target, "-c", this.cwd, "-P", "-F", "#{pane_id}", "/bin/sh", "-c", command], undefined, undefined, current)).trim();
			if (!/^%\d+$/.test(pane)) throw new Error("tmux did not return the created pane ID.");
			signal?.throwIfAborted();
			return pane;
		} catch (error) {
			// execFile retains partial stdout on timeout, including an already
			// created pane's ID if tmux or a wrapper stalls after the response.
			const partial = (error as { stdout?: unknown } | null)?.stdout;
			const created = pane ?? (typeof partial === "string" ? partial.trim() : "");
			if (/^%\d+$/.test(created)) await this.command(["kill-pane", "-t", created]).catch(() => {});
			throw error;
		}
	}
	async capture(id: string, lines = 200, signal?: AbortSignal): Promise<string> {
		if (!Number.isSafeInteger(lines) || lines < 1 || lines > 1000) throw new Error("Capture lines must be an integer from 1 to 1000.");
		const target = await this.owned(id, signal);
		const raw = await this.command(["capture-pane", "-p", "-t", target, "-S", `-${lines}`, "-E", "-", "-J"], signal);
		// Empty viewport rows are not recent output. Otherwise a small line
		// request can return only blank lines from below the shell prompt.
		const result = truncateTail(raw.replace(/(?:\r?\n[ \t]*)+$/, ""), { maxLines: lines, maxBytes: 20000 });
		return (result.truncated ? "[capture truncated]\n" : "") + result.content;
	}
	async send(id: string, text: string, enter = true, signal?: AbortSignal): Promise<void> {
		validateInput(text);
		const target = await this.owned(id, signal);
		if (text) await this.command(["send-keys", "-t", target, "-l", "--", text], signal);
		if (enter) await this.command(["send-keys", "-t", target, "Enter"], signal);
	}
	async interrupt(id: string, signal?: AbortSignal): Promise<void> {
		await this.command(["send-keys", "-t", await this.owned(id, signal), "C-c"], signal);
	}
	async stop(id: string, signal?: AbortSignal): Promise<void> {
		await this.owned(id, signal); await this.command(["kill-session", "-t", id], signal);
	}
	async attach(id: string): Promise<number> {
		await this.owned(id);
		if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Attach requires an interactive terminal. Use capture to inspect from a pipe.");
		return await new Promise((resolveResult, reject) => {
			const child = spawn("tmux", ["-L", this.socket, "attach-session", "-t", id], { stdio: "inherit", env: { ...process.env, TMUX: "" } });
			child.on("error", reject); child.on("close", code => resolveResult(code ?? 1));
		});
	}
}

export function createTmuxTool(cwd: string): AgentTool {
	const shells = new TmuxShells(cwd);
	return { name: "tmux", executionMode: "sequential",
		description: "Persistent interactive bash sessions on Rein's own tmux server. start returns a session ID; capture reads its terminal; send types literal text and Enter by default; interrupt sends Ctrl-C; stop closes it. Sessions survive agent turns and /stop until explicitly stopped. Only this workspace's Rein sessions are accessible.",
		parameters: { type: "object", properties: {
			op: { type: "string", enum: ["start", "list", "capture", "send", "interrupt", "stop"] },
			id: { type: "string" }, command: { type: "string" }, text: { type: "string" }, enter: { type: "boolean" }, lines: { type: "integer", minimum: 1, maximum: 1000 },
		}, required: ["op"] },
		async execute(_id, args, signal) {
			try {
				const id = typeof args.id === "string" ? args.id : "";
				switch (args.op) {
					case "start": {
						const session = await shells.start(args.command as string | undefined, signal);
						return { content: `Started persistent shell ${session}. Use tmux capture to inspect output.`, details: { session, persistent: true } };
					}
					case "list": return { content: JSON.stringify(await shells.list(signal)) };
					case "capture": return { content: await shells.capture(id, args.lines as number | undefined, signal) };
					case "send": await shells.send(id, args.text as string, args.enter !== false, signal); return { content: `Input sent to ${id}. Use capture to inspect the result.` };
					case "interrupt": await shells.interrupt(id, signal); return { content: `Interrupted ${id}.` };
					case "stop": await shells.stop(id, signal); return { content: `Stopped ${id}.` };
					default: return { isError: true, content: "Unknown tmux operation." };
				}
			} catch (error) { return { isError: true, content: (error as Error).message }; }
		},
	};
}

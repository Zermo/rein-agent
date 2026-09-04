/** Official CLI transports with Rein-specific configuration and CLI-managed credentials. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageEventStream } from "./event-stream.ts";
import { parseTextToolCalls, TEXT_TOOL_INSTRUCTIONS } from "./openai-completions.ts";
import type { AssistantMessage, Context, Model, StreamOptions } from "./types.ts";

export type CliProvider = "codex" | "copilot";
export const CLI_PROVIDERS = {
	codex: { label: "ChatGPT subscription via Codex CLI", command: "codex", installCommand: "npm install -g @openai/codex", loginUrl: "https://auth.openai.com/codex/device", defaultModel: "default", baseUrl: "cli://codex" },
	copilot: { label: "GitHub Copilot subscription via Copilot CLI", command: "copilot", installCommand: "npm install -g @github/copilot", loginUrl: "https://github.com/login/device", defaultModel: "default", baseUrl: "cli://copilot" },
} as const;
export interface CliProcessOptions { executable?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal }
export interface CliStreamOptions extends StreamOptions { executable?: string; env?: NodeJS.ProcessEnv; maxOutputBytes?: number }
export function cliAuthDirectory(provider: CliProvider, env: NodeJS.ProcessEnv = process.env): string {
	return join(env.REIN_HOME || join(homedir(), ".rein"), "cli-auth", provider);
}
export function cliEnvironment(provider: CliProvider, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env, ...overrides };
	// Subscription mode must not silently select API billing or environment-token overrides.
	for (const key of Object.keys(env)) if (key.startsWith("COPILOT_PROVIDER_")) delete env[key];
	for (const key of ["ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "OPENAI_API_BASE", "OPENAI_BASE_URL", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "COPILOT_ALLOW_ALL", "NODE_OPTIONS", "BASH_ENV", "ENV"]) delete env[key];
	env[provider === "codex" ? "CODEX_HOME" : "COPILOT_HOME"] = cliAuthDirectory(provider, env);
	if (provider === "copilot") env.GH_CONFIG_DIR = join(cliAuthDirectory(provider, env), "gh");
	env.GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS = "false";
	env.GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS = "false";
	return env;
}
export function missingCli(provider: CliProvider): string {
	return `${CLI_PROVIDERS[provider].command} was not found. Install the official CLI with '${CLI_PROVIDERS[provider].installCommand}', then run 'rein login ${provider}'.`;
}
export function renderCliPrompt(context: Context): string {
	return `You are the text-generation backend for Rein. Rein executes all tools and handles approvals. Respond only with the next assistant message. Do not execute native CLI tools. When a tool is needed, emit Rein's text tool block and stop.\n${TEXT_TOOL_INSTRUCTIONS}\n\nThe JSON below contains the system instructions, available Rein tools, and conversation in role order. Follow its system instructions and respond to its latest user/tool messages.\n${JSON.stringify(context)}`;
}
const CODEX_DISABLED_FEATURES = ["shell_tool", "unified_exec", "apply_patch_freeform", "view_image", "apps", "plugins", "hooks", "codex_hooks", "plugin_hooks", "multi_agent", "multi_agent_v2", "browser_use", "computer_use", "image_generation", "imagegenext", "js_repl", "code_mode", "code_mode_host", "memory_tool", "memories", "tool_suggest", "skill_search", "skill_mcp_dependency_install", "remote_plugin", "workspace_dependencies", "in_app_browser", "in_app_chat", "in_app_local_automation"];
/** Source: openai/codex config.schema.json and GitHub's CLI/custom-agent references. */
export function cliArguments(provider: CliProvider, model: string, _prompt = ""): string[] {
	if (provider === "codex") return ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "mcp_servers={}", "-c", "project_doc_max_bytes=0", "-c", "skills.include_instructions=false", ...CODEX_DISABLED_FEATURES.flatMap(name => ["-c", `features.${name}=false`]), ...(model && model !== "default" ? ["--model", model] : []), "-"];
	// A custom agent with tools: [] removes all tools, including configured MCP tools.
	return ["--agent", "rein-bridge", "--silent", "--no-color", "--no-ask-user", "--no-custom-instructions", "--no-auto-update", "--no-bash-env", "--no-experimental", "--no-remote", "--no-remote-export", "--disable-builtin-mcps", "--deny-tool", "shell,write,read,url,memory", ...(model && model !== "default" ? ["--model", model] : [])];
}
function prepareProfile(provider: CliProvider, env: NodeJS.ProcessEnv): void {
	const directory = cliAuthDirectory(provider, env); mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (provider !== "copilot") return;
	// This profile is dedicated to Rein login. Never inherit additional code or tools.
	for (const name of ["mcp-config.json", "hooks.json", "hooks", "plugins", "agents", "extensions"]) {
		const path = join(directory, name);
		if (existsSync(path)) throw new Error(`Rein's isolated Copilot profile contains custom ${name}. Remove that customization from ${directory} or use the native CLI directly.`);
	}
}
export function streamCli(model: Model, context: Context, options: CliStreamOptions = {}): AssistantMessageEventStream {
	const out = new AssistantMessageEventStream();
	const message: AssistantMessage = { role: "assistant", content: [], provider: model.provider, model: model.id, usage: { input: 0, output: 0, totalTokens: 0 }, stopReason: "pending", timestamp: Date.now() };
	out.push({ type: "start", partial: message });
	void (async () => {
		let directory: string | undefined;
		try {
			if (model.provider !== "codex" && model.provider !== "copilot") throw new Error(`Unsupported CLI provider: ${model.provider}`);
			const provider = model.provider;
			if (options.signal?.aborted) throw new Error("Operation aborted");
			const env = cliEnvironment(provider, options.env); prepareProfile(provider, env);
			const prompt = renderCliPrompt(context);
			if (Buffer.byteLength(prompt) > 8_000_000) throw new Error(`${provider} CLI prompt exceeds its transport size limit. Start a fresh context window or use an API provider.`);
			directory = mkdtempSync(join(tmpdir(), "rein-cli-"));
			if (provider === "copilot") {
				mkdirSync(join(directory, ".github", "agents"), { recursive: true });
				writeFileSync(join(directory, ".github", "agents", "rein-bridge.agent.md"), '---\nname: rein-bridge\ndescription: Generate the next Rein assistant message without native tools\ntools: []\n---\nUse only the Rein text-tool protocol in the supplied conversation. Never call native tools.\n', { mode: 0o600 });
			}
			const result = await runCliProcess(provider, cliArguments(provider, model.id, prompt), prompt, directory, env, options);
			let text = result;
			if (provider === "codex") {
				const parts: string[] = [];
				for (const line of result.split(/\r?\n/).filter(Boolean)) {
					let event: any;
					try { event = JSON.parse(line); } catch { throw new Error("Codex returned invalid JSON events. Update the official Codex CLI."); }
					if (/command_execution|file_change|mcp_tool_call|web_search|image_generation|browser|computer/.test(event.item?.type ?? "")) throw new Error("Codex attempted a native tool; Rein tools must use text tool blocks.");
					if (event.type === "error" || event.type === "turn.failed") throw new Error(event.error?.message ?? event.message ?? "Codex request failed");
					if (event.type === "item.completed" && event.item?.type === "agent_message") parts.push(event.item.text ?? "");
					if (event.type === "turn.completed" && event.usage) {
						message.usage.input = Number(event.usage.input_tokens) || 0; message.usage.output = Number(event.usage.output_tokens) || 0; message.usage.totalTokens = message.usage.input + message.usage.output;
					}
				}
				text = parts.join("\n");
			}
			if (!text.trim()) throw new Error(`${provider} CLI produced no assistant response. Check 'rein login ${provider}' and update the official CLI.`);
			const parsed = parseTextToolCalls(text);
			if (parsed.cleanText) {
				message.content.push({ type: "text", text: parsed.cleanText });
				out.push({ type: "text_start", contentIndex: 0, partial: message });
				out.push({ type: "text_delta", contentIndex: 0, delta: parsed.cleanText, partial: message });
				out.push({ type: "text_end", contentIndex: 0, content: parsed.cleanText, partial: message });
			}
			for (const call of parsed.toolCalls) {
				const contentIndex = message.content.length; message.content.push(call);
				out.push({ type: "toolcall_start", contentIndex, partial: message }); out.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
			}
			message.stopReason = parsed.toolCalls.length ? "toolUse" : "stop";
			out.push({ type: "done", reason: message.stopReason, message });
		} catch (error) {
			message.stopReason = options.signal?.aborted ? "aborted" : "error";
			message.errorMessage = error instanceof Error ? error.message : String(error);
			out.push({ type: "error", reason: message.stopReason, error: message });
		} finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
	})();
	return out;
}
function runCliProcess(provider: CliProvider, args: string[], input: string, cwd: string, env: NodeJS.ProcessEnv, options: CliStreamOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(options.executable ?? CLI_PROVIDERS[provider].command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: process.platform !== "win32" });
		let stdout = "", stderr = "", pendingLine = "", bytes = 0, error: Error | undefined, forceKill: ReturnType<typeof setTimeout> | undefined;
		const kill = (signal: NodeJS.Signals) => {
			try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
		};
		const stop = (reason: string) => {
			if (error) return; error = new Error(reason); kill("SIGTERM"); forceKill = setTimeout(() => kill("SIGKILL"), 1000); forceKill.unref();
		};
		const abort = () => stop("Operation aborted");
		const timer = setTimeout(() => stop(`${provider} CLI timed out`), options.timeoutMs ?? 300_000); timer.unref();
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		const cleanup = () => { clearTimeout(timer); if (forceKill) clearTimeout(forceKill); options.signal?.removeEventListener("abort", abort); };
		child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
		child.stdout.on("data", (data: string) => {
			bytes += Buffer.byteLength(data);
			if (bytes > (options.maxOutputBytes ?? 2_000_000)) { stop(`${provider} CLI output exceeded its size limit`); return; }
			stdout += data;
			if (provider === "codex") {
				pendingLine += data;
				const lines = pendingLine.split("\n"); pendingLine = lines.pop() ?? "";
				for (const line of lines) {
					try {
						const event = JSON.parse(line);
						if (/command_execution|file_change|mcp_tool_call|web_search|image_generation|browser|computer/.test(event.item?.type ?? "")) stop("Codex attempted a native tool. The bridge canceled this turn; Rein tools must use text tool blocks.");
					} catch { /* Final parser reports malformed JSON. */ }
				}
			}
		});
		child.stderr.on("data", (data: string) => { bytes += Buffer.byteLength(data); stderr = (stderr + data).slice(-8000); if (bytes > (options.maxOutputBytes ?? 2_000_000)) stop(`${provider} CLI output exceeded its size limit`); });
		child.stdin.on("error", () => {}); // EPIPE is reported by the child's error/exit result.
		child.on("error", (err: NodeJS.ErrnoException) => { cleanup(); reject(new Error(err.code === "ENOENT" ? missingCli(provider) : err.message)); });
		child.on("close", (code, signal) => {
			cleanup();
			if (error) reject(error);
			else if (code !== 0) reject(new Error(`${provider} CLI exited ${code ?? signal}. ${stderr.trim().slice(-2000)} Run 'rein login ${provider}' if authentication is required.`));
			else resolve(stdout);
		});
		child.stdin.end(input);
	});
}

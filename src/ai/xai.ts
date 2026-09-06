/** xAI contracts verified against official API / Grok Build docs, September 2026. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const XAI_PRESET = { baseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY" } as const;
export const XAI_API_KEY_PAGE = "https://console.x.ai/team/default/api-keys";
export const GROK_ACCOUNT_PAGE = "https://grok.com";
export const GROK_CLI = {
	label: "SuperGrok / X Premium+ subscription via Grok Build CLI", command: "grok",
	installCommand: "npm install -g @xai-official/grok", loginUrl: GROK_ACCOUNT_PAGE,
	defaultModel: "default", baseUrl: "cli://grok",
} as const;

/** Open only the official verification URL printed by this CLI login process. */
export function grokDeviceLoginUrl(output: string): string | undefined {
	for (const value of output.match(/https:\/\/[^\s<>\u001b"']+/g) ?? []) {
		try {
			const url = new URL(value.replace(/[),.;]+$/, ""));
			if (url.origin === "https://auth.x.ai" && !url.username && !url.password) return url.toString();
		} catch { /* Wait for the rest of an incomplete line. */ }
	}
	return undefined;
}

/** Use /language-models, whose modalities distinguish chat from image/video output. */
export function xaiLanguageModelIds(doc: unknown): string[] | undefined {
	if (!doc || typeof doc !== "object" || !Array.isArray((doc as { models?: unknown }).models)) return undefined;
	const models = (doc as { models: unknown[] }).models;
	const ids = models.flatMap(item => {
		if (!item || typeof item !== "object") return [];
		const model = item as { id?: unknown; input_modalities?: unknown; output_modalities?: unknown };
		if (typeof model.id !== "string" || !model.id.trim()) return [];
		if (!Array.isArray(model.input_modalities) || !model.input_modalities.includes("text")) return [];
		if (!Array.isArray(model.output_modalities) || !model.output_modalities.includes("text")) return [];
		return [model.id];
	});
	return [...new Set(ids)];
}

/** This profile belongs to Rein; credentials are still read/written only by Grok. */
export const GROK_BRIDGE_CONFIG = `# Rein Grok bridge: native tools and automatic integrations are disabled.
[cli]
auto_update = false
show_tips = false
[session]
load_envrc = false
[ui]
permission_mode = "dontAsk"
[ui.status_line]
type = "disabled"
[permission]
rules = [{ action = "deny", tool = "*" }]
[workflows]
enabled = false
[grok_com_config]
disable_api_key_auth = true
`;

export function prepareGrokProfile(directory: string, systemDirectory = "/etc/grok"): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	// Those layers may introduce executable hooks or override the bridge's model route.
	for (const name of ["managed_config.toml", "requirements.toml"]) {
		if (existsSync(join(systemDirectory, name))) throw new Error("Grok has system-managed configuration. Rein cannot isolate its native tools from that policy; use the xai API provider or run Grok directly.");
	}
	for (const name of ["managed_config.toml", "requirements.toml", "sandbox.toml", "hooks", "plugins", "agents", "skills", "mcp.json", "mcp-config.json"]) {
		const path = join(directory, name);
		if (!existsSync(path)) continue;
		const stat = lstatSync(path);
		if (stat.isDirectory() && !stat.isSymbolicLink() && readdirSync(path).length === 0) continue;
		throw new Error(`Rein's isolated Grok profile contains custom ${name}. Remove that customization from ${directory} or use Grok directly.`);
	}
	const config = join(directory, "config.toml");
	if (existsSync(config)) {
		if (lstatSync(config).isSymbolicLink() || readFileSync(config, "utf8") !== GROK_BRIDGE_CONFIG) throw new Error(`Rein's isolated Grok profile contains custom config.toml. Preserve your changes and use a clean Rein CLI profile or the xai API provider.`);
	} else writeFileSync(config, GROK_BRIDGE_CONFIG, { flag: "wx", mode: 0o600 });
}

/** Override all inherited Grok routing, tool, auth-command, and compatibility knobs. */
export function grokEnvironment(env: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
	const result = { ...env };
	for (const key of Object.keys(result)) if (key.startsWith("GROK_") || key.startsWith("XAI_") || key === "RUST_LOG") delete result[key];
	Object.assign(result, {
		GROK_HOME: directory, GROK_DISABLE_AUTOUPDATER: "1", GROK_SANDBOX: "read-only",
		GROK_SANDBOX_AUTO_ALLOW_BASH: "0", GROK_WEB_FETCH: "0", GROK_MEMORY: "0",
		GROK_SUBAGENTS: "0", GROK_WRITE_FILE: "0", GROK_TOOL_SEARCH: "0", GROK_LSP_TOOLS: "0",
		GROK_WORKFLOWS: "0", GROK_PROMPT_SUGGESTIONS: "0", GROK_SHOW_THINKING_BLOCKS: "0",
	});
	// Codex compatibility was added in Grok 1.0.13 alongside the documented scanners.
	for (const app of ["CURSOR", "CLAUDE", "CODEX"]) for (const feature of ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS", "SESSIONS"]) result[`GROK_${app}_${feature}_ENABLED`] = "0";
	return result;
}

/** --prompt-file is supported by official Grok Build 1.0.13; do not put history in argv. */
export function grokArguments(model: string, promptPath: string): string[] {
	// 1.0.13 reinserts three shell-control tools after --tools / --disallowed-tools.
	// The catch-all deny is the execution boundary, verified with an attempted local write.
	const disabled = ["bash", "run_terminal_command", "read_file", "search_replace", "list_dir", "grep", "kill_command_or_subagent", "todo_write", "get_command_or_subagent_output", "scheduler_create", "scheduler_delete", "scheduler_list", "monitor", "search_tool", "use_tool", "update_goal", "enter_plan_mode", "exit_plan_mode", "ask_user_question", "image_gen", "image_edit", "image_to_video", "reference_to_video"];
	return ["--prompt-file", promptPath, "--output-format", "streaming-json", "--disallowed-tools", disabled.join(","), "--deny", "*",
		"--permission-mode", "dontAsk", "--sandbox", "read-only", "--no-plan", "--no-subagents", "--disable-web-search",
		"--max-turns", "1", "--system-prompt-override", "You generate the next assistant message for Rein. Follow the supplied Rein context and text-tool protocol. Rein executes tools; never execute native tools.",
		...(model && model !== "default" ? ["--model", model] : [])];
}

/** Grok's streaming-json contains ACP updates, never arbitrary stdout as an answer. */
export interface GrokEvent { text?: string; thinking?: boolean; done?: boolean; usage?: { input: number; output: number; totalTokens: number; reasoning?: number } }
function grokUsage(value: any): GrokEvent["usage"] {
	if (!value || typeof value !== "object") return undefined;
	const count = (input: unknown) => typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : 0;
	const input = count(value.input_tokens), output = count(value.output_tokens);
	return { input, output, totalTokens: input + output, ...(typeof value.reasoning_tokens === "number" ? { reasoning: count(value.reasoning_tokens) } : {}) };
}
export function grokEvent(line: string): GrokEvent {
	let value: any;
	try { value = JSON.parse(line); } catch { throw new Error("Grok returned invalid JSON events. Update the official Grok Build CLI."); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Grok returned an invalid event.");
	if (value.error || value.type === "error") throw new Error("Grok request failed. Check 'rein login grok' and your subscription/model access.");
	// Native CLI 1.0.13 uses these event names; the ACP form below remains supported.
	if (value.type === "available_commands") {
		const residual = ["run_terminal_command", "kill_command_or_subagent", "get_command_or_subagent_output"];
		if (!Array.isArray(value.tools) || value.tools.some((tool: unknown) => typeof tool !== "string" || !residual.includes(tool))) throw new Error("Grok advertised unexpected native tools. The bridge canceled this turn; use the xai API provider or update Grok Build.");
		return {};
	}
	if (value.type === "text") {
		if (typeof value.data !== "string") throw new Error("Grok returned invalid text content.");
		return { text: value.data };
	}
	if (value.type === "thought" || value.type === "thinking") return { thinking: true };
	if (value.type === "usage") return { usage: grokUsage(value.usage) };
	if (["tool_call", "tool_call_update", "permission_request"].includes(value.type)) throw new Error("Grok attempted a native tool. The bridge canceled this turn; Rein tools must use text tool blocks.");
	if (value.type === "max_turns_reached") throw new Error("Grok exceeded the bridge's single-turn limit.");
	const update = value.method === "session/update" ? value.params?.update : value.update ?? value;
	if (!update || typeof update !== "object") throw new Error("Grok returned an invalid session update.");
	const type = update.sessionUpdate;
	if (type === "tool_call" || type === "tool_call_update" || value.method === "session/request_permission") throw new Error("Grok attempted a native tool. The bridge canceled this turn; Rein tools must use text tool blocks.");
	if (type === "agent_message_chunk") {
		if (update.content?.type !== "text" || typeof update.content.text !== "string") throw new Error("Grok returned unsupported assistant content.");
		return { text: update.content.text };
	}
	if (type === "agent_thought_chunk") return { thinking: true };
	if (["user_message_chunk", "available_commands_update", "current_mode_update", "config_option_update", "session_info_update", "usage_update", "plan"].includes(type)) return {};
	// Native end events, or the documented JSON-RPC response to an ACP prompt.
	const acpResult = value.jsonrpc === "2.0" && (typeof value.id === "number" || typeof value.id === "string") && value.method === undefined && value.result && typeof value.result === "object";
	if (value.type === "end" || acpResult) {
		const reason = value.type === "end" ? value.stopReason : value.result.stopReason;
		if (reason !== "end_turn") throw new Error(`Grok did not complete its reply (${reason}).`);
		return { done: true, usage: grokUsage(value.usage ?? value.result?.usage) };
	}
	throw new Error("Grok returned an unknown event. Update the official Grok Build CLI.");
}

export function grokOutput(output: string): { text: string; usage?: GrokEvent["usage"] } {
	let text = "", done = false, usage: GrokEvent["usage"];
	for (const line of output.split(/\r?\n/).filter(line => line.trim())) {
		if (done) throw new Error("Grok sent output after its completion event. The reply was discarded.");
		const event = grokEvent(line);
		text += event.text ?? ""; done ||= event.done ?? false;
		if (event.usage) usage = event.usage;
	}
	if (!done) throw new Error("Grok did not confirm completion. The partial reply was discarded.");
	return { text, usage };
}

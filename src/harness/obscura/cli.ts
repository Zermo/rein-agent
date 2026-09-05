import { ensureObscura, installObscura, resolveObscura, OBSCURA_VERSION } from "./install.ts";
import { webOptions } from "./runtime.ts";
import webTools from "../tools/web.ts";

export async function webCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
	const action = args[0] ?? "status";
	if (!["status", "install", "search", "fetch"].includes(action)) throw new Error("Usage: rein web status|install|search <query>|fetch <url> [--json]");
	const allowedFlags = new Set(["json", ...(action === "search" ? ["max-results", "include-domains", "exclude-domains"] : action === "fetch" ? ["max-chars"] : [])]);
	for (const flag of Object.keys(flags)) if (!allowedFlags.has(flag)) throw new Error(`rein web ${action} does not support --${flag}. Remove the flag before retrying.`);
	const controller = new AbortController(); let exitCode = 130;
	const cancel = (code: number) => { if (!controller.signal.aborted) exitCode = code; controller.abort(); };
	const signals = [["SIGINT", () => cancel(130)], ["SIGHUP", () => cancel(129)], ["SIGTERM", () => cancel(143)]] as const;
	for (const [signal, handler] of signals) process.on(signal, handler);
	const progress = (message: string) => { if (flags.json !== true) console.error(message); };
	try {
		if (action === "status" || action === "install") {
			if (args.length > 1) throw new Error(`rein web ${action} accepts no positional arguments.`);
			const options = webOptions();
			const bin = action === "status" ? resolveObscura(options.bin)
				: options.bin ? await ensureObscura({ bin: options.bin, signal: controller.signal, onProgress: progress }) : await installObscura({ signal: controller.signal, onProgress: progress });
			const result = { backend: "obscura", available: !!bin, binary: bin ?? null, pinnedVersion: OBSCURA_VERSION, searchEngine: "duckduckgo", timeoutSeconds: options.timeoutSeconds, allowPrivateNetwork: options.allowPrivateNetwork };
			console.log(flags.json === true ? JSON.stringify(result) : bin ? `Obscura available: ${bin}\nSearch: DuckDuckGo. Page extraction: local browser.` : "Obscura is not installed. First web use installs it, or run rein web install.");
			return;
		}
		const value = args.slice(1).join(" ");
		if (!value) throw new Error(`Usage: rein web ${action} <${action === "search" ? "query" : "url"}> [--json]`);
		const input: Record<string, unknown> = action === "search" ? { query: value } : { url: value };
		for (const [flag, field] of [["max-results", "max_results"], ["max-chars", "max_chars"]]) {
			if (flags[flag] !== undefined) input[field] = typeof flags[flag] === "string" && String(flags[flag]).trim() ? Number(flags[flag]) : NaN;
		}
		for (const [flag, field] of [["include-domains", "include_domains"], ["exclude-domains", "exclude_domains"]]) if (flags[flag] !== undefined) input[field] = flags[flag];
		const result = await webTools[action === "search" ? 0 : 1].execute("web-cli", input, controller.signal, progress);
		if (controller.signal.aborted) throw new Error("Web operation cancelled.");
		console.log(flags.json === true ? JSON.stringify(result) : result.content);
		if (result.isError) process.exitCode = 1;
	} catch (error) {
		if (!controller.signal.aborted) throw error;
		console.error("Web operation cancelled."); process.exitCode = exitCode;
	} finally { for (const [signal, handler] of signals) process.off(signal, handler); }
}

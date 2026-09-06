/** Login is delegated to the official CLI. Rein never reads or copies its tokens. */
import { spawn, execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { CLI_PROVIDERS, cliAuthDirectory, cliEnvironment, missingCli, prepareCliProfile } from "../ai/cli-provider.ts";
import type { CliProvider, CliProcessOptions } from "../ai/cli-provider.ts";
import { grokDeviceLoginUrl } from "../ai/xai.ts";
export { CLI_PROVIDERS };
export type { CliProvider };
export interface CliAuthStatus { available: boolean; authenticated: boolean | null; detail: string }
export interface LoginCliOptions extends CliProcessOptions { deviceAuth?: boolean; interactive?: boolean; openBrowser?: boolean }
function openLoginPage(url: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
	const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
	const child = spawn(command, args, { stdio: "ignore", detached: true, shell: false });
	child.on("error", () => {}); child.unref();
}
export async function loginCli(provider: CliProvider, options: LoginCliOptions = {}): Promise<{ ok: boolean; detail: string }> {
	if (!(provider in CLI_PROVIDERS)) return { ok: false, detail: `Unknown CLI provider: ${provider}` };
	if (options.interactive === false) return { ok: false, detail: `Login requires user interaction. Run 'rein login ${provider}' in a terminal.` };
	if (options.signal?.aborted) return { ok: false, detail: "Login canceled" };
	const env = cliEnvironment(provider, options.env);
	const directory = cliAuthDirectory(provider, env); mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (provider === "grok") {
		try { prepareCliProfile(provider, env); } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
	}
	const device = options.deviceAuth !== false || provider === "grok" && options.openBrowser === false;
	const args = ["login", ...(device ? [provider !== "copilot" ? "--device-auth" : "--device-code"] : provider === "copilot" ? ["--web-flow"] : [])];
	// The CLI prints the link and one-time code directly. The browser never receives a token.
	return new Promise(resolve => {
		const captureDeviceLink = provider === "grok" && device;
		const child = spawn(options.executable ?? CLI_PROVIDERS[provider].command, args, { env, cwd: directory, stdio: captureDeviceLink ? ["inherit", "pipe", "pipe"] : "inherit", shell: false });
		let loginOutput = "", openedDevicePage = false;
		const relay = (data: Buffer, output: NodeJS.WriteStream) => {
			output.write(data);
			if (openedDevicePage || options.openBrowser === false) return;
			loginOutput = (loginOutput + data.toString()).slice(-8000);
			// Wait for a newline so a split URL cannot open a truncated verification path.
			const lastLine = loginOutput.lastIndexOf("\n");
			if (lastLine < 0) return;
			const url = grokDeviceLoginUrl(loginOutput.slice(0, lastLine));
			if (url) { openedDevicePage = true; openLoginPage(url); }
		};
		if (captureDeviceLink) {
			child.stdout?.on("data", data => relay(data, process.stdout));
			child.stderr?.on("data", data => relay(data, process.stderr));
		}
		child.once("spawn", () => { if (device && options.openBrowser !== false && provider !== "grok") openLoginPage(CLI_PROVIDERS[provider].loginUrl); });
		let timedOut = false; let forceKill: ReturnType<typeof setTimeout> | undefined;
		const stop = () => { child.kill("SIGTERM"); forceKill = setTimeout(() => child.kill("SIGKILL"), 1000); forceKill.unref(); };
		const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 900_000); timer.unref();
		options.signal?.addEventListener("abort", stop, { once: true });
		if (options.signal?.aborted) stop();
		const cleanup = () => { clearTimeout(timer); if (forceKill) clearTimeout(forceKill); options.signal?.removeEventListener("abort", stop); };
		child.on("error", (error: NodeJS.ErrnoException) => { cleanup(); resolve({ ok: false, detail: error.code === "ENOENT" ? missingCli(provider) : error.message }); });
		child.on("close", code => {
			cleanup();
			if (options.signal?.aborted || timedOut) resolve({ ok: false, detail: timedOut ? "CLI login timed out" : "Login canceled" });
			else resolve(code === 0 ? { ok: true, detail: `${CLI_PROVIDERS[provider].label} login completed using Rein's CLI configuration. Credentials remain managed by the official CLI and its keychain.` } : { ok: false, detail: `${provider} login exited ${code}. Update the official CLI and retry 'rein login ${provider}'.` });
		});
	});
}
/** Read-only checks never initiate login or issue a paid model request. */
export async function checkCliAuth(provider: CliProvider, options: CliProcessOptions = {}): Promise<CliAuthStatus> {
	if (!(provider in CLI_PROVIDERS)) return { available: false, authenticated: false, detail: `Unknown CLI provider: ${provider}` };
	const env = cliEnvironment(provider, options.env);
	const run = (args: string[]) => new Promise<{ ok: boolean; missing: boolean }>(resolve => {
		execFile(options.executable ?? CLI_PROVIDERS[provider].command, args, { env, timeout: options.timeoutMs ?? 10_000, maxBuffer: 64_000, signal: options.signal, encoding: "utf8" }, error => resolve({ ok: !error, missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT" }));
	});
	const version = await run(["--version"]);
	if (!version.ok) return { available: false, authenticated: false, detail: version.missing ? missingCli(provider) : `${provider} CLI could not be checked. Update it and try again.` };
	if (provider === "grok") return { available: true, authenticated: null, detail: "Grok Build CLI is installed. Authentication cannot be checked without starting a session; run 'rein login grok' for SuperGrok or X Premium+ sign-in." };
	if (provider === "copilot") return { available: true, authenticated: null, detail: "Copilot CLI is installed. Authentication cannot be checked without starting a session; run 'rein login copilot' if needed." };
	const status = await run(["login", "status"]);
	return { available: true, authenticated: status.ok, detail: status.ok ? "Codex CLI reports authenticated in Rein's isolated profile." : "Codex CLI is not authenticated in Rein's profile. Run 'rein login codex'." };
}

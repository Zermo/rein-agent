/** Device providers: the harness's rebuild of Argent's provider model, with a working terminal provider. */
import { join } from "node:path";
import { TmuxShells } from "../harness/tmux.ts";
import { textToImage } from "./png.ts";
import type { PngImage } from "./png.ts";
import type { FlowProvider } from "./flows.ts";

export interface ScreenshotOptions {
	/** Pixel size per text column (default 8). */
	cellWidth?: number;
	/** Pixel size per text row (default 16). */
	cellHeight?: number;
}

export interface TerminalProviderOptions {
	/** Existing Rein tmux session to drive (rein tmux start). Started bare when omitted. */
	paneId?: string;
	screenshot?: ScreenshotOptions;
	/** Injected shells for tests. */
	shells?: TmuxShells;
	/** Pane startup delay for prompt readiness (default 150 ms). */
	settleMs?: number;
}

/**
 * The terminal device: a persistent Rein tmux pane. It is a real Argent-style
 * provider — type, key, screenshot, capture-text — with no pointer surface, so
 * tap/swipe steps skip against it instead of pretending to land.
 */
export class TerminalProvider implements FlowProvider {
	readonly id: string;
	readonly platform = "terminal";
	readonly capabilities = ["type", "key", "screenshot", "capture-text"];
	readonly shells: TmuxShells;
	private readonly options: TerminalProviderOptions;
	private startedPane: string | null = null;

	constructor(shells: TmuxShells, options: TerminalProviderOptions = {}) {
		this.id = options.paneId ? `terminal:${options.paneId}` : "terminal";
		this.shells = shells;
		this.options = options;
	}

	async open(): Promise<void> {
		if (this.options.paneId) {
			const known = (await this.shells.list()).some(session => session.id === this.options.paneId);
			if (!known) throw new Error(`Pane ${this.options.paneId} is not a Rein tmux session in this workspace. Run rein tmux list.`);
			return;
		}
		this.startedPane = await this.shells.start();
		this.id = `terminal:${this.startedPane}`;
		await this.wait(this.options.settleMs ?? 150);
	}

	private target(): string {
		const pane = this.options.paneId ?? this.startedPane;
		if (!pane) throw new Error("The terminal provider has no pane; call open() first.");
		return pane;
	}

	async tap(): Promise<void> { throw new Error("Terminal surfaces have no pointer; use key or type steps."); }
	async swipe(): Promise<void> { throw new Error("Terminal surfaces have no pointer; use key or type steps."); }
	async type(text: string): Promise<void> { await this.shells.send(this.target(), text, false); await this.wait(this.options.settleMs ?? 150); }
	async key(name: string): Promise<void> { await this.shells.sendKey(this.target(), name); await this.wait(this.options.settleMs ?? 150); }
	async screenshot(): Promise<PngImage> { return textToImage((await this.captureText()).split(/\r?\n/), this.options.screenshot); }
	async captureText(): Promise<string> { return this.shells.capture(this.target(), 200); }
	async wait(ms: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, ms)); }

	async stop(): Promise<void> { if (this.startedPane) await this.shells.stop(this.startedPane); }
}

export function providerDirectory(): string {
	return join(process.env.REIN_HOME || join(process.env.HOME || ".", ".rein"), "argent", "providers");
}

export interface ProviderStatus {
	builtin: { id: string; platform: string; ready: boolean; detail: string };
	external: { path: string; providerId: string; devices: number }[];
}

/** Report which providers this machine actually has. Read-only; never boots a device. */
export async function providerStatus(): Promise<ProviderStatus> {
	const { readProviders } = await import("./contract.ts");
	const external = await readProviders(providerDirectory());
	let tmuxAvailable = false;
	try {
		const { execFileSync } = await import("node:child_process");
		execFileSync("sh", ["-c", "command -v tmux"], { stdio: "ignore", timeout: 5000 });
		tmuxAvailable = true;
	} catch { /* tmux not on PATH */ }
	return {
		builtin: {
			id: "terminal",
			platform: "terminal",
			ready: tmuxAvailable,
			detail: tmuxAvailable ? "persistent Rein tmux panes; type, key, screenshot, capture-text" : "tmux not found on PATH; the terminal provider is unavailable",
		},
		external: external.map(entry => ({ path: entry.path, providerId: entry.file.providerId, devices: entry.file.devices.length })),
	};
}

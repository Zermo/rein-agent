/** Skin engine: Rainmeter's update loop (measures tick, meters render) for one terminal. */
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseSkin } from "./parser.ts";
import type { ParsedSkin } from "./parser.ts";
import { computeMeasure, measureDue } from "./measures.ts";
import type { MeasureContext } from "./measures.ts";
import { renderMeter } from "./meters.ts";
import type { RenderContext } from "./meters.ts";

const HISTORY_CAP = 64;

export interface SkinEngineOptions {
	/** Frame width in columns (default 64). */
	width?: number;
	/** ANSI colors (default false; pass true only when NO_COLOR is unset). */
	color?: boolean;
	/** Clock for measure updates (default Date.now). */
	now?: () => number;
}

export interface SkinEngine {
	skin: ParsedSkin;
	tick(): void;
	/** Render the current state as one terminal frame. Pass true when the terminal is interactive (animation). */
	frame(interactive?: boolean): string;
}

export function createEngine(skin: ParsedSkin, options: SkinEngineOptions = {}): SkinEngine {
	const width = options.width ?? 64;
	const started = options.now ? options.now() : Date.now();
	const values = new Map<string, string>();
	const history = new Map<string, number[]>();
	let tick = 0;
	const compute = () => {
		const context: MeasureContext = { now: options.now ?? (() => Date.now()), started, tick, values };
		for (const def of skin.measures) {
			if (!measureDue(def, tick)) continue;
			values.set(def.name, computeMeasure(def, context));
			const number = Number(values.get(def.name));
			if (Number.isFinite(number)) {
				const points = (history.get(def.name) ?? []).concat(number);
				history.set(def.name, points.slice(-HISTORY_CAP));
			}
		}
	};
	const tickOnce = () => { compute(); tick += 1; };
	tickOnce();
	return {
		skin,
		tick: tickOnce,
		frame: (interactive = false) => {
			const render: RenderContext = { values, history, width, color: options.color ?? false };
			const lines = skin.meters.map(def => renderMeter(def, render));
			const header = [
				skin.metadata.Name ? `DAREECHO SKIN / ${skin.metadata.Name}` : "DAREECHO SKIN",
				"-".repeat(Math.min(32, width)),
			];
			const label = skin.source.split(/[\\/]/).pop() ?? skin.source;
			const footer = interactive ? `REIN OS SKIN / ${label} / q or Ctrl-C to leave` : `REIN OS SKIN / ${label} / --frames animates this skin`;
			const text = [...header, ...lines, footer].join("\n");
			if (!render.color) return text;
			return text
				.split("\n")
				.map((line, index) => index < 2 ? line : index === header.length + lines.length ? line.replace(interactive ? /q or Ctrl-C/ : /--frames/, match => interactive ? `q\x1b[38;2;235;188;92m or Ctrl-C\x1b[38;2;245;237;220m` : match.replace("--frames", "\x1b[38;2;235;188;92m--frames\x1b[38;2;245;237;220m")) : line)
				.join("\n");
		},
	};
}

/** Resolve a skin file, or a directory containing exactly one top-level .ini. */
export async function resolveSkinPath(path: string): Promise<string> {
	const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
	const info = await lstat(absolute).catch(error => { if (error.code === "ENOENT") throw new Error(`Skin not found: ${path}`); throw error; });
	if (info.isFile()) return absolute;
	if (!info.isDirectory()) throw new Error(`Skin must be a file or directory: ${path}`);
	const entries = await readdir(absolute, { withFileTypes: true });
	const inis = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".ini"));
	if (!inis.length) throw new Error(`No .ini skin files in ${path}.`);
	const preferred = inis.filter(entry => entry.name.toLowerCase() === absolute.split(/[\\/]/).pop()?.toLowerCase() + ".ini");
	const choice = (preferred[0] ?? inis[0]).name;
	if (inis.length > 1 && !preferred.length) throw new Error(`Multiple skins in ${path}: ${inis.map(entry => entry.name).join(", ")}. Choose one file.`);
	return join(absolute, choice);
}

/** Render one static frame from a skin file. No animation, no services, pipe-safe. */
export async function renderSkinFile(path: string, options: SkinEngineOptions = {}): Promise<string> {
	const absolute = await resolveSkinPath(path);
	const text = await readFile(absolute, "utf8");
	const skin = parseSkin(text, absolute);
	return createEngine(skin, options).frame();
}

export interface AnimateOptions {
	/** Number of frames; default 240 (30 s at 8 fps). */
	frames?: number;
	/** Refresh interval in ms; default 125 (8 fps, the Dareecho motion budget). */
	refreshMs?: number;
	/** Respect REIN_REDUCED_MOTION by rendering exactly one frame. */
	reducedMotion?: boolean;
	/** Injected for tests. */
	input?: NodeJS.ReadStream;
	output?: NodeJS.WriteStream;
	env?: NodeJS.ProcessEnv;
}

/** Animate a skin on the alternate screen. q or Ctrl-C restores the terminal. */
export async function animateSkin(path: string, options: AnimateOptions = {}): Promise<void> {
	const input = options.input ?? process.stdin, output = options.output ?? process.stdout, env = options.env ?? process.env;
	const reducedMotion = options.reducedMotion ?? /^(1|true)$/i.test(env.REIN_REDUCED_MOTION ?? "");
	const width = output.isTTY ? Math.max(20, (output.columns || 81) - 1) : 64;
	const absolute = await resolveSkinPath(path);
	const engine = createEngine(parseSkin(await readFile(absolute, "utf8"), absolute), { width, color: env.NO_COLOR === undefined });
	if (!reducedMotion && (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function" || env.TERM === "dumb")) throw new Error("Skin animation needs an interactive terminal. Use the static frame for pipes or reduced motion.");
	if (reducedMotion) {
		output.write(engine.frame(true) + "\n");
		return;
	}
	const frames = Number.isSafeInteger(options.frames) && options.frames! > 0 ? options.frames! : 240;
	const refresh = Number.isFinite(options.refreshMs) && options.refreshMs! >= 50 ? Math.floor(options.refreshMs!) : 125;
	const ESC = "\x1b[";
	const wasRaw = input.isRaw, wasFlowing = input.readableFlowing === true;
	await new Promise<void>((resolvePromise, rejectPromise) => {
		let timer: ReturnType<typeof setInterval> | undefined, finished = false, entered = false, raw = false, drawn = 0;
		const finish = (error?: Error) => {
			if (finished) return;
			finished = true;
			if (timer) clearInterval(timer);
			input.off("data", key); input.off("end", stop); input.off("error", fail);
			output.off("error", fail); output.off("close", stop);
			process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("SIGHUP", stop);
			try { if (entered && !output.destroyed) output.write(`${ESC}0m${ESC}?25h${ESC}?1049l`); } catch { /* Output may have closed. Restore input regardless. */ }
			try { if (raw) input.setRawMode(wasRaw); if (wasFlowing) input.resume(); else input.pause(); }
			catch (restoreError) { error ??= restoreError as Error; }
			error ? rejectPromise(error) : resolvePromise();
		};
		const stop = () => finish();
		const fail = (error: Error) => finish(error);
		const key = (chunk: Buffer | string) => { if (/[qQ\x03]/.test(chunk.toString())) stop(); };
		const draw = () => {
			if (drawn >= frames) { stop(); return; }
			drawn += 1;
			if (output.writableNeedDrain) return;
			try {
				engine.tick();
				output.write(`${ESC}H` + engine.frame(true).replace(/\n/g, "\r\n") + `${ESC}J`);
			} catch (error) { finish(error as Error); }
		};
		try {
			input.on("data", key); input.on("end", stop); input.on("error", fail);
			output.on("error", fail); output.on("close", stop);
			process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("SIGHUP", stop);
			input.setRawMode(true); raw = true; input.resume();
			entered = true; output.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
			draw();
			if (!finished) timer = setInterval(draw, refresh);
		} catch (error) { finish(error as Error); }
	});
}


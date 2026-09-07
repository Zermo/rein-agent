/** An explicit terminal preview; no desktop configuration or background work. */
// Canonical design.md OKLCH palette converted to sRGB for terminal/SVG surfaces.
export const RAIN_PALETTE = { cream: "#f5eddc", rust: "#b54229", amber: "#ebbc5c", green: "#284d3d", ink: "#252a25" } as const;
const ESC = "\x1b[";
const rgb = (hex: string) => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(";");
const foreground = (hex: string) => `${ESC}38;2;${rgb(hex)}m`;
const background = `${ESC}48;2;${rgb(RAIN_PALETTE.ink)}m`;
const bound = (value: number | undefined, fallback: number, max: number) => Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value!))) : fallback;

export function rainFrame(options: { width?: number; height?: number; frame?: number; color?: boolean; animated?: boolean } = {}): string {
	const width = bound(options.width, 80, 160), height = bound(options.height, 22, 48);
	const frame = Number.isSafeInteger(options.frame) && options.frame! >= 0 ? options.frame! : 0;
	const rows = Array.from({ length: height }, () => Array<string>(width).fill(" "));
	const label = (row: number, text: string) => {
		if (row >= height) return;
		const clipped = text.slice(0, width), left = Math.max(0, Math.floor((width - clipped.length) / 2));
		for (let column = 0; column < width; column++) rows[row][column] = column >= left && column < left + clipped.length ? clipped[column - left] : " ";
	};
	for (let column = 2; column < width - 2; column += 4) {
		const length = 2 + column % 4, travel = height + length + 8;
		const head = (Math.floor(frame / (1 + column % 3)) + column * 7) % travel - length;
		for (let tail = 0; tail < length; tail++) {
			const row = head - tail;
			if (row > 1 && row < height - 2) rows[row][column] = tail === 0 ? ":" : ".";
		}
	}
	label(0, "Dareecho / RAIN FIELD");
	label(1, "-".repeat(Math.min(32, width)));
	if (height >= 10) {
		label(Math.floor(height / 2) - 1, "FRESH CONTEXT.");
		label(Math.floor(height / 2), "SAME JOURNEY.");
	}
	label(height - 1, options.animated ? "RAIN PREVIEW / q or Ctrl-C to leave" : "STATIC PREVIEW / rein os rain --animate");
	return rows.map((row, index) => {
		const text = row.join("");
		if (!options.color) return text;
		if (index < 2) return background + foreground(RAIN_PALETTE.rust) + text;
		if (index === height - 1) return background + foreground(RAIN_PALETTE.amber) + text;
		return background + foreground(RAIN_PALETTE.cream) + text.replace(/[:.]/g, character => foreground(character === ":" ? RAIN_PALETTE.amber : RAIN_PALETTE.green) + character + foreground(RAIN_PALETTE.cream));
	}).join("\n") + (options.color ? `${ESC}0m` : "");
}

export interface RainOptions { animate?: boolean; static?: boolean }
interface RainIO {
	input?: NodeJS.ReadStream;
	output?: NodeJS.WriteStream;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

/** Static by default. Animation owns one temporary alternate screen and restores it. */
export async function previewRain(options: RainOptions = {}, io: RainIO = {}): Promise<void> {
	if (options.animate !== undefined && typeof options.animate !== "boolean" || options.static !== undefined && typeof options.static !== "boolean") throw new Error("Rain options --animate and --static are boolean flags.");
	if (options.animate && options.static) throw new Error("Choose --animate or --static, not both.");
	const input = io.input ?? process.stdin, output = io.output ?? process.stdout, env = io.env ?? process.env;
	const reducedMotion = /^(1|true)$/i.test(env.REIN_REDUCED_MOTION ?? "");
	if (io.signal?.aborted) return;
	if (!options.animate || reducedMotion) {
		output.write(rainFrame({ width: output.isTTY ? Math.max(1, (output.columns || 81) - 1) : 80 }) + "\n");
		return;
	}
	if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function" || env.TERM === "dumb") throw new Error("Rain animation needs an interactive terminal. Use rein os rain --static for pipes or reduced motion.");
	const wasRaw = input.isRaw, wasFlowing = input.readableFlowing === true;
	await new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setInterval> | undefined, finished = false, entered = false, raw = false, frame = 0;
		const finish = (error?: Error) => {
			if (finished) return;
			finished = true;
			if (timer) clearInterval(timer);
			input.off("data", key); input.off("end", stop); input.off("error", fail);
			output.off("error", fail); output.off("close", stop);
			process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("SIGHUP", stop);
			io.signal?.removeEventListener("abort", stop);
			try { if (entered && !output.destroyed) output.write(`${ESC}0m${ESC}?25h${ESC}?1049l`); } catch { /* Output may have closed. Restore input regardless. */ }
			try { if (raw) input.setRawMode(wasRaw); if (wasFlowing) input.resume(); else input.pause(); }
			catch (restoreError) { error ??= restoreError as Error; }
			error ? reject(error) : resolve();
		};
		const stop = () => finish();
		const fail = (error: Error) => finish(error);
		const key = (chunk: Buffer | string) => { if (/[qQ\x03]/.test(chunk.toString())) stop(); };
		const draw = () => {
			if (output.writableNeedDrain) return;
			try {
				output.write(`${ESC}H` + rainFrame({ width: Math.max(1, (output.columns || 81) - 1), height: Math.max(1, (output.rows || 25) - 1), frame: frame++, color: env.NO_COLOR === undefined, animated: true }).replace(/\n/g, "\r\n") + `${ESC}J`);
			} catch (error) { finish(error as Error); }
		};
		try {
			input.on("data", key); input.on("end", stop); input.on("error", fail);
			output.on("error", fail); output.on("close", stop);
			process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("SIGHUP", stop);
			io.signal?.addEventListener("abort", stop, { once: true });
			input.setRawMode(true); raw = true; input.resume();
			entered = true; output.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
			draw();
			if (!finished) timer = setInterval(draw, 125);
		} catch (error) { finish(error as Error); }
	});
}

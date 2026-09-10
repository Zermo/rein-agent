/** Meter rebuild: Rainmeter's visual widgets rendered as terminal text. */
import { meterOption, numeric } from "./parser.ts";
import type { MeterDef } from "./parser.ts";

export interface RenderContext {
	/** Latest value per measure name. */
	values: Map<string, string>;
	/** Recent numeric history per measure name, oldest first. */
	history: Map<string, number[]>;
	/** Target line width in columns. */
	width: number;
	/** ANSI colors are permitted (NO_COLOR respected by callers). */
	color: boolean;
}

const ESC = "\x1b[";
const foreground = (hex: string) => `${ESC}38;2;${[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(";")}m`;
const reset = () => `${ESC}0m`;

function colorize(text: string, hex: string | undefined, color: boolean): string {
	if (!color || !hex || !/^#[0-9a-fA-F]{6}$/.test(hex) || text === "") return text;
	return foreground(hex) + text + reset();
}

function reference(def: MeterDef, key: string): string {
	const name = meterOption(def, key);
	if (!name) throw new Error(`[${def.name}] ${def.type} meter needs ${key} pointing at a [Measure*] section.`);
	return name;
}

function valueOf(def: MeterDef, ctx: RenderContext): number {
	const name = reference(def, "MeasureName");
	if (!ctx.values.has(name)) throw new Error(`[${def.name}] measure [${name}] has not produced a value in this skin.`);
	const number = Number(ctx.values.get(name));
	if (!Number.isFinite(number)) throw new Error(`[${def.name}] measure [${name}] is not numeric (${ctx.values.get(name)}).`);
	return number;
}

/** IfCondition: operator plus constant, e.g. >50 or <= 80. Hidden on false (Rainmeter IfActions, trimmed). */
function visible(def: MeterDef, ctx: RenderContext): boolean {
	const condition = meterOption(def, "IfCondition");
	if (!condition) return true;
	const name = reference(def, "IfMeasureName");
	const match = condition.trim().match(/^([<>]=?|==?|!=)\s*(-?\d+(?:\.\d+)?)$/);
	if (!match) throw new Error(`[${def.name}] IfCondition supports <, <=, >, >=, =, != with a numeric value.`);
	const left = Number(ctx.values.get(name));
	const right = Number(match[2]);
	if (!Number.isFinite(left)) throw new Error(`[${def.name}] IfMeasureName [${name}] is not numeric.`);
	switch (match[1]) {
		case "<": return left < right;
		case "<=": return left <= right;
		case ">": return left > right;
		case ">=": return left >= right;
		case "=": case "==": return left === right;
		default: return left !== right;
	}
}

function align(text: string, width: number, align: string): string {
	const clipped = text.length > width ? text.slice(0, width) : text;
	const pad = Math.max(0, width - clipped.length);
	const lower = align.toLowerCase();
	if (lower === "center") {
		const left = Math.floor(pad / 2);
		return " ".repeat(left) + clipped + " ".repeat(pad - left);
	}
	if (lower === "right") return " ".repeat(pad) + clipped;
	return clipped + " ".repeat(pad);
}

const stringMeter = (def: MeterDef, ctx: RenderContext): string => {
	let text = meterOption(def, "Text") ?? (meterOption(def, "MeasureName") ? ctx.values.get(reference(def, "MeasureName")) ?? "" : "");
	// Rainmeter string text may reference measures inline: [measureName].
	text = text.replace(/\[([A-Za-z][A-Za-z0-9_]*)\]/g, (match, name: string) => {
		if (!ctx.values.has(name)) throw new Error(`[${def.name}] text references unknown or uncomputed measure [${name}].`);
		return ctx.values.get(name) ?? match;
	});
	const width = numeric(meterOption(def, "W") ?? meterOption(def, "StringWidth"), ctx.width);
	const colorHex = meterOption(def, "FontColor");
	return colorize(align(text, width, meterOption(def, "StringAlign") ?? "left"), colorHex, ctx.color);
};

const barMeter = (def: MeterDef, ctx: RenderContext): string => {
	const width = numeric(meterOption(def, "BarWidth") ?? meterOption(def, "W"), ctx.width);
	const value = valueOf(def, ctx);
	const ratio = Math.max(0, Math.min(1, value / 100));
	const filled = Math.round(ratio * width);
	const bar = "█".repeat(filled) + "░".repeat(width - filled);
	const colorHex = meterOption(def, "BarColor") ?? meterOption(def, "FontColor");
	const label = meterOption(def, "Text") ? `${align(meterOption(def, "Text")!, Math.min(12, Math.max(3, Math.floor(width / 3))), "left")} ` : "";
	return colorize(label + bar, colorHex, ctx.color) + colorize(` ${Math.round(value)}%`, meterOption(def, "FontColor"), ctx.color);
};

const GAUGE_SEGMENTS = ["▂", "▃", "▄", "▅", "▆", "▇", "█", "█", "█", "█"];
const gaugeMeter = (def: MeterDef, ctx: RenderContext): string => {
	const width = numeric(meterOption(def, "W"), 12);
	const value = valueOf(def, ctx);
	const ratio = Math.max(0, Math.min(1, value / 100));
	const filled = Math.round(ratio * width);
	const bar = GAUGE_SEGMENTS.slice(0, filled).join("") + "·".repeat(width - filled);
	const colorHex = meterOption(def, "MeterColor") ?? meterOption(def, "FontColor");
	return colorize(`${align(meterOption(def, "Text") ?? "GAUGE", 6, "left")} [${bar}]`, colorHex, ctx.color) + colorize(` ${Math.round(value)}`, meterOption(def, "FontColor"), ctx.color);
};

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const lineMeter = (def: MeterDef, ctx: RenderContext): string => {
	const width = numeric(meterOption(def, "W"), 24);
	const name = reference(def, "MeasureName");
	const points = ctx.history.get(name) ?? [];
	if (!points.length) throw new Error(`[${def.name}] Line meter needs at least one history point from [${name}].`);
	const samples = points.slice(-width);
	const min = Math.min(...samples), max = Math.max(...samples);
	const span = max - min || 1;
	const spark = samples.map(value => SPARK[Math.round(((value - min) / span) * (SPARK.length - 1))]).join("");
	const colorHex = meterOption(def, "LineColor") ?? meterOption(def, "FontColor");
	return colorize(`${align(meterOption(def, "Text") ?? name.toUpperCase(), 6, "left")} ${spark}`, colorHex, ctx.color) + colorize(` ${samples[0].toFixed(0)}→${samples[samples.length - 1].toFixed(0)}`, meterOption(def, "FontColor"), ctx.color);
};

const METERS: Record<string, (def: MeterDef, ctx: RenderContext) => string> = { String: stringMeter, Bar: barMeter, Gauge: gaugeMeter, Line: lineMeter };

export function meterType(type: string): string {
	const found = Object.keys(METERS).find(name => name.toLowerCase() === type.toLowerCase());
	if (!found) throw new Error(`Meter type ${type} is not part of this rebuild. Implemented: ${Object.keys(METERS).join(", ")}.`);
	return found;
}

export function renderMeter(def: MeterDef, ctx: RenderContext): string {
	if (!visible(def, ctx)) return " ".repeat(ctx.width);
	return METERS[meterType(def.type)](def, ctx);
}

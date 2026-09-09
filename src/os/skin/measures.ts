/** Measure rebuild: Rainmeter's value providers over Node builtins, no dependencies. */
import os from "node:os";
import { measureOption } from "./parser.ts";
import type { MeasureDef } from "./parser.ts";

export interface MeasureContext {
	/** Millisecond clock, injectable for tests. */
	now: () => number;
	/** Engine start time; the uptime clock. */
	started: number;
	/** Monotonic tick counter, one per engine update. */
	tick: number;
	/** Values computed by measures in this update, in dependency-safe order. */
	values: Map<string, string>;
}

export type Measure = (def: MeasureDef, ctx: MeasureContext) => string;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad2 = (value: number) => String(value).padStart(2, "0");

function formatTime(date: Date, format: string): string {
	return format
		.replace(/%Y/g, String(date.getFullYear()))
		.replace(/%m/g, pad2(date.getMonth() + 1))
		.replace(/%d/g, pad2(date.getDate()))
		.replace(/%H/g, pad2(date.getHours()))
		.replace(/%M/g, pad2(date.getMinutes()))
		.replace(/%S/g, pad2(date.getSeconds()))
		.replace(/%A/g, WEEKDAYS[date.getDay()])
		.replace(/%B/g, MONTHS[date.getMonth()])
		.replace(/%p/g, date.getHours() >= 12 ? "PM" : "AM");
}

const time: Measure = (def, ctx) => {
	const format = measureOption(def, "Format") ?? "%H:%M:%S";
	if (/[^%0-9A-Za-z :,/.\-]/.test(format.replace(/%[YmdHMSABp]/g, ""))) throw new Error(`[${def.name}] Time Format supports %Y %m %d %H %M %S %A %B %p only.`);
	return formatTime(new Date(ctx.now()), format);
};

const uptime: Measure = (def, ctx) => {
	const seconds = Math.max(0, Math.floor((ctx.now() - ctx.started) / 1000));
	const format = measureOption(def, "Format");
	if (format === "%T") return String(seconds);
	const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60), rest = seconds % 60;
	return `${pad2(hours)}:${pad2(minutes)}:${pad2(rest)}`;
};

const sysInfo: Measure = (def, ctx) => {
	const property = (measureOption(def, "Property") ?? "os").toLowerCase();
	switch (property) {
		case "os": return process.platform;
		case "arch": return process.arch;
		case "node": return process.versions.node;
		case "cores": return String(os.cpus().length || 0);
		case "hostname": return os.hostname();
		default: throw new Error(`[${def.name}] SysInfo Property must be os, arch, node, cores, or hostname.`);
	}
};

const string: Measure = (def) => {
	const text = measureOption(def, "Text") ?? measureOption(def, "Value") ?? "";
	return String(text);
};

const loop: Measure = (def, ctx) => {
	const start = Number(measureOption(def, "Start") ?? 0);
	const end = Number(measureOption(def, "End") ?? 100);
	const step = Math.abs(Number(measureOption(def, "Step") ?? 1));
	if (![start, end, step].every(value => Number.isFinite(value)) || step === 0) throw new Error(`[${def.name}] Loop needs finite Start/End and a nonzero Step.`);
	// Rainmeter semantics: Start to End in Step increments, then back to Start.
	const span = Math.abs(end - start);
	const cycle = Math.floor(span / step) + 1;
	const position = (ctx.tick % cycle) * step;
	return String(start < end ? start + position : start - position);
};

/** A safe calculator: digits, + - * /, parentheses, and [measure] or #variable# references. */
export function evaluateCalc(formula: string, values: Map<string, string>, where: string): number {
	const tokens: { kind: "number" | "op" | "ref" | "paren"; value: string }[] = [];
	let cursor = 0;
	while (cursor < formula.length) {
		const character = formula[cursor];
		if (/\s/.test(character)) { cursor += 1; continue; }
		if (/[0-9.]/.test(character)) {
			let number = "";
			while (cursor < formula.length && /[0-9.]/.test(formula[cursor])) number += formula[cursor++];
			tokens.push({ kind: "number", value: number });
			continue;
		}
		if (/[+\-*/]/.test(character)) { tokens.push({ kind: "op", value: character }); cursor += 1; continue; }
		if (character === "(" || character === ")") { tokens.push({ kind: "paren", value: character }); cursor += 1; continue; }
		if (character === "[") {
			const close = formula.indexOf("]", cursor);
			if (close < 0) throw new Error(`${where}: unclosed [reference] in Calc formula.`);
			tokens.push({ kind: "ref", value: formula.slice(cursor + 1, close) });
			cursor = close + 1;
			continue;
		}
		if (character === "#") {
			const close = formula.indexOf("#", cursor + 1);
			if (close < 0) throw new Error(`${where}: unclosed #reference# in Calc formula.`);
			tokens.push({ kind: "ref", value: formula.slice(cursor + 1, close) });
			cursor = close + 1;
			continue;
		}
		throw new Error(`${where}: Calc formula supports digits, + - * /, ( ), [measure] and #variable# references; found: ${character}`);
	}
	const output: { kind: "value" | "op"; value: string }[] = [];
	const precedence = { "+": 1, "-": 1, "*": 2, "/": 2 } as const;
	const stack: string[] = [];
	let previous: { kind: string; value: string } | undefined;
	for (const token of tokens) {
		if (token.kind === "number") output.push({ kind: "value", value: token.value });
		else if (token.kind === "ref") output.push({ kind: "value", value: token.value });
		else if (token.kind === "op") {
			while (stack.length && precedence[stack[stack.length - 1] as "+" | "-"] >= precedence[token.value as "+" | "-"]) output.push({ kind: "op", value: stack.pop()! });
			stack.push(token.value);
		} else if (token.value === "(") stack.push("(");
		else {
			while (stack.length && stack[stack.length - 1] !== "(") output.push({ kind: "op", value: stack.pop()! });
			if (!stack.length) throw new Error(`${where}: unbalanced parentheses in Calc formula.`);
			stack.pop(); // the matching ( — consumed by )
		}
		previous = token;
	}
	while (stack.length) {
		const top = stack.pop()!;
		if (top === "(") throw new Error(`${where}: unbalanced parentheses in Calc formula.`);
		output.push({ kind: "op", value: top });
	}
	if (previous === undefined) throw new Error(`${where}: empty Calc formula.`);
	const stack2: number[] = [];
	for (const item of output) {
		if (item.kind === "value") {
			const raw = values.get(item.value) ?? item.value;
			const number = Number(raw);
			if (!Number.isFinite(number)) throw new Error(`${where}: Calc reference ${item.value} is not numeric (${raw}).`);
			stack2.push(number);
		} else {
			const right = stack2.pop(), left = stack2.pop();
			if (left === undefined || right === undefined) throw new Error(`${where}: malformed Calc formula.`);
			switch (item.value) {
				case "+": stack2.push(left + right); break;
				case "-": stack2.push(left - right); break;
				case "*": stack2.push(left * right); break;
				default: if (right === 0) throw new Error(`${where}: division by zero in Calc formula.`); stack2.push(left / right);
			}
		}
	}
	if (stack2.length !== 1) throw new Error(`${where}: malformed Calc formula.`);
	return stack2[0];
}

const calc: Measure = (def, ctx) => {
	const formula = measureOption(def, "Formula");
	if (!formula) throw new Error(`[${def.name}] Calc needs a Formula.`);
	return String(evaluateCalc(formula, ctx.values, `[${def.name}]`));
};

const MEASURES: Record<string, Measure> = { Time: time, Uptime: uptime, SysInfo: sysInfo, String: string, Loop: loop, Calc: calc };

export function measureType(type: string): string {
	const found = Object.keys(MEASURES).find(name => name.toLowerCase() === type.toLowerCase());
	if (!found) throw new Error(`Measure type ${type} is not part of this rebuild. Implemented: ${Object.keys(MEASURES).join(", ")}.`);
	return found;
}

export function computeMeasure(def: MeasureDef, ctx: MeasureContext): string {
	const type = measureType(def.type);
	return MEASURES[type](def, ctx);
}

/** UpdateDivider: recompute only every N engine ticks (Rainmeter's UpdateDivider semantics). */
export function measureDue(def: MeasureDef, tick: number): boolean {
	const divider = Number(measureOption(def, "UpdateDivider") ?? 1);
	if (!Number.isFinite(divider) || divider < 1) throw new Error(`[${def.name}] UpdateDivider must be a whole number of 1 or more.`);
	return tick % Math.floor(divider) === 0;
}

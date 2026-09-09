/** INI skin model rebuilt from Rainmeter's ConfigParser/Skin/Section. */

export interface MeasureDef {
	name: string;
	type: string;
	options: Record<string, string>;
}

export interface MeterDef {
	name: string;
	type: string;
	options: Record<string, string>;
}

export interface ParsedSkin {
	source: string;
	updateMs: number;
	metadata: Record<string, string>;
	variables: Record<string, string>;
	styles: Record<string, Record<string, string>>;
	measures: MeasureDef[];
	meters: MeterDef[];
}

const SECTION = /^[A-Za-z][A-Za-z0-9_]*$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const VARIABLE = /#([A-Za-z][A-Za-z0-9_]*)#/g;

function substitute(text: string, variables: Record<string, string>, where: string): string {
	let value = text, pass = 0, changed = true;
	while (changed && pass < 8) {
		changed = false; pass += 1;
		value = value.replace(VARIABLE, (match, name: string) => {
			if (!(name in variables)) throw new Error(`${where}: undefined variable #${name}#.`);
			changed = true;
			return variables[name];
		});
	}
	const remainder = value.match(/#([A-Za-z][A-Za-z0-9_]*)#/);
	if (remainder) throw new Error(`${where}: variable #${remainder[1]}# does not resolve.`);
	return value;
}

/** Parse a Rainmeter-style skin. Unknown sections are rejected, not ignored. */
export function parseSkin(text: string, source = "skin"): ParsedSkin {
	const skin: ParsedSkin = { source, updateMs: 1000, metadata: {}, variables: {}, styles: {}, measures: [], meters: [] };
	let section = "";
	let options: Record<string, string> = {};
	const commit = () => {
		if (!section) return;
		const lower = section.toLowerCase();
		if (lower === "rainmeter") {
			if ("Update" in options) {
				const update = Number(options.Update);
				if (!Number.isFinite(update) || update < 50 || update > 30000) throw new Error(`${source}: [Rainmeter] Update must be 50-30000 ms.`);
				skin.updateMs = Math.floor(update);
			}
			for (const key of Object.keys(options)) if (key !== "Update" && key !== "Background" && key !== "BackgroundMode" && key !== "BackgroundMargins" && key !== "BackgroundBmp") throw new Error(`${source}: [Rainmeter] ${key} is a desktop option this terminal rebuild does not render.`);
		} else if (lower === "metadata") {
			Object.assign(skin.metadata, options);
		} else if (lower === "variables") {
			for (const [key, value] of Object.entries(options)) {
				if (!KEY.test(key)) throw new Error(`${source}: [Variables] ${key} is not a valid variable name.`);
				skin.variables[key] = substitute(value, skin.variables, `${source}: [Variables] ${key}`);
			}
		} else if (lower.startsWith("measure")) {
			const type = options.Measure;
			if (typeof type !== "string" || !type.trim()) throw new Error(`${source}: [${section}] needs a Measure type.`);
			if (skin.measures.some(measure => measure.name === section)) throw new Error(`${source}: duplicate measure [${section}].`);
			skin.measures.push({ name: section, type: type.trim(), options: resolveOptions(options, skin, section) });
		} else if (lower.startsWith("meterstyle") || lower.startsWith("style")) {
			skin.styles[lower] = { ...skin.styles[lower], ...options };
		} else if (lower.startsWith("meter")) {
			const type = options.Meter;
			if (typeof type !== "string" || !type.trim()) throw new Error(`${source}: [${section}] needs a Meter type.`);
			if (skin.meters.some(meter => meter.name === section)) throw new Error(`${source}: duplicate meter [${section}].`);
			const styleName = options.MeterStyle;
			const merged: Record<string, string> = { ...options };
			if (styleName !== undefined) {
				const style = skin.styles[styleName.toLowerCase()];
				if (!style) throw new Error(`${source}: [${section}] references unknown MeterStyle ${styleName}.`);
				Object.assign(merged, { ...style, ...options });
			}
			skin.meters.push({ name: section, type: type.trim(), options: resolveOptions(merged, skin, section) });
		} else {
			throw new Error(`${source}: section [${section}] is not a Rainmeter section this rebuild understands.`);
		}
		options = {};
	};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith(";") || line.startsWith("#")) continue;
		if (line.startsWith("[") && line.endsWith("]") && line.length >= 3 && !line.slice(1, -1).includes("]")) {
			commit();
			section = line.slice(1, -1).trim();
			if (!SECTION.test(section)) throw new Error(`${source}: [${section}] is not a valid section name.`);
			continue;
		}
		const index = line.indexOf("=");
		if (index <= 0) throw new Error(`${source}: expected key=value, got: ${line}`);
		const key = line.slice(0, index).trim(), value = line.slice(index + 1).trim();
		if (!KEY.test(key)) throw new Error(`${source}: ${key} is not a valid option name.`);
		options[key] = value;
	}
	commit();
	if (!skin.meters.length) throw new Error(`${source}: the skin has no [Meter*] sections to render.`);
	return skin;
}

function resolveOptions(options: Record<string, string>, skin: ParsedSkin, section: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(options)) result[key] = substitute(value, skin.variables, `${skin.source}: [${section}] ${key}`);
	return result;
}

export function measureOption(def: MeasureDef, key: string): string | undefined {
	return def.options[key] ?? def.options[key.toLowerCase()] ?? Object.entries(def.options).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
}

export function meterOption(def: MeterDef, key: string): string | undefined {
	return def.options[key] ?? def.options[key.toLowerCase()] ?? Object.entries(def.options).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
}

export function numeric(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const number = Number(value);
	if (!Number.isFinite(number)) throw new Error(`Expected a number, got: ${value}`);
	return number;
}

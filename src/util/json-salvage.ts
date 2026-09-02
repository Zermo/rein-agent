/**
 * JSON salvage for tool-call arguments from local models.
 *
 * Small local models are famous for emitting slightly-malformed JSON in tool
 * arguments: unescaped control characters, invalid escapes, trailing commas,
 * single quotes, missing closing brackets. pi solves this with a repair pass
 * plus a partial parser; we do the same, dependency-free.
 */

const VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function isControl(c: string): boolean {
	const cp = c.codePointAt(0)!;
	return cp >= 0x00 && cp <= 0x1f;
}

function escapeControl(c: string): string {
	switch (c) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`;
	}
}

/** Repair malformed JSON string literals (bad escapes, raw control chars). */
export function repairJson(json: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < json.length; i++) {
		const ch = json[i];
		if (!inString) {
			out += ch;
			if (ch === '"') inString = true;
			continue;
		}
		if (ch === '"') {
			out += ch;
			inString = false;
			continue;
		}
		if (ch === "\\") {
			const next = json[i + 1];
			if (next === undefined) {
				out += "\\\\";
				continue;
			}
			if (next === "u") {
				const hex = json.slice(i + 2, i + 6);
				if (/^[0-9a-fA-F]{4}$/.test(hex)) {
					out += `\\u${hex}`;
					i += 5;
					continue;
				}
			}
			if (VALID_ESCAPES.has(next)) {
				out += `\\${next}`;
				i += 1;
				continue;
			}
			out += "\\\\";
			continue;
		}
		out += isControl(ch) ? escapeControl(ch) : ch;
	}
	return out;
}

function stripTrailingCommas(json: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < json.length; i++) {
		const ch = json[i];
		if (inString) {
			out += ch;
			if (ch === "\\" && i + 1 < json.length) {
				out += json[i + 1];
				i++;
			} else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === ",") {
			let j = i + 1;
			while (j < json.length && /\s/.test(json[j])) j++;
			if (j < json.length && (json[j] === "}" || json[j] === "]")) continue; // drop comma
		}
		out += ch;
	}
	return out;
}

function closeOpenBrackets(json: string): string {
	// Count open brackets/braces outside strings and close what's missing.
	let depth: string[] = [];
	let inString = false;
	for (let i = 0; i < json.length; i++) {
		const ch = json[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[") depth.push(ch);
		else if (ch === "}") {
			if (depth[depth.length - 1] === "{") depth.pop();
		} else if (ch === "]") {
			if (depth[depth.length - 1] === "[") depth.pop();
		}
	}
	let suffix = "";
	if (inString) suffix += '"';
	for (let i = depth.length - 1; i >= 0; i--) suffix += depth[i] === "{" ? "}" : "]";
	return json + suffix;
}

/** Extract the first complete JSON object from a string (models sometimes wrap args in prose). */
function extractFirstObject(json: string): string | undefined {
	const start = json.indexOf("{");
	if (start === -1) return undefined;
	let depth = 0;
	let inString = false;
	for (let i = start; i < json.length; i++) {
		const ch = json[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return json.slice(start, i + 1);
		}
	}
	return undefined;
}

/**
 * Parse tool-call argument JSON as best-effort. Never throws.
 * Returns {} when nothing parseable is found.
 */
export function parseArgsSalvaged(json: string | undefined): Record<string, unknown> {
	if (!json || json.trim() === "") return {};
	const attempts: string[] = [];
	const obj = extractFirstObject(json.trim());
	if (obj) attempts.push(obj);
	attempts.push(json, repairJson(json), stripTrailingCommas(repairJson(json)), closeOpenBrackets(stripTrailingCommas(repairJson(json))));
	for (const candidate of attempts) {
		try {
			const value = JSON.parse(candidate);
			if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
		} catch {
			// try next
		}
	}
	return {};
}

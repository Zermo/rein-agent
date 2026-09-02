/** Output truncation for tool results: keep head + tail, report what was cut. */

export interface Truncated {
	text: string;
	truncated: boolean;
	originalLength: number;
}

export function truncateMiddle(text: string, maxChars = 20_000, keepEdges = 8_000): Truncated {
	if (text.length <= maxChars) return { text, truncated: false, originalLength: text.length };
	const head = text.slice(0, keepEdges);
	const tail = text.slice(text.length - keepEdges);
	const omitted = text.length - head.length - tail.length;
	return {
		text: `${head}\n… [${omitted} characters truncated — show more with offset/limit or pipe to a file] …\n${tail}`,
		truncated: true,
		originalLength: text.length,
	};
}

export function truncateLines(text: string, maxLines = 500): Truncated {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return { text, truncated: false, originalLength: lines.length };
	const head = lines.slice(0, Math.floor(maxLines / 2));
	const tail = lines.slice(lines.length - Math.floor(maxLines / 2));
	const omitted = lines.length - head.length - tail.length;
	return {
		text: `${head.join("\n")}\n… [${omitted} lines truncated] …\n${tail.join("\n")}`,
		truncated: true,
		originalLength: lines.length,
	};
}

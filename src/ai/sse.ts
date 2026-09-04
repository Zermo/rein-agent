/** Read SSE data fields, including multiline events and a final unterminated event. */
export async function* sseDataLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
	if (!body) return;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let data: string[] = [];
	const consume = (line: string): string | undefined => {
		if (line === "") {
			if (data.length === 0) return undefined;
			const event = data.join("\n");
			data = [];
			return event;
		}
		if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		return undefined;
	};
	try {
		while (true) {
			const { done, value } = await reader.read();
			buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buf.indexOf("\n")) !== -1) {
				const event = consume(buf.slice(0, newline).replace(/\r$/, ""));
				buf = buf.slice(newline + 1);
				if (event?.trim() === "[DONE]") return;
				if (event !== undefined) yield event;
			}
			if (done) break;
		}
		if (buf) consume(buf.replace(/\r$/, ""));
		const event = consume("");
		if (event !== undefined && event.trim() !== "[DONE]") yield event;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

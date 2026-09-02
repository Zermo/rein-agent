/**
 * SSE (server-sent events) line parser for OpenAI-compatible streaming.
 * Yields the JSON string of each `data:` payload, stopping at [DONE].
 */
export async function* sseDataLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
	if (!body) return;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, newline).replace(/\r$/, "");
				buf = buf.slice(newline + 1);
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trimStart();
				if (data === "[DONE]") return;
				if (data) yield data;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

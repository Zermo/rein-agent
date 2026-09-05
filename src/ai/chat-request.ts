/** Retry only rejected Chat Completions fields, never authentication or server failures. */
type CompatibleField = "max_tokens" | "stream_options" | "temperature" | "top_p" | "cache_prompt";
const FIELD = /\b(max_tokens|max_completion_tokens|stream_options|temperature|top_p|cache_prompt)\b/;
const UNSUPPORTED = /unsupported|not supported|does not support|unrecognized|unknown (?:parameter|field|argument)|unexpected (?:keyword )?argument|extra inputs are not permitted/i;
function rejectedField(detail: string): { field?: CompatibleField; message: string } {
	let message = detail;
	let parameter: unknown;
	let code = "";
	try {
		const data = JSON.parse(detail);
		const error = data.error ?? data;
		if (typeof error.message === "string") message = error.message;
		parameter = error.param;
		if (typeof error.code === "string") code = error.code;
		if (Array.isArray(data.detail)) {
			const issue = data.detail.find((entry: any) => Array.isArray(entry.loc) && entry.loc.some((value: unknown) => typeof value === "string" && FIELD.test(value)) && UNSUPPORTED.test(entry.msg ?? entry.type ?? ""));
			if (issue) { message = issue.msg ?? ""; parameter = issue.loc.find((value: unknown) => typeof value === "string" && FIELD.test(value)); }
		}
	} catch { /* Plain-text errors from older compatible servers are supported. */ }
	if (!UNSUPPORTED.test(`${code} ${message}`)) return { message };
	const rejectedClause = message.split(/[.!?;\n]/).find(clause => UNSUPPORTED.test(clause));
	const named = rejectedClause?.match(/(?:unsupported(?:[_ ](?:parameter|argument|field|value))?|unrecognized(?: request)?(?: argument)?(?: supplied)?|unknown(?: (?:parameter|field|argument))?|unexpected(?: keyword)?(?: argument)?)[\s:="'`]*([a-z_]+)/i)?.[1];
	const before = rejectedClause?.match(/\b(max_tokens|stream_options|temperature|top_p|cache_prompt)\b[\s"'`]*(?:is |does )?(?:not supported|not support|unsupported)/i)?.[1];
	const field = typeof parameter === "string" ? parameter.match(FIELD)?.[1] : named ? (named.match(FIELD)?.[0] === named ? named : undefined) : before;
	return { field: field === "max_completion_tokens" ? undefined : field as CompatibleField | undefined, message };
}

export async function postChatCompletion(
	url: string,
	body: Record<string, unknown>,
	init: Omit<RequestInit, "body" | "method"> = {},
	fetchFn: typeof fetch = fetch,
	onCompatibilityFallback?: (field: CompatibleField) => void,
): Promise<Response> {
	const requestBody = { ...body };
	const changed = new Set<CompatibleField>();
	for (;;) {
		init.signal?.throwIfAborted();
		const response = await fetchFn(url, { ...init, method: "POST", body: JSON.stringify(requestBody), redirect: "error" });
		if (response.status !== 400 && response.status !== 422) return response;
		const detail = await response.clone().text();
		const { field, message } = rejectedField(detail);
		if (!field || changed.has(field) || !Object.hasOwn(requestBody, field)) return response;
		if (field === "max_tokens") {
			// Rename only when the server explicitly identifies the replacement field.
			if (!/\bmax_completion_tokens\b/.test(message) || !/\bmax_tokens\b/.test(detail)) return response;
			if (!Object.hasOwn(requestBody, "max_completion_tokens")) requestBody.max_completion_tokens = requestBody.max_tokens;
		}
		delete requestBody[field]; changed.add(field);
		onCompatibilityFallback?.(field);
		await response.body?.cancel();
		// At most five field changes, hence six attempts; the same signal spans them all.
	}
}

/**
 * TinyFish web tools — our web-search and web-use layer (https://tinyfish.ai).
 *
 * Two tools, one API key:
 *   web_search  GET  https://api.search.tinyfish.ai  — fresh, structured results
 *   web_fetch   POST https://api.fetch.tinyfish.ai   — any URL → clean markdown
 *
 * Both are free at any wallet balance and never draw from it.
 *
 * Key resolution: TINYFISH_API_KEY env, then ~/.rein/config.json → tinyfish.apiKey.
 * Base URLs are overridable via TINYFISH_SEARCH_URL / TINYFISH_FETCH_URL (tests point
 * these at the local mock server). No dependencies — just fetch().
 */
import type { AgentTool } from "../../agent/agent-loop.ts";
import { loadConfig } from "../../ai/models.ts";
import { truncateLines } from "../../util/truncate.ts";

function tinyfishKey(): string {
	return process.env.TINYFISH_API_KEY ?? loadConfig().tinyfish?.apiKey ?? "";
}

function searchUrl(): string {
	return (process.env.TINYFISH_SEARCH_URL ?? "https://api.search.tinyfish.ai").replace(/\/$/, "");
}

function fetchUrl(): string {
	return (process.env.TINYFISH_FETCH_URL ?? "https://api.fetch.tinyfish.ai").replace(/\/$/, "");
}

function noKeyError(what: string): string {
	return `No TinyFish API key for ${what}. Set TINYFISH_API_KEY (free at tinyfish.ai → Get API key), or put it in ~/.rein/config.json under {"tinyfish": {"apiKey": "..."}}.`;
}

async function call(opts: { method: "GET" | "POST"; url: string; body?: unknown; timeoutMs: number; signal?: AbortSignal }): Promise<{ status: number; json: any; raw: string }> {
	const res = await fetch(opts.url, {
		method: opts.method,
		headers: { "X-API-Key": tinyfishKey(), Accept: "application/json", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
		body: opts.body ? JSON.stringify(opts.body) : undefined,
		signal: opts.signal,
	});
	const raw = await res.text();
	let json: any = null;
	try { json = JSON.parse(raw); } catch { /* non-JSON body (HTML error page, etc.) */ }
	return { status: res.status, json, raw };
}

// ------------------------------------------------------------------- search
const webSearchTool: AgentTool = {
	name: "web_search",
	description:
		"Search the live web (TinyFish). Fresh, structured results — not cached. Returns a ranked list of {title, url, site, snippet, date?}. Use for finding pages, current events, docs, prices. Then web_fetch a promising URL to read it. Supports site: filtering, recency, news, and research-paper modes.",
	parameters: {
		type: "object",
		properties: {
			query: { type: "string", description: "Search query. site:domain.com and -site:domain.com work inline." },
			purpose: { type: "string", description: "Why you are searching (the goal the results serve). Improves quality." },
			domain_type: { type: "string", enum: ["web", "news", "research_paper"], description: "web (default), news, or research_paper" },
			recency_minutes: { type: "integer", description: "Only results newer than N minutes (1..5256000). Omit for no freshness window." },
			include_domains: { type: "string", description: "Comma-separated domains to restrict to (e.g. github.com,arxiv.org)" },
			exclude_domains: { type: "string", description: "Comma-separated domains to exclude" },
			location: { type: "string", description: "Country code for geo-targeted results (e.g. US)" },
			language: { type: "string", description: "Result language code (e.g. en)" },
			page: { type: "integer", minimum: 0, maximum: 10, description: "Result page, 0-based (default 0)" },
		},
		required: ["query"],
	},
	execute: async (_id, args, signal) => {
		if (!tinyfishKey()) return { content: noKeyError("web_search"), isError: true };
		const qs = new URLSearchParams();
		qs.set("query", String(args.query));
		const pass = (k: string, cast?: (v: unknown) => unknown) => {
			const v = args[k];
			if (v !== undefined && v !== null && v !== "") qs.set(k, String(cast ? cast(v) : v));
		};
		pass("purpose");
		pass("domain_type");
		pass("recency_minutes", (v) => Number(v));
		pass("include_domains");
		pass("exclude_domains");
		pass("location");
		pass("language");
		pass("page", (v) => Number(v));

		let r: Awaited<ReturnType<typeof call>>;
		try {
			r = await call({ method: "GET", url: `${searchUrl()}/?${qs.toString()}`, timeoutMs: 30000, signal });
		} catch (err) {
			return { content: `web_search request failed: ${(err as Error).message}`, isError: true };
		}
		if (r.status === 401 || r.status === 403) return { content: `TinyFish rejected the key (HTTP ${r.status}): ${r.raw.slice(0, 200)}`, isError: true };
		if (r.status === 429) return { content: `web_search rate-limited (HTTP 429) — wait a moment and retry.`, isError: true };
		if (r.status >= 400 || !r.json) return { content: `web_search HTTP ${r.status}: ${r.raw.slice(0, 300)}`, isError: true };

		const results: any[] = r.json.results ?? [];
		if (results.length === 0) return { content: `No results for: ${args.query}`, isError: false, details: { count: 0 } };
		const lines: string[] = [];
		for (const [i, it] of results.entries()) {
			const date = it.date ? ` (${it.date})` : "";
			lines.push(`${i + 1}. ${it.title ?? "(untitled)"}${date}`);
			lines.push(`   ${it.url}`);
			if (it.snippet) lines.push(`   ${it.snippet}`);
		}
		const truncated = truncateLines(lines.join("\n"), 80);
		return { content: (r.json.total_results ?? results.length) + " results for: " + args.query + "\n" + truncated.text, isError: false, details: { count: results.length, truncated: truncated.truncated } };
	},
};

// -------------------------------------------------------------------- fetch
const webFetchTool: AgentTool = {
	name: "web_fetch",
	description:
		"Fetch any URL and get clean, LLM-ready markdown (TinyFetch). Runs a real browser behind the scenes, so it handles JS-heavy pages. Returns the page title, final URL, and extracted text (truncated). Use after web_search to read a specific page. One URL per call for the cleanest result.",
	parameters: {
		type: "object",
		properties: {
			url: { type: "string", description: "The http(s) URL to fetch" },
			purpose: { type: "string", description: "Why you are fetching this page (improves extraction)" },
			max_chars: { type: "integer", minimum: 500, maximum: 200000, description: "Max characters of page text to return (default 20000)" },
		},
		required: ["url"],
	},
	execute: async (_id, args, signal) => {
		if (!tinyfishKey()) return { content: noKeyError("web_fetch"), isError: true };
		const url = String(args.url);
		const maxChars = typeof args.max_chars === "number" ? args.max_chars : 20000;
		const body: Record<string, unknown> = { urls: [url], format: "markdown" };
		if (typeof args.purpose === "string" && args.purpose.trim()) body.purpose = args.purpose.trim();

		let r: Awaited<ReturnType<typeof call>>;
		try {
			r = await call({ method: "POST", url: fetchUrl(), body, timeoutMs: 150000, signal });
		} catch (err) {
			return { content: `web_fetch request failed: ${(err as Error).message}`, isError: true };
		}
		if (r.status === 401 || r.status === 403) return { content: `TinyFish rejected the key (HTTP ${r.status}): ${r.raw.slice(0, 200)}`, isError: true };
		if (r.status === 429) return { content: `web_fetch rate-limited (HTTP 429) — wait a moment and retry.`, isError: true };
		if (r.status >= 400 || !r.json) return { content: `web_fetch HTTP ${r.status}: ${r.raw.slice(0, 300)}`, isError: true };

		const results: any[] = r.json.results ?? [];
		const errors: any[] = r.json.errors ?? [];
		const page = results.find((x) => x.url === url) ?? results[0];
		if (!page) {
			const e = errors[0];
			return { content: `web_fetch failed for ${url}: ${e ? `${e.error}${e.status ? " (HTTP " + e.status + ")" : ""}` : "no result"}`, isError: true };
		}
		const head: string[] = [];
		head.push(`Title: ${page.title ?? "(untitled)"}`);
		if (page.final_url && page.final_url !== url) head.push(`Final URL: ${page.final_url}`);
		if (page.published_date) head.push(`Published: ${page.published_date}`);
		const text: string = typeof page.text === "string" ? page.text : JSON.stringify(page.text ?? "");
		const bodyOut = truncateLines(text, Math.floor(maxChars / 20));
		return {
			content: head.join("\n") + "\n\n" + (bodyOut.text || "(no extractable text)"),
			isError: false,
			details: { finalUrl: page.final_url, chars: text.length, truncated: bodyOut.truncated },
		};
	},
};

export default [webSearchTool, webFetchTool] as AgentTool[];

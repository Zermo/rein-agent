/** Native web tools use the local Obscura engine, with no hosted API key. */
import type { AgentTool, AgentToolResult } from "../../agent/agent-loop.ts";
import { cleanWebText, evaluatePage, httpUrl } from "../obscura/runtime.ts";
import { pageExpression, SEARCH_EXPRESSION } from "../obscura/extract.ts";

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
	return value;
}

function domains(value: unknown, name: string): string[] {
	if (value === undefined || value === "") return [];
	if (typeof value !== "string" || value.length > 2000) throw new Error(`${name} must be comma-separated hostnames.`);
	const hosts = value.split(",").map(item => item.trim().toLowerCase());
	if (hosts.length > 10 || hosts.some(host => !host || /[\s/:@?#*\\]/.test(host))) throw new Error(`${name} accepts up to 10 hostnames, without URLs or wildcards.`);
	return [...new Set(hosts.map(host => {
		const url = httpUrl(`https://${host}`);
		if (url.hostname.length > 253 || !url.hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) && label.length <= 63)) throw new Error(`${name} contains an invalid hostname.`);
		return url.hostname;
	}))];
}

function legacySearchOptions(args: Record<string, unknown>): void {
	if (args.domain_type !== undefined && args.domain_type !== "web") throw new Error("Obscura search supports the web results page. TinyFish news/research_paper modes are unavailable; use query terms and include_domains.");
	if (args.page !== undefined && args.page !== 0) throw new Error("Obscura search reads the first results page. Omit page or use page=0.");
	for (const name of ["recency_minutes", "location", "language"]) {
		if (args[name] !== undefined && args[name] !== "") throw new Error(`Obscura search does not support TinyFish's ${name} filter. Remove it and refine the query.`);
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Obscura returned an invalid extraction result.");
	return value as Record<string, unknown>;
}

function searchTarget(value: unknown, base: URL): URL | undefined {
	if (typeof value !== "string" || value.length > 8192) return;
	try {
		let url = new URL(value, base);
		if (url.hostname === "duckduckgo.com" && url.pathname === "/l/") {
			const destination = url.searchParams.get("uddg");
			if (!destination) return;
			url = httpUrl(destination, "search result URL");
		} else url = httpUrl(url.href, "search result URL");
		if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) return;
		url.hash = "";
		return url;
	} catch { return; }
}

const matchesHost = (hostname: string, domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
const toolError = (name: string, error: unknown): AgentToolResult => ({ content: `${name}: ${cleanWebText(error instanceof Error ? error.message : String(error))}`, isError: true });

const webSearchTool: AgentTool = {
	name: "web_search",
	description: "Search DuckDuckGo's first HTML results page with the local Obscura browser. Returns source URLs, titles and snippets. No API key. Supports site: query terms and strict include/exclude hostname filters. Then web_fetch promising pages. Does not provide minute recency, news/research verticals, localization, or later result pages.",
	parameters: { type: "object", properties: {
		query: { type: "string", description: "Web query, up to 2000 characters. site:domain and -site:domain work inline." },
		max_results: { type: "integer", minimum: 1, maximum: 20, description: "Maximum results from the first page, default 10. The engine may return fewer." },
		include_domains: { type: "string", description: "Comma-separated hostnames; accepts their subdomains too. Up to 10." },
		exclude_domains: { type: "string", description: "Comma-separated hostnames to exclude, including subdomains. Up to 10." },
	}, required: ["query"] },
	async execute(_id, args, signal, onUpdate) {
		try {
			if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 2000 || /[\x00-\x1f\x7f]/.test(args.query)) throw new Error("query must be nonempty text up to 2000 characters, without control characters.");
			legacySearchOptions(args);
			const max = integer(args.max_results, 10, 1, 20, "max_results"), include = domains(args.include_domains, "include_domains"), exclude = domains(args.exclude_domains, "exclude_domains");
			const query = args.query.trim();
			const hints = [query, ...(include.length ? [`(${include.map(host => `site:${host}`).join(" OR ")})`] : []), ...exclude.map(host => `-site:${host}`)].join(" ");
			const url = new URL("https://html.duckduckgo.com/html/"); url.searchParams.set("q", hints);
			const page = record(await evaluatePage(url, SEARCH_EXPRESSION, signal, onUpdate));
			if (page.kind !== "search" || !Array.isArray(page.results) || typeof page.noResults !== "boolean" || typeof page.blocked !== "boolean") throw new Error("Obscura returned invalid search data.");
			const finalUrl = httpUrl(page.url, "search page URL");
			if (!["duckduckgo.com", "html.duckduckgo.com"].includes(finalUrl.hostname)) throw new Error("Search navigation left DuckDuckGo; results were not accepted.");
			if (page.blocked) throw new Error("DuckDuckGo blocked this request or requires a CAPTCHA. Try later or web_fetch a known source URL.");
			const seen = new Set<string>(), results: { title: string; url: string; snippet: string }[] = [];
			let validCount = 0;
			for (const item of page.results.slice(0, 100)) {
				if (!item || typeof item !== "object" || typeof item.title !== "string" || !item.title.trim()) continue;
				const target = searchTarget(item.url, finalUrl);
				if (!target || seen.has(target.href)) continue;
				seen.add(target.href); validCount++;
				if (include.length && !include.some(host => matchesHost(target.hostname, host)) || exclude.some(host => matchesHost(target.hostname, host))) continue;
				results.push({ title: cleanWebText(item.title).slice(0, 1000), url: target.href, snippet: typeof item.snippet === "string" ? cleanWebText(item.snippet).slice(0, 2000) : "" });
			}
			if (!validCount && !page.noResults) throw new Error("DuckDuckGo returned no recognizable results. The page may be blocked or its markup changed; this is not a verified empty search.");
			const selected: typeof results = [], lines: string[] = []; let chars = query.length;
			for (const item of results.slice(0, max)) {
				const line = `${selected.length + 1}. ${item.title}\n   ${item.url}\n   ${item.snippet}`;
				if (chars + line.length > 25000) break;
				chars += line.length; selected.push(item); lines.push(line);
			}
			const content = selected.length ? `${selected.length} results from DuckDuckGo's first page for: ${query}\n` + lines.join("\n")
				: validCount ? `No matching domains among ${validCount} results on the first search page for: ${query}` : `No results found for: ${query}`;
			return { content, details: { backend: "obscura", engine: "duckduckgo", searchUrl: finalUrl.href, count: selected.length, results: selected, truncated: results.length > selected.length } };
		} catch (error) { return toolError("web_search", error); }
	},
};

const webFetchTool: AgentTool = {
	name: "web_fetch",
	description: "Render an HTTP(S) page with the local Obscura browser and return its title, final URL and markdown, including JavaScript content. No API key; fresh temporary browser storage for each call. This browser CLI does not expose an HTTP status code. max_chars bounds page text, default 20000.",
	parameters: { type: "object", properties: {
		url: { type: "string", description: "HTTP(S) URL without embedded credentials." },
		max_chars: { type: "integer", minimum: 500, maximum: 200000, description: "Maximum characters of markdown to return, default 20000." },
	}, required: ["url"] },
	async execute(_id, args, signal, onUpdate) {
		try {
			const url = httpUrl(args.url), max = integer(args.max_chars, 20000, 500, 200000, "max_chars");
			const page = record(await evaluatePage(url, pageExpression(max), signal, onUpdate));
			if (page.kind !== "page" || typeof page.title !== "string" || typeof page.text !== "string" || typeof page.chars !== "number" || !Number.isSafeInteger(page.chars) || page.chars < page.text.length || typeof page.truncated !== "boolean") throw new Error("Obscura returned invalid page data.");
			const finalUrl = httpUrl(page.url, "final page URL");
			const title = cleanWebText(page.title).slice(0, 1000), text = cleanWebText(page.text).slice(0, max), truncated = page.truncated || page.text.length > max;
			return { content: `Title: ${title || "(untitled)"}\nURL: ${finalUrl.href}\n\n${text || "(no extractable text)"}${truncated ? "\n[page text truncated]" : ""}`,
				details: { backend: "obscura", finalUrl: finalUrl.href, title, chars: page.chars, truncated } };
		} catch (error) { return toolError("web_fetch", error); }
	},
};

export default [webSearchTool, webFetchTool] as AgentTool[];

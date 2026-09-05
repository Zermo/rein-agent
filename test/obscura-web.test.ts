import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webTools from "../src/harness/tools/web.ts";
import { webOptions } from "../src/harness/obscura/runtime.ts";
import { webCommand } from "../src/harness/obscura/cli.ts";

const [search, fetchPage] = webTools;
const searchPage = (results: unknown[], extra = {}) => ({ kind: "search", title: "Results", url: "https://html.duckduckgo.com/html/?q=fixture", blocked: false, noResults: false, results, ...extra });
const page = (text = "# Native page") => ({ kind: "page", title: "Browser page", url: "https://example.com/final", text, chars: text.length, truncated: false });
async function fixture(run: (state: { dir: string; marker: string; script: (body: string) => void; json: (value: unknown) => void }) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "rein-obscura-test-")), marker = join(dir, "invocation.json"), bin = join(dir, "bin with spaces"); mkdirSync(bin);
	const names = ["REIN_HOME", "OBSCURA_BIN", "OBSCURA_ALLOW_PRIVATE_NETWORK", "TINYFISH_API_KEY", "REIN_API_KEY"];
	const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
	process.env.REIN_HOME = dir; process.env.OBSCURA_BIN = join(bin, "obscura"); delete process.env.OBSCURA_ALLOW_PRIVATE_NETWORK;
	const script = (body: string) => writeFileSync(join(bin, "obscura"), `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),storage:fs.realpathSync(process.argv[process.argv.indexOf('--storage-dir')+1]),keys:Object.keys(process.env)}));\n${body}\n`, { mode: 0o700 });
	const json = (value: unknown) => script(`process.stdout.write(${JSON.stringify(JSON.stringify(value))});`);
	try { await run({ dir, marker, script, json }); }
	finally { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } rmSync(dir, { recursive: true, force: true }); }
}

test("native fetch uses argv, fresh storage, no TinyFish/model credentials, and cleans up after success", () => fixture(async ({ marker, json }) => {
	json(page()); process.env.TINYFISH_API_KEY = "old-key-must-not-leave"; process.env.REIN_API_KEY = "model-key-must-not-leave";
	const url = "https://example.com/path?q=%24%28touch%20nope%29&quoted=%27";
	const updates: string[] = [];
	const result = await fetchPage.execute("fetch", { url, purpose: "legacy purpose is not sent" }, undefined, text => updates.push(text));
	assert.equal(result.isError, undefined); assert.match(result.content, /# Native page/); assert.match(result.content, /URL: https:\/\/example.com\/final/);
	const call = JSON.parse(readFileSync(marker, "utf8"));
	assert.equal(call.args[0], "fetch"); assert.equal(call.args[1], url); assert.ok(call.args.includes("--quiet"));
	assert.equal(call.storage, call.cwd); assert.equal(existsSync(call.cwd), false);
	assert.equal(call.keys.includes("TINYFISH_API_KEY"), false); assert.equal(call.keys.includes("REIN_API_KEY"), false);
	assert.equal(call.args.join(" ").includes("legacy purpose"), false); assert.ok(updates.some(text => text.includes("Obscura")));
}));

test("fetch bounds a single long line, removes terminal controls, and rejects malformed extraction", () => fixture(async ({ json }) => {
	json({ ...page("x".repeat(800)), title: "Title\u001b]0;spoof\u0007", truncated: false });
	const result = await fetchPage.execute("fetch", { url: "https://example.com", max_chars: 500 });
	assert.equal(result.isError, undefined); assert.equal((result.details as any).truncated, true);
	assert.equal(result.content.includes("x".repeat(501)), false); assert.equal(result.content.includes("\u001b"), false);
	json({ ...page(), url: "file:///private/secret" }); assert.equal((await fetchPage.execute("fetch", { url: "https://example.com" })).isError, true);
	json({ ...page(), chars: "12" }); assert.match((await fetchPage.execute("fetch", { url: "https://example.com" })).content, /invalid page data/);
}));

test("URL, config and argument errors prevent browser execution", () => fixture(async ({ dir, marker, json }) => {
	json(page());
	for (const url of ["file:///tmp/a", "javascript:alert(1)", "data:text/html,test", "https://user:secret@example.com/", "https://example.com/\n--eval", 123, ""]) {
		assert.equal((await fetchPage.execute("fetch", { url })).isError, true);
	}
	for (const max_chars of [0, 499, 200001, 500.2, "500", NaN]) assert.equal((await fetchPage.execute("fetch", { url: "https://example.com", max_chars })).isError, true);
	for (const query of ["", "\n", 5, "x".repeat(2001)]) assert.equal((await search.execute("search", { query })).isError, true);
	assert.equal(existsSync(marker), false);
	writeFileSync(join(dir, "config.json"), JSON.stringify({ obscura: { timeoutSeconds: 0 } }));
	assert.throws(webOptions, /timeoutSeconds/); assert.equal((await fetchPage.execute("fetch", { url: "https://example.com" })).isError, true);
	writeFileSync(join(dir, "config.json"), JSON.stringify({ obscura: { allowPrivateNetwork: "true" } })); assert.throws(webOptions, /allowPrivateNetwork/);
	assert.equal(existsSync(marker), false);
}));

test("search decodes results, deduplicates, filters real hostnames and keeps the original query as argv data", () => fixture(async ({ json, marker }) => {
	json(searchPage([
		{ title: "Docs", url: "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide%3Fx%3D%252F&rut=abc", snippet: "Read docs" },
		{ title: "Duplicate", url: "https://docs.example.com/guide?x=%2F", snippet: "Same" },
		{ title: "Allowed subdomain", url: "https://www.example.com/", snippet: "Root" },
		{ title: "Excluded", url: "https://private.example.com/", snippet: "No" },
		{ title: "Lookalike", url: "https://example.com.attacker.invalid/", snippet: "No" },
		{ title: "Invalid", url: "javascript:alert(1)", snippet: "No" },
		{ title: "Credentials", url: "https://user:password@example.com", snippet: "No" },
	]));
	const query = "a 'quoted' $(not-a-command) & x";
	const result = await search.execute("search", { query, include_domains: "example.com", exclude_domains: "private.example.com", max_results: 10, domain_type: "web", page: 0 });
	assert.equal(result.isError, undefined); const details = result.details as any;
	assert.equal(details.count, 2); assert.equal(details.results[0].url, "https://docs.example.com/guide?x=%2F");
	assert.doesNotMatch(result.content, /Lookalike|Excluded|Duplicate|Credentials/);
	const call = JSON.parse(readFileSync(marker, "utf8")), request = new URL(call.args[1]);
	assert.equal(request.hostname, "html.duckduckgo.com"); assert.equal(request.searchParams.get("q"), `${query} (site:example.com) -site:private.example.com`);
}));

test("verified empty results differ from blocks, changed markup, rejected redirects and domain-filtered pages", () => fixture(async ({ json }) => {
	json(searchPage([], { noResults: true })); const empty = await search.execute("search", { query: "none" }); assert.equal(empty.isError, undefined); assert.match(empty.content, /No results found/);
	json(searchPage([], { blocked: true })); assert.match((await search.execute("search", { query: "blocked" })).content, /CAPTCHA/);
	json(searchPage([])); const changed = await search.execute("search", { query: "changed" }); assert.equal(changed.isError, true); assert.match(changed.content, /not a verified empty/);
	json(searchPage([], { url: "https://elsewhere.invalid/", noResults: true })); assert.equal((await search.execute("search", { query: "redirect" })).isError, true);
	json(searchPage([{ title: "Page", url: "https://other.com/" }]));
	const filtered = await search.execute("search", { query: "filtered", include_domains: "example.com" }); assert.equal(filtered.isError, undefined); assert.match(filtered.content, /No matching domains among 1/);
}));

test("unsupported legacy filters and invalid domains fail explicitly without a request", () => fixture(async ({ json, marker }) => {
	json(searchPage([]));
	for (const extra of [{ domain_type: "news" }, { domain_type: "research_paper" }, { page: 1 }, { recency_minutes: 10 }, { location: "US" }, { language: "en" }, { max_results: 21 }, { include_domains: "example.com/" }, { exclude_domains: "*.example.com" }]) {
		const result = await search.execute("search", { query: "fixture", ...extra }); assert.equal(result.isError, true, JSON.stringify(extra));
	}
	assert.equal(existsSync(marker), false);
}));

test("web CLI rejects unknown and wrong-action flags before browser execution", () => fixture(async ({ json, marker }) => {
	json(searchPage([]));
	for (const [action, flags] of [["search", { language: "fr" }], ["search", { "max-chars": "500" }], ["fetch", { "include-domains": "example.com" }], ["status", { provider: "openai" }]] as const) {
		await assert.rejects(webCommand([action, "fixture"], flags), /does not support/);
	}
	assert.equal(existsSync(marker), false);
}));

test("search truncates oversized result sets without cutting source URLs", () => fixture(async ({ json }) => {
	json(searchPage(Array.from({ length: 20 }, (_, i) => ({ title: `Result ${i} ` + "T".repeat(990), url: `https://example.com/${i}/` + "p".repeat(7500), snippet: "S".repeat(2000) }))));
	const result = await search.execute("search", { query: "large", max_results: 20 });
	assert.equal(result.isError, undefined); assert.ok(result.content.length < 25100);
	const details = result.details as any; assert.equal(details.truncated, true); assert.ok(details.count > 0 && details.count < 20);
	for (const item of details.results) assert.ok(result.content.includes(item.url));
}));

test("invalid JSON, process errors and output overflow return bounded errors and clean storage", () => fixture(async ({ script, marker }) => {
	for (const body of ["process.stdout.write('not json')", "process.stderr.write('navigation failed'); process.exitCode=2", "process.stdout.write('x'.repeat(3*1024*1024))"]) {
		script(body); const result = await fetchPage.execute("fetch", { url: "https://example.com" });
		assert.equal(result.isError, true); assert.ok(result.content.length < 2000);
		assert.equal(existsSync(JSON.parse(readFileSync(marker, "utf8")).cwd), false);
	}
}));

test("cancellation waits for an owned TERM-resistant descendant and removes browser storage", { timeout: 10000, skip: process.platform === "win32" }, () => fixture(async ({ script, marker, dir }) => {
	const escaped = join(dir, "escaped"), ready = join(dir, "ready");
	const child = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready'); setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(escaped)},'escaped'),900); setInterval(()=>{},1000);`;
	script(`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}); setInterval(()=>{},1000);`);
	const controller = new AbortController(), result = fetchPage.execute("fetch", { url: "https://example.com" }, controller.signal);
	const deadline = Date.now() + 3000; while (!existsSync(ready)) { if (Date.now() > deadline) throw new Error("fixture did not start"); await new Promise(resolve => setTimeout(resolve, 10)); }
	controller.abort(); const aborted = await result; assert.equal(aborted.isError, true); assert.match(aborted.content, /aborted/);
	assert.equal(existsSync(JSON.parse(readFileSync(marker, "utf8")).cwd), false);
	await new Promise(resolve => setTimeout(resolve, 1000)); assert.equal(existsSync(escaped), false);
}));

test("pre-aborted web calls never create a process or download", () => fixture(async ({ json, marker }) => {
	json(page()); const controller = new AbortController(); controller.abort();
	assert.equal((await fetchPage.execute("fetch", { url: "https://example.com" }, controller.signal)).isError, true);
	assert.equal(existsSync(marker), false);
}));

test("configured navigation budget has a hard process deadline and cleans storage", { timeout: 15000 }, () => fixture(async ({ script, marker, dir }) => {
	writeFileSync(join(dir, "config.json"), JSON.stringify({ obscura: { timeoutSeconds: 1 } }));
	script("setInterval(()=>{},1000)");
	const result = await fetchPage.execute("fetch", { url: "https://example.com" });
	assert.equal(result.isError, true); assert.match(result.content, /timed out after 11s/);
	assert.equal(existsSync(JSON.parse(readFileSync(marker, "utf8")).cwd), false);
}));

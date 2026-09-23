/** Shared URL gate for bundled curl and mcp. No credentials in the URL. */
export function allowedHttpUrl(value: unknown, name = "url"): URL {
	if (typeof value !== "string" || !value.trim() || value.length > 2000 || /[\x00-\x20\x7f]/.test(value)) {
		throw new Error(`${name} must be an http(s) URL without whitespace.`);
	}
	let url: URL;
	try { url = new URL(value); }
	catch { throw new Error(`${name} must be a valid URL.`); }
	if (url.username || url.password) throw new Error(`${name}: put auth in a header or token argument, not the URL.`);
	const host = url.hostname.toLowerCase();
	if (host === "metadata.google.internal" || host === "metadata.internal" || host === "169.254.169.254") {
		throw new Error(`${name}: that host is blocked.`);
	}
	if (url.protocol === "https:") return url;
	if (url.protocol !== "http:") throw new Error(`${name}: only https, or http on loopback, LAN, or tailscale.`);
	const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
	const lan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host);
	const tailnet = host.startsWith("100.") || host.endsWith(".ts.net") || host.endsWith(".local");
	if (!loopback && !lan && !tailnet) throw new Error(`${name}: http is only allowed on loopback, LAN, or tailscale. Use https for public hosts.`);
	return url;
}

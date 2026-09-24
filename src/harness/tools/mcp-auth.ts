/** MCP OAuth through the bundled SDK. The callback finishes the token exchange. */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { AUTH_CALLBACK, acceptCallback, clearAuthCode, prepareAuthLink, pushAuthLink, readOauthSession, saveOauthSession, type AuthCard } from "../auth-link.ts";
import { reinHome } from "../stack.ts";

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export function tokenFile(home: string, serverUrl: string): string {
	const dir = join(home, "stack", "auth", "mcp-tokens");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return join(dir, `${createHash("sha256").update(serverUrl).digest("hex").slice(0, 32)}.json`);
}

export function savedAccessToken(serverUrl: string, home = reinHome()): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(tokenFile(home, serverUrl), "utf8")) as { tokens?: { access_token?: string } };
		return typeof parsed.tokens?.access_token === "string" ? parsed.tokens.access_token : undefined;
	} catch { return undefined; }
}

export function bundledAuthProvider(id: string, serverUrl: string, home: string): OAuthClientProvider & { pushed?: AuthCard } {
	const provider: OAuthClientProvider & { pushed?: AuthCard } = {
		get redirectUrl() { return AUTH_CALLBACK; },
		get clientMetadata() {
			return {
				redirect_uris: [AUTH_CALLBACK],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				client_name: "rein",
			};
		},
		state: () => id,
		clientInformation() {
			return readOauthSession(id, home).client as never;
		},
		saveClientInformation(info) { saveOauthSession(id, home, { client: info as Record<string, unknown> }); },
		tokens() {
			const token = savedAccessToken(serverUrl, home);
			return token ? { access_token: token, token_type: "bearer" } : undefined;
		},
		saveTokens(tokens: OAuthTokens) {
			writeFileSync(tokenFile(home, serverUrl), JSON.stringify({ server: serverUrl, tokens }), { mode: 0o600 });
		},
		async redirectToAuthorization(authorizationUrl: URL) {
			provider.pushed = pushAuthLink(id, authorizationUrl.toString(), home);
		},
		saveCodeVerifier(verifier: string) { saveOauthSession(id, home, { verifier }); },
		codeVerifier() { return readOauthSession(id, home).verifier ?? ""; },
		saveDiscoveryState(state) { saveOauthSession(id, home, { discovery: state as unknown as Record<string, unknown>, serverUrl }); },
		discoveryState() { return readOauthSession(id, home).discovery as never; },
	};
	return provider;
}

export async function startBundledMcpAuth(serverUrl: string, label: string, home = reinHome()): Promise<AuthCard & { result?: string; error?: string }> {
	const prepared = prepareAuthLink("oauth", label, home);
	saveOauthSession(prepared.id, home, { serverUrl });
	const provider = bundledAuthProvider(prepared.id, serverUrl, home);
	try {
		const result = await auth(provider, { serverUrl });
		return { ...(provider.pushed ?? prepared), result, status: result === "AUTHORIZED" ? "arrived" : (provider.pushed ?? prepared).status };
	} catch (error) {
		return { ...(provider.pushed ?? prepared), error: error instanceof Error ? error.message : String(error) };
	}
}

export function pushBundledAuthLink(authorizeUrl: string, label: string, home = reinHome(), serverUrl?: string): AuthCard {
	const prepared = prepareAuthLink("oauth", label, home);
	if (serverUrl) saveOauthSession(prepared.id, home, { serverUrl });
	return pushAuthLink(prepared.id, authorizeUrl, home);
}

export async function completeBundledAuth(search: string, home: string, fetchFn?: FetchLike): Promise<string> {
	const page = acceptCallback(search, home);
	const params = new URLSearchParams(search.replace(/^\?/, ""));
	const code = params.get("code");
	const id = params.get("state") ?? "";
	const serverUrl = id ? readOauthSession(id, home).serverUrl : undefined;
	if (!code || !serverUrl) return page;
	try {
		const result = await auth(bundledAuthProvider(id, serverUrl, home), { serverUrl, authorizationCode: code, fetchFn });
		if (result === "AUTHORIZED") clearAuthCode(id, home);
		return page.replace("Authorization received.", "Token created.");
	} catch {
		return page.replace("Authorization received.", "Authorization received. Token exchange did not finish.");
	}
}

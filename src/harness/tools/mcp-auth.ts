/** MCP OAuth through the bundled SDK. The link is ours. The token is not a note. */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { AUTH_CALLBACK, prepareAuthLink, pushAuthLink, type AuthCard } from "../auth-link.ts";
import { reinHome } from "../stack.ts";

function tokenFile(home: string, serverUrl: string): string {
	const dir = join(home, "stack", "auth", "mcp-tokens");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return join(dir, `${createHash("sha256").update(serverUrl).digest("hex").slice(0, 32)}.json`);
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
		clientInformation: () => undefined,
		tokens: () => undefined,
		saveTokens(tokens: OAuthTokens) {
			writeFileSync(tokenFile(home, serverUrl), JSON.stringify({ server: serverUrl, tokens }), { mode: 0o600 });
		},
		async redirectToAuthorization(authorizationUrl: URL) {
			provider.pushed = pushAuthLink(id, authorizationUrl.toString(), home);
		},
		saveCodeVerifier() {},
		codeVerifier: () => "",
	};
	return provider;
}

export async function startBundledMcpAuth(serverUrl: string, label: string, home = reinHome()): Promise<AuthCard & { result?: string; error?: string }> {
	const prepared = prepareAuthLink("oauth", label, home);
	const provider = bundledAuthProvider(prepared.id, serverUrl, home);
	try {
		const result = await auth(provider, { serverUrl });
		return { ...(provider.pushed ?? prepared), result, status: result === "AUTHORIZED" ? "arrived" : (provider.pushed ?? prepared).status };
	} catch (error) {
		return { ...(provider.pushed ?? prepared), error: error instanceof Error ? error.message : String(error) };
	}
}

export function pushBundledAuthLink(authorizeUrl: string, label: string, home = reinHome()): AuthCard {
	const prepared = prepareAuthLink("oauth", label, home);
	return pushAuthLink(prepared.id, authorizeUrl, home);
}

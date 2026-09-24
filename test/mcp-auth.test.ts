import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listAuthLinks, prepareAuthLink, saveOauthSession } from "../src/harness/auth-link.ts";
import { bundledAuthProvider, completeBundledAuth, pushBundledAuthLink, savedAccessToken } from "../src/harness/tools/mcp-auth.ts";

test("bundled mcp auth pushes the sdk redirect and does not return a token", async () => {
	const home = mkdtempSync(join(tmpdir(), "rein-mcp-auth-"));
	try {
		const card = pushBundledAuthLink("https://example.com/authorize", "Robinhood", home);
		assert.equal(card.callback, "https://reinklaud.zermo.org/auth/callback");
		assert.equal(JSON.stringify(card).includes("access_token"), false);
		const provider = bundledAuthProvider(card.id, "https://example.com/mcp", home);
		provider.saveTokens({ access_token: "not-for-the-card", token_type: "bearer" });
		assert.equal(JSON.stringify(listAuthLinks(home)).includes("not-for-the-card"), false);
		await provider.redirectToAuthorization(new URL("https://example.com/authorize?ready=1"));
		assert.match(listAuthLinks(home)[0]?.url ?? "", /ready=1/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("callback hook exchanges the code for a token and does not show it", async () => {
	const home = mkdtempSync(join(tmpdir(), "rein-mcp-auth-"));
	try {
		const card = prepareAuthLink("oauth", "Robinhood", home);
		saveOauthSession(card.id, home, {
			serverUrl: "https://mcp.example",
			verifier: "verifier-1",
			client: { client_id: "rein", token_endpoint_auth_method: "none" },
			discovery: {
				authorizationServerUrl: "https://auth.example",
				authorizationServerMetadata: { issuer: "https://auth.example", token_endpoint: "https://auth.example/token", token_endpoint_auth_methods_supported: ["none"] },
			},
		});
		const page = await completeBundledAuth(`state=${card.id}&code=one-time`, home, async () => new Response(JSON.stringify({ access_token: "created-token", token_type: "bearer" }), { status: 200, headers: { "content-type": "application/json" } }));
		assert.match(page, /Token created/);
		assert.equal(page.includes("created-token"), false);
		assert.equal(page.includes("one-time"), false);
		assert.equal(savedAccessToken("https://mcp.example", home), "created-token");
		assert.equal(JSON.stringify(listAuthLinks(home)).includes("created-token"), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

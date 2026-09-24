import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listAuthLinks } from "../src/harness/auth-link.ts";
import { bundledAuthProvider, pushBundledAuthLink } from "../src/harness/tools/mcp-auth.ts";

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

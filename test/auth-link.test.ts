import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acceptCallback, listAuthLinks, prepareAuthLink, pushAuthLink, readReceipt } from "../src/harness/auth-link.ts";

test("an auth link pushes a callback and reads the receipt once", () => {
	const home = mkdtempSync(join(tmpdir(), "rein-auth-"));
	try {
		const prepared = prepareAuthLink("oauth", "Robinhood", home);
		assert.equal(prepared.callback, "https://reinklaud.zermo.org/auth/callback");
		assert.equal(prepared.state, prepared.id);
		const shown = pushAuthLink(prepared.id, "https://example.com/authorize?state=" + prepared.id, home);
		assert.match(shown.url, /^https:\/\/example.com\/authorize/);
		assert.equal(listAuthLinks(home)[0]?.url, shown.url);
		assert.throws(() => pushAuthLink(prepared.id, "https://user:secret@example.com/authorize", home), /not the URL/);
		const page = acceptCallback(`?state=${prepared.id}&code=one-time-code`, home);
		assert.equal(page.includes("one-time-code"), false);
		assert.match(page, /Return to klaud/);
		const receipt = readReceipt(prepared.id, home);
		assert.equal(receipt.fields.code, "one-time-code");
		assert.equal(readReceipt(prepared.id, home).fields.code, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

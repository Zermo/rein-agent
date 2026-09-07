import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelAccount } from "../src/models/account.ts";

test("model account reuses environment or hf cache without creating Rein configuration", async () => {
	const home = await mkdtemp(join(tmpdir(), "rein-model-account-"));
	try {
		assert.deepEqual(await modelAccount({ HF_HOME: home }), { source: "none" });
		await writeFile(join(home, "token"), "hf_fixture_cached\n", { mode: 0o600 });
		assert.deepEqual(await modelAccount({ HF_HOME: home }), { source: "hf-cache", token: "hf_fixture_cached" });
		assert.deepEqual(await modelAccount({ HF_HOME: home, HF_TOKEN: "hf_fixture_env" }), { source: "environment", token: "hf_fixture_env" });
		await assert.rejects(modelAccount({ HF_TOKEN: "hf_fixture\r\nheader" }), error => !String(error).includes("hf_fixture"));
	} finally { await rm(home, { recursive: true, force: true }); }
});

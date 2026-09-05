import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "../src/harness/tools/bash.ts";

test("Fold truncation caps a single long bash output line by UTF-8 bytes", async () => {
	const result = await createBashTool().execute("huge", { command: "printf '%100000s' x" });
	assert.ok(Buffer.byteLength(result.content) < 21000);
	assert.match(result.content, /truncated/);
	assert.ok(result.content.includes("x"));
});

test("cancelling bash stops its child process group before children can keep writing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rein-bash-cancel-"));
	try {
		const controller = new AbortController();
		const work = createBashTool(dir).execute("cancel", { command: "bash -c 'sleep 0.5; printf continued > marker' & wait" }, controller.signal);
		setTimeout(() => controller.abort(), 100);
		const result = await work;
		await new Promise(resolve => setTimeout(resolve, 650));
		assert.equal(existsSync(join(dir, "marker")), false);
		assert.match(result.content, /aborted|cancelled/i);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

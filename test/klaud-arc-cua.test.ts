import test from "node:test";
import assert from "node:assert/strict";
import { parseArcCuaPayload, runArcCuaHarness } from "../src/harness/klaud/arc-cua.ts";
import { createKlaudTools } from "../src/harness/klaud/tools.ts";

const gaussian = {
	goal: "Apply Gaussian Blur to the selected clip",
	verification: ["The selected clip has Gaussian Blur applied"],
	inputs: { effect_name: "Gaussian Blur" },
	constraints: ["Do not modify any other clip"],
};

test("arc_cua demo completes a bounded subtask", async () => {
	const tool = createKlaudTools().find(item => item.name === "arc_cua")!;
	const result = await tool.execute("t", gaussian);
	assert.equal(result.isError, undefined);
	assert.deepEqual(JSON.parse(result.content), {
		status: "SUBTASK_COMPLETE",
		actions_taken: 3,
		reason: null,
		history: [
			{ action: "CLICK", target: "effects_button" },
			{ action: "TYPE_TEXT", target: "effects_search", value: "Gaussian Blur" },
			{ action: "DOUBLE_CLICK", target: "gaussian_blur" },
		],
	});
});

test("arc_cua rejects unknown fields and blocks desktop without sidecar URL", async () => {
	assert.throws(() => parseArcCuaPayload({ goal: "x", verification: ["y"], click: true }), /Unknown subtask fields/);
	const previous = process.env.ARC_CUA_URL;
	process.env.ARC_CUA_URL = "";
	try {
		assert.equal((await runArcCuaHarness(parseArcCuaPayload({ ...gaussian, mode: "desktop" }))).status, "BLOCKED");
	} finally {
		if (previous === undefined) delete process.env.ARC_CUA_URL;
		else process.env.ARC_CUA_URL = previous;
	}
	assert.equal((await runArcCuaHarness(parseArcCuaPayload({ ...gaussian, mode: "jev" }))).status, "NEEDS_AGENT");
});

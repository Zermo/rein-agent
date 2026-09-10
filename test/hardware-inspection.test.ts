import test from "node:test";
import assert from "node:assert/strict";
import { inspectHardware, summarizeInspection } from "../src/hardware/inspection.ts";

test("hardware report distinguishes the remote host and excludes driver identities and recipe paths", () => {
  const raw = { hardware: { ram: { total: 128, available: 64 }, cpu: { cores: 20 }, gpus: [{ name: "Fixture GPU", uuid: "private-uuid", sharedMemory: true }] }, tools: {}, models: [{ id: "fixture", name: "Fixture", verdict: "fits", footprint: 32, privatePath: "/private/model" }], contextTokens: 16384 };
  const result = summarizeInspection(JSON.stringify(raw), "model-host");
  assert.equal(result.target, "model-host");
  assert.equal(result.contextTokens, 16384);
  assert.doesNotMatch(JSON.stringify(result), /private-uuid|\/private\/model/);
  assert.throws(() => summarizeInspection("invalid", "local"), /valid report/);
});
test("hardware inspection rejects arbitrary remote commands and host overrides", async () => {
  await assert.rejects(inspectHardware({ target: "model-host", command: "arbitrary" }), /Choose/);
  await assert.rejects(inspectHardware({ target: "some-host" }), /Choose/);
});

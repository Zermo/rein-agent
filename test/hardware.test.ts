import assert from "node:assert/strict";
import test from "node:test";
import { profileLinux } from "../src/hardware/profile.ts";

test("Linux profiling returns hardware data with unknown bandwidth without crashing", async () => {
  // Exercises this branch even on macOS; missing Linux probes return empty fields.
  // On Linux CI, /proc supplies the real CPU/memory data.
  const profile = await profileLinux();
  assert.equal(profile.os, "linux");
  assert.equal(profile.unifiedMemory, false);
  assert.ok(Number.isFinite(profile.ram.totalBytes));
  assert.ok(Number.isFinite(profile.cpu.cores));
  assert.equal(profile.memBandwidthGBs, undefined);
  if (process.platform === "linux") {
    assert.ok(profile.ram.totalBytes > 0);
    assert.ok(profile.cpu.cores > 0);
  }
});

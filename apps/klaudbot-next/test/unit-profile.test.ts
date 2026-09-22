import assert from "node:assert/strict";
import test from "node:test";
import { accentHex, normalizeUnit, UNIT_ACCENTS } from "../lib/unit-profile.ts";

test("unit profile clips soul, keeps known accent, and caps routines", () => {
  const next = normalizeUnit({
    accent: "nope", theme: "paper", soul: `${"a".repeat(9000)}\u0000`, directive: "Hold the line.",
    routines: [...Array(20)].map((_, i) => ({ id: `r${i}`, title: "Scan", when: "03:30", loop: "scan", enabled: true })),
  });
  assert.equal(next.accent, "rain");
  assert.equal(next.theme, "paper");
  assert.equal(next.soul.length, 8000);
  assert.equal(next.soul.includes("\u0000"), false);
  assert.equal(next.directive, "Hold the line.");
  assert.equal(next.routines.length, 12);
  assert.equal(accentHex("gold"), UNIT_ACCENTS.gold);
  assert.equal(accentHex("missing"), UNIT_ACCENTS.rain);
});

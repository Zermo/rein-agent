import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseIdentity, parseWhen, routineDue } from "../lib/unit-identity.ts";
import { loadHarnessUnit, saveHarnessUnit } from "../lib/unit-harness.ts";

test("daily and interval when-specs, and due only after arming", () => {
  assert.deepEqual(parseWhen("03:30 daily"), { kind: "daily", hour: 3, minute: 30 });
  assert.deepEqual(parseWhen("every 30m"), { kind: "every", ms: 30 * 60_000 });
  assert.equal(parseWhen("whenever").kind, "none");
  const row = { id: "r1", title: "Scan", when: "03:30", loop: "scan" as const, enabled: true, lastFire: 0 };
  assert.equal(routineDue(row, Date.parse("2026-09-21T07:00:00")), false);
  row.lastFire = Date.parse("2026-09-20T20:00:00");
  assert.equal(routineDue(row, Date.parse("2026-09-21T03:29:00")), false);
  assert.equal(routineDue(row, Date.parse("2026-09-21T03:30:00")), true);
});

test("unmarked identity is soul; save is soul + directive only", () => {
  assert.equal(parseIdentity("# Ares\n\nKeep this standing law.\n").soul.includes("Keep this standing law"), true);
  const home = mkdtempSync(join(tmpdir(), "klaud-unit-"));
  mkdirSync(join(home, "klaud"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "klaud", "bots.json"), JSON.stringify({ version: 1, bots: [{ id: "klaud-bot-a5e5a5e5", name: "Ares" }] }), { mode: 0o600 });
  mkdirSync(join(home, "klaud", "identities"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "klaud", "identities", "Ares.md"), "# Ares\n\nExisting identity.\n", { mode: 0o600 });
  const before = loadHarnessUnit("klaud-bot-a5e5a5e5", home);
  assert.match(before?.soul ?? "", /Existing identity/);
  saveHarnessUnit("klaud-bot-a5e5a5e5", {
    soul: "Field unit.",
    directive: "Stay local.",
    routines: [{ id: "r0", title: "Watch", when: "every 15m", loop: "watch", enabled: true, lastFire: 9 }],
  }, home);
  const loaded = loadHarnessUnit("klaud-bot-a5e5a5e5", home);
  assert.equal(loaded?.soul, "Field unit.");
  assert.equal(loaded?.directive, "Stay local.");
  const raw = readFileSync(join(home, "klaud", "identities", "Ares.md"), "utf8");
  assert.equal(raw.includes("Existing identity"), false);
  assert.match(raw, /# Soul/);
  assert.match(raw, /# Directive/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAcquireStartLock, releaseStartLock, withStartLock } from "../supervisor.mjs";

const fresh = () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rein-factory-lock-"));
  mkdirSync(stateDir, { recursive: true });
  return { stateDir };
};
const dead = () => {
  // A pid with no running process behind it (kill(0) reports ESRCH).
  for (;;) {
    const pid = 1 + Math.floor(Math.random() * 200000);
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return pid;
    }
  }
};

test("the start lock is exclusive while held and free after release", () => {
  const paths = fresh();
  try {
    assert.equal(tryAcquireStartLock(paths), true, "first acquire wins");
    assert.equal(tryAcquireStartLock(paths), false, "a second acquire loses while the lock is held");
    releaseStartLock(paths);
    assert.equal(tryAcquireStartLock(paths), true, "the lock is available again after release");
    releaseStartLock(paths);
  } finally {
    rmSync(paths.stateDir, { recursive: true, force: true });
  }
});

test("a stale start lock (dead holder) is taken over", () => {
  const paths = fresh();
  try {
    writeFileSync(join(paths.stateDir, "start.lock"), `${dead()}\n`);
    assert.equal(tryAcquireStartLock(paths), true, "a lock whose holder is gone is stolen");
    releaseStartLock(paths);
  } finally {
    rmSync(paths.stateDir, { recursive: true, force: true });
  }
});

test("withStartLock runs fn under the lock and releases it afterwards", async () => {
  const paths = fresh();
  try {
    let observed = "free";
    await withStartLock(paths, 1000, async () => { observed = tryAcquireStartLock(paths) ? "held by someone" : "held by me"; return 42; });
    assert.equal(observed, "held by me", "inside fn the lock must already be held");
    assert.equal(tryAcquireStartLock(paths), true, "after withStartLock the lock is released");
    releaseStartLock(paths);
  } finally {
    rmSync(paths.stateDir, { recursive: true, force: true });
  }
});

test("a concurrent waiter blocks until the holder releases, then proceeds", async () => {
  const paths = fresh();
  try {
    assert.equal(tryAcquireStartLock(paths), true);
    const result = withStartLock(paths, 2000, async () => "winner");
    // Hold briefly, then release from another tick so the waiter can proceed.
    setTimeout(() => releaseStartLock(paths), 100);
    assert.equal(await result, "winner", "the waiter acquires once the holder releases");
  } finally {
    rmSync(paths.stateDir, { recursive: true, force: true });
  }
});

test("withStartLock times out when the holder never releases", async () => {
  const paths = fresh();
  try {
    assert.equal(tryAcquireStartLock(paths), true);
    // timeoutMs=0 leaves only the fixed holder grace window, so this stays fast.
    await assert.rejects(async () => withStartLock(paths, 0, async () => "unreachable"), /Timed out waiting/);
  } finally {
    releaseStartLock(paths);
    rmSync(paths.stateDir, { recursive: true, force: true });
  }
});

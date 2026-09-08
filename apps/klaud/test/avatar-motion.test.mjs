import assert from "node:assert/strict";
import { test } from "node:test";
import { activeAvatarPhase, attachAvatarMotion, dampAvatarPose, poseForAvatar, seedForAvatar } from "../avatar-motion.mjs";

const phases = ["working", "thinking", "responding", "tool", "journaling", "autonomy"];
const neutral = poseForAvatar(0, "ready");

test("only actual work phases move; idle and attention states are exactly neutral", () => {
  for (const phase of ["ready", "approval", "error", "daemon", "unknown", undefined]) {
    assert.equal(activeAvatarPhase(phase), false);
    assert.deepEqual(poseForAvatar(47, phase, 198), neutral);
  }
  for (const phase of phases) assert.equal(activeAvatarPhase(phase), true);
});

test("procedural motion is deterministic, varies by bot, and has bounded continuous poses", () => {
  const maxima = { x: 1.75, y: 1.6, rotate: 2.2, glassesX: .35, glassesY: .42, glassesRotate: .49,
    leftBrowY: 1.5, rightBrowY: 1.5, leftBrowRotate: 1.95, rightBrowRotate: 1.95 };
  const a = seedForAvatar("fixture-bot-a"), b = seedForAvatar("fixture-bot-b");
  assert.equal(a, seedForAvatar("fixture-bot-a"));
  assert.notEqual(a, b);
  assert.notDeepEqual(poseForAvatar(3, "working", a), poseForAvatar(3, "working", b));
  for (const seed of [a, b, 0, 0xffffffff]) for (const phase of phases) {
    for (let t = 0; t < 180; t += .71) {
      const pose = poseForAvatar(t, phase, seed), next = poseForAvatar(t + .001, phase, seed);
      assert.deepEqual(pose, poseForAvatar(t, phase, seed));
      for (const [key, value] of Object.entries(pose)) {
        assert.ok(Number.isFinite(value));
        if (key.startsWith("scale")) assert.ok(Math.abs(value - 1) <= .0161);
        else assert.ok(Math.abs(value) <= maxima[key] + 1e-12, `${phase}.${key}=${value}`);
        assert.ok(Math.abs(next[key] - value) < .015, `${phase}.${key} jumps`);
      }
    }
    assert.notDeepEqual(poseForAvatar(2, phase, seed), poseForAvatar(4, phase, seed));
  }
  assert.equal(new Set(phases.map(phase => JSON.stringify(poseForAvatar(3, phase, a)))).size, phases.length);
  for (const seed of [null, undefined, "", "bot-🛠", "a".repeat(10000)]) {
    assert.ok(Number.isInteger(seedForAvatar(seed)) && seedForAvatar(seed) >= 0);
  }
  for (const value of Object.values(poseForAvatar(NaN, "working", Infinity))) assert.ok(Number.isFinite(value));
});

test("retarget damping is independent of frame rate and caps a suspended frame", () => {
  const target = poseForAvatar(4, "thinking", 123);
  const samples = [30, 60, 120].map(hz => {
    let pose = { ...neutral };
    for (let index = 0; index < hz; index++) pose = dampAvatarPose(pose, target, 1 / hz);
    return pose;
  });
  for (const key of Object.keys(neutral)) {
    assert.ok(Math.abs(samples[0][key] - samples[1][key]) < 1e-12);
    assert.ok(Math.abs(samples[1][key] - samples[2][key]) < 1e-12);
  }
  assert.deepEqual(dampAvatarPose(neutral, target, 900), dampAvatarPose(neutral, target, .05));
  assert.deepEqual(dampAvatarPose(neutral, target, -1), neutral);
  assert.deepEqual(dampAvatarPose(neutral, target, NaN), neutral);
});

test("desktop motion preserves the native iOS parity fixture", () => {
  assert.equal(seedForAvatar("fixture-bot-a"), 660881904);
  assert.equal(seedForAvatar("bot-🛠"), 2103122667);
  const expected = { x: -.023035306515658195, y: .2534011103606981, rotate: -.15155674721529355,
    scaleX: 1.004327619193378, scaleY: .9960594916351748,
    glassesX: -.03379755557078365, glassesY: .293456184243402, glassesRotate: -.22667809505364356,
    leftBrowY: .5240815296053523, leftBrowRotate: .1478176500877943,
    rightBrowY: .3341102131863983, rightBrowRotate: -1.8567687902311343 };
  const pose = poseForAvatar(3.25, "thinking", seedForAvatar("fixture-bot-a"));
  for (const key of Object.keys(expected)) assert.ok(Math.abs(pose[key] - expected[key]) < 1e-12, key);
});

function events(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name) { for (const fn of listeners.get(name) ?? []) fn(); },
    listenerCount() { return [...listeners.values()].reduce((count, set) => count + set.size, 0); },
  });
}

function environment() {
  const frames = new Map(), observers = [], media = events({ matches: false });
  let serial = 0;
  const view = {
    requestAnimationFrame(fn) { const id = ++serial; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    matchMedia() { return media; },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(svg) { this.svg = svg; }
      disconnect() { this.svg = null; }
      visibility(visible) { this.callback([{ target: this.svg, isIntersecting: visible }]); }
    },
  };
  const document = events({ hidden: false, defaultView: view });
  return { frames, observers, media, document,
    flush(now) { const current = [...frames.values()]; frames.clear(); for (const frame of current) frame(now); },
    svg() {
      const nodes = Object.fromEntries(["portrait", "glasses", "brow-left", "brow-right"].map(name => [`.bot-avatar-${name}`, { style: {} }]));
      const attributes = new Map();
      return { ownerDocument: document, nodes, attributes,
        querySelector(selector) { return nodes[selector] ?? null; },
        querySelectorAll(selector) { return nodes[selector] ? [nodes[selector]] : []; },
        setAttribute(name, value) { attributes.set(name, value); },
        removeAttribute(name) { attributes.delete(name); },
      };
    },
  };
}

test("driver never schedules idle thumbnails and cleans up all subscriptions", () => {
  const env = environment(), svg = env.svg(), driver = attachAvatarMotion(svg);
  env.observers[0].visibility(true);
  assert.equal(env.frames.size, 0);
  assert.equal(svg.attributes.has("data-animated"), false);
  driver.destroy(); driver.destroy();
  assert.equal(env.document.listenerCount(), 0);
  assert.equal(env.media.listenerCount(), 0);
  assert.equal(env.observers[0].svg, null);
  driver.update({ phase: "working" });
  assert.equal(env.frames.size, 0);
});

test("visible active avatars share a frame, retarget smoothly, then settle and stop", () => {
  const env = environment(), first = env.svg(), second = env.svg();
  const a = attachAvatarMotion(first, { phase: "working", seed: 123 });
  const b = attachAvatarMotion(second, { phase: "thinking", seed: 456 });
  assert.equal(env.frames.size, 0, "offscreen/unobserved work must not animate");
  env.observers.forEach(observer => observer.visibility(true));
  assert.equal(env.frames.size, 1);
  for (let index = 0; index < 60; index++) env.flush(index * 1000 / 60);
  const before = first.nodes[".bot-avatar-portrait"].style.transform;
  a.update({ phase: "responding" });
  assert.equal(first.nodes[".bot-avatar-portrait"].style.transform, before, "retarget must not snap to a new pose");
  b.destroy();
  assert.equal(env.frames.size, 1);
  a.update({ phase: "ready" });
  for (let index = 60; index < 180; index++) env.flush(index * 1000 / 60);
  assert.equal(env.frames.size, 0);
  assert.equal(first.attributes.has("data-animated"), false);
  assert.equal(first.nodes[".bot-avatar-portrait"].style.transform, "translate(0px, 0px) rotate(0deg) scale(1, 1)");
  a.destroy();
  assert.equal(env.document.listenerCount(), 0);
  assert.equal(env.media.listenerCount(), 0);
});

test("hidden/offscreen portraits suspend; reduced motion and explicit pause are static", () => {
  const env = environment(), svg = env.svg(), driver = attachAvatarMotion(svg, { phase: "tool", seed: 42 });
  env.observers[0].visibility(true);
  env.flush(0); env.flush(16); env.flush(32);
  const before = svg.nodes[".bot-avatar-portrait"].style.transform;
  env.document.hidden = true; env.document.emit("visibilitychange");
  assert.equal(env.frames.size, 0);
  env.document.hidden = false; env.document.emit("visibilitychange");
  env.flush(900000);
  assert.equal(svg.nodes[".bot-avatar-portrait"].style.transform, before, "returning from background cannot jump elapsed time");
  env.observers[0].visibility(false);
  assert.equal(env.frames.size, 0);
  env.observers[0].visibility(true);
  assert.equal(env.frames.size, 1);
  env.media.matches = true; env.media.emit("change");
  assert.equal(env.frames.size, 0);
  assert.equal(svg.nodes[".bot-avatar-portrait"].style.transform, "translate(0px, 0px) rotate(0deg) scale(1, 1)");
  env.media.matches = false; env.media.emit("change");
  assert.equal(env.frames.size, 1);
  driver.update({ paused: true });
  assert.equal(env.frames.size, 0);
  driver.update({ paused: false });
  assert.equal(env.frames.size, 1);
  driver.destroy();
  assert.equal(env.frames.size, 0);
});

test("reusing a portrait after controller teardown cannot retain a moved idle pose", () => {
  const env = environment(), svg = env.svg(), active = attachAvatarMotion(svg, { phase: "working", seed: 91 });
  env.observers[0].visibility(true);
  for (let index = 0; index < 60; index++) env.flush(index * 1000 / 60);
  assert.notEqual(svg.nodes[".bot-avatar-portrait"].style.transform, "translate(0px, 0px) rotate(0deg) scale(1, 1)");
  active.destroy();
  const idle = attachAvatarMotion(svg, { phase: "ready" });
  env.observers[1].visibility(true);
  assert.equal(svg.nodes[".bot-avatar-portrait"].style.transform, "translate(0px, 0px) rotate(0deg) scale(1, 1)");
  assert.equal(svg.nodes[".bot-avatar-brow-left"].style.transform, "translateY(0px) rotate(0deg)");
  assert.equal(svg.nodes[".bot-avatar-glasses"].style.transform, "translate(0px, 0px) rotate(0deg)");
  assert.equal(env.frames.size, 0);
  idle.destroy();
});

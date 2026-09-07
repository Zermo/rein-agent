import assert from "node:assert/strict";
import { test } from "node:test";
import { SOUND_CUES, SOUND_STORAGE_KEY, createSoundEngine, readSoundEnabled, writeSoundEnabled } from "../sounds.mjs";

class FakeParam {
  constructor() { this.value = 0; this.calls = []; }
  setValueAtTime(value, at) { this.value = value; this.calls.push(["set", value, at]); }
  linearRampToValueAtTime(value, at) { this.value = value; this.calls.push(["linear", value, at]); }
  exponentialRampToValueAtTime(value, at) { this.value = value; this.calls.push(["exponential", value, at]); }
}

class FakeNode {
  constructor() { this.connections = []; this.disconnected = false; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnected = true; }
}

class FakeSource extends FakeNode {
  constructor() { super(); this.started = []; this.stopped = []; this.onended = null; }
  start(at) { this.started.push(at); }
  stop(at) { this.stopped.push(at); }
  finish() { this.onended?.(); }
}

class FakeOscillator extends FakeSource {
  constructor() { super(); this.type = "sine"; this.frequency = new FakeParam(); }
}

class FakeGain extends FakeNode {
  constructor() { super(); this.gain = new FakeParam(); }
}

class FakeFilter extends FakeNode {
  constructor() { super(); this.type = "lowpass"; this.frequency = new FakeParam(); this.Q = new FakeParam(); }
}

class FakeDocument {
  constructor() { this.visibilityState = "visible"; this.listeners = new Map(); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
  setVisibility(value) { this.visibilityState = value; this.listeners.get("visibilitychange")?.(); }
}

function fakeAudioContext(initialState = "suspended") {
  const instances = [];
  class FakeAudioContext {
    constructor() {
      this.state = initialState; this.currentTime = 2; this.sampleRate = 48_000; this.destination = new FakeNode();
      this.sources = []; this.gains = []; this.filters = []; this.resumeCalls = 0; this.suspendCalls = 0; this.closeCalls = 0;
      instances.push(this);
    }
    createOscillator() { const node = new FakeOscillator(); this.sources.push(node); return node; }
    createGain() { const node = new FakeGain(); this.gains.push(node); return node; }
    createBuffer(_channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    createBufferSource() { const node = new FakeSource(); node.loop = false; this.sources.push(node); return node; }
    createBiquadFilter() { const node = new FakeFilter(); this.filters.push(node); return node; }
    async resume() { this.resumeCalls++; this.state = "running"; }
    async suspend() { this.suspendCalls++; this.state = "suspended"; }
    async close() { this.closeCalls++; this.state = "closed"; }
  }
  return { FakeAudioContext, instances };
}

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test("sound preference defaults on, persists, and tolerates unavailable storage", () => {
  const storage = fakeStorage();
  assert.equal(readSoundEnabled(storage), true);
  assert.equal(writeSoundEnabled(false, storage), true);
  assert.equal(storage.values.get(SOUND_STORAGE_KEY), "false");
  assert.equal(readSoundEnabled(storage), false);
  assert.equal(writeSoundEnabled(true, storage), true);
  assert.equal(readSoundEnabled(storage), true);
  storage.values.set(SOUND_STORAGE_KEY, "damaged");
  assert.equal(readSoundEnabled(storage), true);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(readSoundEnabled(blocked), true);
  assert.equal(writeSoundEnabled(false, blocked), false);
});

test("trusted interaction lazily creates and unlocks one AudioContext", async () => {
  const { FakeAudioContext, instances } = fakeAudioContext();
  const engine = createSoundEngine({ AudioContext: FakeAudioContext, document: new FakeDocument(), storage: fakeStorage(), now: () => 0 });
  assert.equal(engine.state, "idle");
  assert.equal(engine.play("click"), false);
  assert.equal(await engine.unlock({ isTrusted: false }), false);
  assert.equal(instances.length, 0);
  assert.equal(await engine.playFromEvent("click", { isTrusted: true }), true);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].resumeCalls, 1);
  assert.equal(engine.state, "running");
  assert.equal(await engine.unlock({ isTrusted: true }), true);
  assert.equal(instances.length, 1);
  await engine.destroy();
  assert.equal(instances[0].closeCalls, 1);
});

test("mute and page visibility stop voices and require another trusted resume", async () => {
  const storage = fakeStorage(), page = new FakeDocument();
  const { FakeAudioContext, instances } = fakeAudioContext();
  const engine = createSoundEngine({ AudioContext: FakeAudioContext, document: page, storage, now: () => 0 });
  assert.equal(await engine.unlock({ isTrusted: true }), true);
  assert.equal(engine.play("hover"), true);
  assert.equal(engine.activeVoices, 1);
  engine.setEnabled(false);
  await Promise.resolve();
  assert.equal(engine.enabled, false);
  assert.equal(storage.values.get(SOUND_STORAGE_KEY), "false");
  assert.equal(engine.activeVoices, 0);
  assert.equal(engine.play("key"), false);
  assert.equal(instances[0].state, "suspended");
  engine.setEnabled(true);
  assert.equal(engine.play("key"), false, "enabling does not bypass autoplay gating");
  assert.equal(await engine.unlock({ isTrusted: false }), false);
  assert.equal(await engine.unlock({ isTrusted: true }), true);
  assert.equal(engine.play("key"), true);
  page.setVisibility("hidden");
  await Promise.resolve();
  assert.equal(engine.activeVoices, 0);
  assert.equal(instances[0].state, "suspended");
  page.setVisibility("visible");
  assert.equal(engine.play("ready"), false, "becoming visible does not autoplay queued audio");
  assert.equal(await engine.unlock({ isTrusted: true }), true);
  await engine.destroy();
  assert.equal(page.listeners.size, 0);
});

test("cooldowns and the active voice cap prevent hover chatter and overlap", async () => {
  let clock = 0;
  const { FakeAudioContext, instances } = fakeAudioContext("running");
  const engine = createSoundEngine({ AudioContext: FakeAudioContext, document: new FakeDocument(), storage: fakeStorage(), maxVoices: 1, now: () => clock });
  assert.equal(await engine.unlock({ isTrusted: true }), true);
  assert.equal(engine.play("hover"), true);
  assert.equal(engine.play("send"), false, "a second cue cannot exceed the voice cap");
  instances[0].sources[0].finish();
  assert.equal(engine.activeVoices, 0, "the ended source releases its voice");
  clock = 69;
  assert.equal(engine.play("hover"), false);
  clock = 70;
  assert.equal(engine.play("hover"), true);
  instances[0].sources.at(-1).finish();
  clock = 71;
  assert.equal(engine.play("send"), true, "another cue may play after cleanup");
  await engine.destroy();
  assert.equal(engine.activeVoices, 0);
  assert.ok(instances[0].sources.every(node => node.disconnected));
});

test("every cue is a short low-gain oscillator graph with no looping samples", async () => {
  let clock = 0;
  const { FakeAudioContext, instances } = fakeAudioContext("running");
  const engine = createSoundEngine({ AudioContext: FakeAudioContext, document: new FakeDocument(), storage: fakeStorage(), now: () => clock, random: () => 0.5 });
  await engine.unlock({ isTrusted: true });
  const context = instances[0];
  for (const name of SOUND_CUES) {
    const firstSource = context.sources.length;
    assert.equal(engine.play(name), true, `${name} should schedule a cue`);
    const added = context.sources.slice(firstSource);
    assert.ok(added.length > 0);
    assert.ok(added.every(source => source.loop !== true));
    for (const source of added) source.finish();
    clock += 1000;
  }
  assert.ok(context.sources.filter(node => node instanceof FakeOscillator).every(node => ["sine", "triangle"].includes(node.type)));
  const envelopes = context.gains.slice(1).flatMap(node => node.gain.calls.filter(([kind]) => kind === "linear").map(([, value]) => value));
  assert.ok(envelopes.length > 0 && Math.max(...envelopes) <= 0.02);
  await engine.destroy();
});

test("missing or failing audio support degrades to silence", async () => {
  const noAudio = createSoundEngine({ AudioContext: undefined, document: new FakeDocument(), storage: fakeStorage() });
  assert.equal(await noAudio.playFromEvent("click", { isTrusted: true }), false);
  class BrokenAudioContext { constructor() { throw new Error("device unavailable"); } }
  const broken = createSoundEngine({ AudioContext: BrokenAudioContext, document: new FakeDocument(), storage: fakeStorage() });
  assert.equal(await broken.unlock({ isTrusted: true }), false);
  assert.equal(broken.play("not-a-cue"), false);
});

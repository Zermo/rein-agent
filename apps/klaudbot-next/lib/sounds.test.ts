import assert from "node:assert/strict";
import test from "node:test";
import { createSoundEngine, readSoundEnabled, writeSoundEnabled, SOUND_CUES, SOUND_STORAGE_KEY, type SoundDocument, type SoundEngineOptions, type SoundStorage } from "../lib/sounds.ts";

function audioFixture(maxVoices = 6) {
  const events: unknown[][] = [];
  const listeners = new Set<() => void>();
  const sources: FakeSource[] = [];
  const contexts: FakeContext[] = [];
  const stored = new Map<string, string>();
  let stamp = 1000;
  class FakeParam {
    value = 0;
    setValueAtTime(value: number, at: number) { this.value = value; events.push(["set", value, at]); }
    linearRampToValueAtTime(value: number, at: number) { this.value = value; events.push(["linear", value, at]); }
    exponentialRampToValueAtTime(value: number, at: number) { this.value = value; events.push(["exponential", value, at]); }
  }
  class FakeNode {
    connect() { events.push(["connect"]); }
    disconnect() { events.push(["disconnect"]); }
  }
  class FakeSource extends FakeNode {
    onended: (() => void) | null = null;
    type = "sine";
    frequency = new FakeParam();
    buffer: unknown = null;
    start(at: number) { events.push(["start", at, this.type]); }
    stop(at?: number) { events.push(["stop", at]); }
  }
  class FakeContext {
    state: AudioContextState = "suspended";
    currentTime = 0;
    sampleRate = 48000;
    destination = new FakeNode();
    constructor() { contexts.push(this); events.push(["context"]); }
    createGain() { return Object.assign(new FakeNode(), { gain: new FakeParam() }); }
    createOscillator() { const node = new FakeSource(); sources.push(node); return node; }
    createBuffer(_channels: number, length: number) { return { getChannelData() { return new Float32Array(length); } }; }
    createBufferSource() { const node = new FakeSource(); sources.push(node); return node; }
    createBiquadFilter() { return Object.assign(new FakeNode(), { type: "bandpass", frequency: new FakeParam(), Q: new FakeParam() }); }
    async resume() { this.state = "running"; events.push(["resume"]); }
    async suspend() { this.state = "suspended"; events.push(["suspend"]); }
    async close() { this.state = "closed"; events.push(["close"]); }
  }
  const page = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener(_name: string, listener: () => void) { listeners.add(listener); },
    removeEventListener(_name: string, listener: () => void) { listeners.delete(listener); },
  };
  const storage: SoundStorage = {
    getItem(key) { return stored.get(key) ?? null; },
    setItem(key, value) { stored.set(key, value); },
  };
  const options: SoundEngineOptions = {
    enabled: true, maxVoices, storage,
    document: page as unknown as SoundDocument,
    AudioContext: FakeContext as unknown as typeof AudioContext,
    now: () => stamp,
    random: () => .5,
  };
  return {
    options, contexts, events, listeners, stored, sources,
    advance(ms = 1000) { stamp += ms; },
    endAll() { for (const source of sources) source.onended?.(); },
    hide(hidden: boolean) { page.visibilityState = hidden ? "hidden" : "visible"; for (const listener of listeners) listener(); },
  };
}

test("sound preferences keep original key/default and tolerate unavailable storage", () => {
  assert.equal(SOUND_STORAGE_KEY, "rein-klaud:sound-effects:v1");
  assert.deepEqual(SOUND_CUES, ["hover", "click", "key", "send", "tool", "reply", "error", "ready", "approval", "present"]);
  assert.equal(readSoundEnabled(null), true);
  assert.equal(writeSoundEnabled(false, null), false);
  const denied: SoundStorage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(readSoundEnabled(denied), true);
  assert.equal(writeSoundEnabled(false, denied), false);
  const fixture = audioFixture();
  assert.equal(writeSoundEnabled(false, fixture.options.storage), true);
  assert.equal(readSoundEnabled(fixture.options.storage), false);
  assert.equal(writeSoundEnabled(true, fixture.options.storage), true);
  assert.equal(readSoundEnabled(fixture.options.storage), true);
});

test("quiet engine only constructs on trusted visible enabled unlock; sends original envelopes", async () => {
  const fixture = audioFixture(), engine = createSoundEngine(fixture.options);
  assert.ok(Object.isFrozen(engine));
  assert.equal(engine.state, "idle");
  assert.equal(engine.play("ready"), false);
  assert.equal(await engine.unlock(), false);
  assert.equal(await engine.unlock({ isTrusted: false }), false);
  assert.equal(fixture.contexts.length, 0);
  fixture.hide(true);
  assert.equal(await engine.unlock({ isTrusted: true }), false);
  fixture.hide(false);
  engine.setEnabled(false);
  assert.equal(await engine.unlock({ isTrusted: true }), false);
  assert.equal(fixture.contexts.length, 0);
  engine.setEnabled(true);
  assert.equal(await engine.unlock({ isTrusted: true }), true);
  assert.equal(engine.state, "running");
  assert.equal(fixture.contexts.length, 1);
  assert.ok(fixture.events.some(event => event[0] === "set" && event[1] === .72), "original quiet master level");
  fixture.events.length = 0;
  assert.equal(engine.play("hover"), true);
  assert.equal(engine.activeVoices, 1);
  assert.deepEqual(fixture.events.filter(event => event[0] === "start"), [["start", .003, "sine"]]);
  assert.deepEqual(fixture.events.filter(event => ["set", "linear", "exponential"].includes(String(event[0]))), [
    ["set", 1380, .003], ["exponential", 1120, .020999999999999998], ["set", .0001, .003],
    ["linear", .0045, .009], ["exponential", .0001, .020999999999999998],
  ]);
  fixture.endAll();
  assert.equal(engine.activeVoices, 0);
  await engine.destroy();
});

test("all cues preserve source cooldowns, release voices, and never exceed voice cap", async () => {
  const fixture = audioFixture(), engine = createSoundEngine(fixture.options);
  await engine.unlock({ isTrusted: true });
  const cooldowns = { hover: 70, click: 45, key: 28, send: 140, tool: 260, reply: 220, error: 500, ready: 400, approval: 420, present: 280 };
  for (const cue of SOUND_CUES) {
    assert.equal(engine.play(cue), true, cue);
    fixture.endAll();
    assert.equal(engine.activeVoices, 0);
    fixture.advance(cooldowns[cue] - 1);
    assert.equal(engine.play(cue), false, `${cue} cooldown`);
    fixture.advance(1);
    assert.equal(engine.play(cue), true, `${cue} cooldown elapsed`);
    fixture.endAll(); fixture.advance();
  }
  for (let i = 0; i < 6; i++) { fixture.advance(); assert.equal(engine.play("tool"), true); }
  assert.equal(engine.activeVoices, 6);
  fixture.advance(); assert.equal(engine.play("ready"), false);
  fixture.endAll(); assert.equal(engine.activeVoices, 0);
  assert.equal(engine.play("ready"), true);
  await engine.destroy();
  assert.equal(engine.activeVoices, 0);
});

test("disable/hidden/destroy suspend and release; unavailable Web Audio fails quietly", async () => {
  const fixture = audioFixture(), engine = createSoundEngine(fixture.options);
  assert.equal(await engine.playFromEvent("ready", { isTrusted: false }), false);
  assert.equal(await engine.playFromEvent("ready", { isTrusted: true }), true);
  assert.equal(engine.setEnabled(false), false);
  assert.equal(engine.activeVoices, 0);
  assert.equal(engine.state, "suspended");
  assert.equal(fixture.stored.get(SOUND_STORAGE_KEY), "false");
  assert.equal(engine.play("reply"), false);
  assert.equal(engine.setEnabled(true), true);
  assert.equal(await engine.playFromEvent("reply", { isTrusted: true }), true);
  fixture.hide(true);
  assert.equal(engine.activeVoices, 0);
  assert.equal(engine.state, "suspended");
  assert.equal(await engine.unlock({ isTrusted: true }), false);
  fixture.hide(false);
  assert.equal(await engine.unlock({ isTrusted: true }), true);
  await engine.destroy(); await engine.destroy();
  assert.equal(engine.state, "idle");
  assert.equal(fixture.listeners.size, 0);
  assert.equal(fixture.contexts[0].state, "closed");
  assert.equal(await engine.unlock({ isTrusted: true }), false);
  assert.equal(engine.play("error"), false);
  const unsupported = createSoundEngine({ enabled: true, AudioContext: null, storage: null, document: null });
  assert.equal(await unsupported.playFromEvent("ready", { isTrusted: true }), false);
  await unsupported.destroy();
});
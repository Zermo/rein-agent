export const SOUND_STORAGE_KEY = "rein-klaud:sound-effects:v1";
export const SOUND_CUES = Object.freeze(["hover", "click", "key", "send", "tool", "reply", "error", "ready"]);

const SILENCE = 0.0001;
const MASTER_LEVEL = 0.72;

const tone = (wave, from, to, delay, duration, gain) => ({ wave, from, to, delay, duration, gain });
const cues = Object.freeze({
  hover: { cooldown: 70, tones: [tone("sine", 1380, 1120, 0, 0.018, 0.0045)] },
  click: { cooldown: 45, tones: [tone("triangle", 220, 145, 0, 0.028, 0.010)], noise: { duration: 0.012, gain: 0.004, frequency: 1700, q: 0.8 } },
  key: { cooldown: 28, tones: [tone("triangle", 185, 132, 0, 0.019, 0.007)], noise: { duration: 0.009, gain: 0.0035, frequency: 2100, q: 0.9 } },
  send: { cooldown: 140, tones: [tone("triangle", 480, 525, 0, 0.045, 0.011), tone("sine", 640, 690, 0.038, 0.055, 0.009)] },
  tool: { cooldown: 260, tones: [tone("triangle", 340, 430, 0, 0.035, 0.007), tone("sine", 510, 560, 0.027, 0.040, 0.006)] },
  reply: { cooldown: 300, tones: [tone("sine", 660, 680, 0, 0.060, 0.010), tone("sine", 880, 910, 0.052, 0.070, 0.011)] },
  error: { cooldown: 500, tones: [tone("triangle", 135, 105, 0, 0.080, 0.013), tone("triangle", 105, 82, 0.065, 0.075, 0.011)] },
  ready: { cooldown: 400, tones: [tone("sine", 520, 565, 0, 0.050, 0.008), tone("sine", 780, 830, 0.045, 0.070, 0.009)] },
});

function defaultStorage() {
  try { return globalThis.localStorage; }
  catch { return undefined; }
}

export function readSoundEnabled(storage = defaultStorage()) {
  try { return storage?.getItem(SOUND_STORAGE_KEY) !== "false"; }
  catch { return true; }
}

export function writeSoundEnabled(enabled, storage = defaultStorage()) {
  try {
    if (!storage?.setItem) return false;
    storage.setItem(SOUND_STORAGE_KEY, enabled ? "true" : "false");
    return true;
  } catch { return false; }
}

function defaultNow() {
  try { return globalThis.performance?.now?.() ?? Date.now(); }
  catch { return Date.now(); }
}

function contextConstructor(options) {
  if (Object.hasOwn(options, "AudioContext")) return options.AudioContext;
  try { return globalThis.AudioContext ?? globalThis.webkitAudioContext; }
  catch { return undefined; }
}

function visible(page) {
  try { return page?.visibilityState !== "hidden"; }
  catch { return true; }
}

function setValue(param, value, at) {
  if (typeof param?.setValueAtTime === "function") param.setValueAtTime(value, at);
  else if (param) param.value = value;
}

function ramp(param, method, value, at) {
  if (typeof param?.[method] === "function") param[method](value, at);
  else setValue(param, value, at);
}

/**
 * Create a small synthesized interaction-audio engine. It never constructs an
 * AudioContext until unlock receives a trusted browser event.
 */
export function createSoundEngine(options = {}) {
  const storage = Object.hasOwn(options, "storage") ? options.storage : defaultStorage();
  const page = Object.hasOwn(options, "document") ? options.document : globalThis.document;
  const AudioContextClass = contextConstructor(options);
  const now = typeof options.now === "function" ? options.now : defaultNow;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const maxVoices = Number.isInteger(options.maxVoices) && options.maxVoices > 0 ? Math.min(options.maxVoices, 16) : 6;
  let enabled = Object.hasOwn(options, "enabled") ? options.enabled !== false : readSoundEnabled(storage);
  let context;
  let master;
  let destroyed = false;
  const voices = new Set();
  const lastPlayed = new Map();

  function setMaster(value) {
    if (!master || !context) return;
    try { setValue(master.gain, value, context.currentTime); }
    catch {}
  }

  function releaseRecord(voice, record, stop) {
    if (record.done) return;
    record.done = true;
    if (stop) {
      try { record.source.stop(); }
      catch {}
    }
    for (const node of record.nodes) {
      try { node.disconnect(); }
      catch {}
    }
    voice.remaining = Math.max(0, voice.remaining - 1);
    if (!voice.building && voice.remaining === 0) voices.delete(voice);
  }

  function releaseVoice(voice) {
    if (voice.released) return;
    voice.released = true;
    voices.delete(voice);
    for (const record of voice.records) releaseRecord(voice, record, true);
  }

  function track(voice, source, nodes, start, stop) {
    const record = { source, nodes, done: false };
    voice.records.push(record);
    voice.remaining++;
    source.onended = () => releaseRecord(voice, record, false);
    try { source.start(start); source.stop(stop); }
    catch (error) { releaseRecord(voice, record, true); throw error; }
  }

  function scheduleTone(voice, value, base) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = base + value.delay, end = start + value.duration;
    oscillator.type = value.wave;
    setValue(oscillator.frequency, value.from, start);
    ramp(oscillator.frequency, "exponentialRampToValueAtTime", value.to, end);
    setValue(gain.gain, SILENCE, start);
    ramp(gain.gain, "linearRampToValueAtTime", value.gain, start + Math.min(0.006, value.duration / 3));
    ramp(gain.gain, "exponentialRampToValueAtTime", SILENCE, end);
    oscillator.connect(gain);
    gain.connect(master);
    track(voice, oscillator, [oscillator, gain], start, end + 0.005);
  }

  function scheduleNoise(voice, value, base) {
    if (!context.createBuffer || !context.createBufferSource) return;
    const length = Math.max(1, Math.floor(context.sampleRate * value.duration));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index++) samples[index] = random() * 2 - 1;
    const source = context.createBufferSource(), gain = context.createGain();
    const filter = typeof context.createBiquadFilter === "function" ? context.createBiquadFilter() : undefined;
    const start = base, end = start + value.duration;
    source.buffer = buffer;
    setValue(gain.gain, SILENCE, start);
    ramp(gain.gain, "linearRampToValueAtTime", value.gain, start + Math.min(0.003, value.duration / 3));
    ramp(gain.gain, "exponentialRampToValueAtTime", SILENCE, end);
    if (filter) {
      filter.type = "bandpass";
      setValue(filter.frequency, value.frequency, start);
      setValue(filter.Q, value.q, start);
      source.connect(filter); filter.connect(gain);
    } else source.connect(gain);
    gain.connect(master);
    track(voice, source, [source, ...(filter ? [filter] : []), gain], start, end + 0.003);
  }

  function clearVoices() {
    for (const voice of [...voices]) releaseVoice(voice);
  }

  async function suspend() {
    clearVoices();
    if (!context || context.state !== "running") return false;
    try { await context.suspend(); return context.state !== "running"; }
    catch { return false; }
  }

  async function unlock(event) {
    if (destroyed || !enabled || event?.isTrusted !== true || !visible(page) || typeof AudioContextClass !== "function") return false;
    try {
      if (context?.state === "closed") { context = undefined; master = undefined; }
      if (!context) {
        context = new AudioContextClass();
        master = context.createGain();
        setMaster(MASTER_LEVEL);
        master.connect(context.destination);
      }
      if (context.state !== "running") await context.resume();
      if (context.state !== "running") return false;
      setMaster(MASTER_LEVEL);
      return true;
    } catch {
      try { await context?.close?.(); }
      catch {}
      context = undefined; master = undefined;
      return false;
    }
  }

  function play(name) {
    const definition = cues[name];
    if (destroyed || !enabled || !definition || !context || context.state !== "running" || !master || !visible(page) || voices.size >= maxVoices) return false;
    let stamp;
    try { stamp = Number(now()); }
    catch { return false; }
    if (!Number.isFinite(stamp)) return false;
    const previous = lastPlayed.get(name);
    if (previous !== undefined && stamp - previous < definition.cooldown) return false;
    const voice = { records: [], remaining: 0, building: true, released: false };
    voices.add(voice);
    try {
      const base = context.currentTime + 0.003;
      for (const value of definition.tones) scheduleTone(voice, value, base);
      if (definition.noise) {
        try { scheduleNoise(voice, definition.noise, base); }
        catch {}
      }
      voice.building = false;
      if (voice.remaining === 0) { voices.delete(voice); return false; }
      lastPlayed.set(name, stamp);
      return true;
    } catch {
      voice.building = false;
      releaseVoice(voice);
      return false;
    }
  }

  async function playFromEvent(name, event) {
    if (!(await unlock(event))) return false;
    return play(name);
  }

  function setEnabled(value, persist = true) {
    enabled = value === true;
    if (persist) writeSoundEnabled(enabled, storage);
    if (enabled) setMaster(MASTER_LEVEL);
    else { setMaster(0); void suspend(); }
    return enabled;
  }

  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    try { page?.removeEventListener?.("visibilitychange", onVisibilityChange); }
    catch {}
    clearVoices();
    const closing = context;
    context = undefined; master = undefined;
    try { await closing?.close?.(); }
    catch {}
  }

  function onVisibilityChange() { if (!visible(page)) void suspend(); }
  try { page?.addEventListener?.("visibilitychange", onVisibilityChange); }
  catch {}

  return Object.freeze({
    get enabled() { return enabled; },
    get state() { return context?.state ?? "idle"; },
    get activeVoices() { return voices.size; },
    setEnabled,
    unlock,
    play,
    playFromEvent,
    suspend,
    destroy,
  });
}

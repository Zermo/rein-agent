import { readSoundEnabled } from "./sounds";

export type KeyFeelKind = "letter" | "space" | "delete" | "return" | "send";

type KlaudBridge = {
  inApp?: boolean;
  feel?: (kind: string) => void;
  dictate?: (action: string) => void;
  onDictate?: (text: string, done: boolean, error?: string | null) => void;
};

function klaudNative(): KlaudBridge {
  const w = window as Window & { klaudNative?: KlaudBridge };
  w.klaudNative = w.klaudNative ?? {};
  return w.klaudNative;
}

function handler(): { postMessage: (body: Record<string, string>) => void } | undefined {
  return (window as Window & { webkit?: { messageHandlers?: { klaud?: { postMessage: (body: Record<string, string>) => void } } } }).webkit?.messageHandlers?.klaud;
}

let ctx: AudioContext | null = null;
let bus: GainNode | null = null;
let noise: AudioBuffer | null = null;
let watching = false;

function watchPage() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  const wake = () => { if (ctx && ctx.state === "suspended") void ctx.resume(); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wake(); });
  window.addEventListener("pageshow", wake);
  window.addEventListener("focus", wake);
}

function audio(): AudioContext | null {
  const C = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C) return null;
  watchPage();
  if (!ctx || ctx.state === "closed") {
    ctx = new C();
    bus = null;
    noise = null;
  }
  if (ctx.state === "suspended") void ctx.resume();
  if (!bus || bus.context !== ctx) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.08;
    bus = ctx.createGain();
    bus.gain.value = 1.45;
    bus.connect(comp);
    comp.connect(ctx.destination);
  }
  if (!noise || noise.sampleRate !== ctx.sampleRate) {
    const n = Math.max(1, Math.floor(ctx.sampleRate * 0.04));
    noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = noise.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < n; i++) {
      brown = (brown + (Math.random() * 2 - 1) * 0.02) / 1.02;
      data[i] = brown * Math.exp(-i / (ctx.sampleRate * 0.014));
    }
  }
  return ctx;
}

const VOICE: Record<KeyFeelKind, { noise: number; hz: number; q: number; gain: number; thud: number; thudGain: number; thudMs: number; rattle?: boolean; tick?: boolean }> = {
  letter: { noise: 0.02, hz: 980, q: 0.8, gain: 0.55, thud: 205, thudGain: 0.28, thudMs: 0.032 },
  space: { noise: 0.038, hz: 560, q: 0.6, gain: 0.62, thud: 118, thudGain: 0.4, thudMs: 0.052, rattle: true },
  delete: { noise: 0.014, hz: 1380, q: 1, gain: 0.48, thud: 255, thudGain: 0.16, thudMs: 0.018 },
  return: { noise: 0.03, hz: 720, q: 0.7, gain: 0.58, thud: 145, thudGain: 0.34, thudMs: 0.044 },
  send: { noise: 0.026, hz: 800, q: 0.75, gain: 0.56, thud: 160, thudGain: 0.32, thudMs: 0.04, tick: true },
};

function clack(ac: AudioContext, t: number, voice: (typeof VOICE)[KeyFeelKind], delay: number, gainScale: number) {
  if (!bus || !noise) return;
  const src = ac.createBufferSource();
  src.buffer = noise;
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = voice.hz;
  lp.Q.value = voice.q;
  const g = ac.createGain();
  const at = t + delay;
  g.gain.setValueAtTime(Math.max(0.0008, voice.gain * gainScale), at);
  g.gain.exponentialRampToValueAtTime(0.0008, at + voice.noise);
  src.connect(lp);
  lp.connect(g);
  g.connect(bus);
  src.start(at);
  src.stop(at + voice.noise + 0.01);
  const osc = ac.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(voice.thud, at);
  osc.frequency.exponentialRampToValueAtTime(Math.max(70, voice.thud * 0.62), at + voice.thudMs);
  const og = ac.createGain();
  og.gain.setValueAtTime(Math.max(0.0008, voice.thudGain * gainScale), at);
  og.gain.exponentialRampToValueAtTime(0.0008, at + voice.thudMs);
  osc.connect(og);
  og.connect(bus);
  osc.start(at);
  osc.stop(at + voice.thudMs + 0.01);
}

/** 1979 Apple-style plastic clack + bottom-out thud. Not a synth chirp. */
export function playVintageKey(kind: KeyFeelKind = "letter", event?: { isTrusted?: boolean }) {
  if (event && event.isTrusted === false) return;
  if (!readSoundEnabled()) return;
  const ac = audio();
  if (!ac) return;
  const voice = VOICE[kind] ?? VOICE.letter;
  const t = ac.currentTime;
  clack(ac, t, voice, 0, 1);
  if (voice.rattle) clack(ac, t, voice, 0.014, 0.45);
  if (voice.tick) {
    const osc = ac.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 980;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.12, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.038);
    osc.connect(g);
    g.connect(bus ?? ac.destination);
    osc.start(t + 0.02);
    osc.stop(t + 0.04);
  }
}

export function playPorcelainKey(event?: { isTrusted?: boolean }) {
  playVintageKey("letter", event);
}

export function playKeyHaptic(kind: KeyFeelKind = "letter") {
  const native = klaudNative();
  try {
    if (typeof native.feel === "function") native.feel(kind);
    else handler()?.postMessage({ kind: "haptic", key: kind });
  } catch { /* desktop */ }
}

export function startDictate(onText: (text: string, done: boolean, error?: string | null) => void): () => void {
  const native = klaudNative();
  native.onDictate = onText;
  if (native.inApp) {
    try {
      if (typeof native.dictate === "function") native.dictate("start");
      else handler()?.postMessage({ kind: "dictate", action: "start" });
    } catch { onText("", true, "unavailable"); }
    return () => {
      try {
        if (typeof native.dictate === "function") native.dictate("stop");
        else handler()?.postMessage({ kind: "dictate", action: "stop" });
      } catch { /* ignore */ }
    };
  }
  const Rec = (window as Window & { SpeechRecognition?: new () => SpeechRecognition; webkitSpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition
    ?? (window as Window & { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition;
  if (!Rec) {
    onText("", true, "unavailable");
    return () => undefined;
  }
  const rec = new Rec();
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = event => {
    const bit = event.results[event.results.length - 1];
    onText(bit?.[0]?.transcript ?? "", Boolean(bit?.isFinal));
  };
  rec.onerror = () => onText("", true, "error");
  rec.onend = () => onText("", true, null);
  rec.start();
  return () => { try { rec.stop(); } catch { /* ignore */ } };
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0?: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

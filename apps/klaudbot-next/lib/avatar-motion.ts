// Distances are 128px viewBox units. Angles are degrees. Time is elapsed seconds.
const PHASES = Object.freeze({
  // speed, sway, bob, tilt, squash, brow, secondary — task motion only, never idle dance
  working: [.55, .32, .38, .85, .006, 1.6, .22],
  thinking: [.42, .22, .28, 1.15, .004, 2.0, .18],
  responding: [.62, .38, .42, .7, .008, 1.2, .28],
  presenting: [.48, .3, .34, .9, .006, 1.3, .24],
  tool: [.7, .28, .46, .55, .007, 1.35, .3],
  journaling: [.4, .24, .3, .75, .005, 1.4, .2],
  autonomy: [.38, .26, .32, 1.05, .005, 1.7, .2],
} as const);
const NEUTRAL = Object.freeze({ x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1,
  glassesX: 0, glassesY: 0, glassesRotate: 0,
  leftBrowY: 0, leftBrowRotate: 0, rightBrowY: 0, rightBrowRotate: 0 });
export type AvatarPose = { -readonly [Key in keyof typeof NEUTRAL]: number };
export type ActiveAvatarPhase = keyof typeof PHASES;
export interface AvatarMotionOptions {
  phase: string;
  seed: number;
  paused: boolean;
}
export interface AvatarMotionController {
  update(next: Partial<AvatarMotionOptions>): void;
  destroy(): void;
}

const KEYS = Object.keys(NEUTRAL) as (keyof AvatarPose)[];
const CADENCE = 1.55;

export function seedForAvatar(id?: unknown): number {
  let hash = 2166136261;
  for (const code of String(id ?? "").slice(0, 4096)) hash = Math.imul(hash ^ code.codePointAt(0)!, 16777619);
  return hash >>> 0;
}

export function activeAvatarPhase(phase: string): phase is ActiveAvatarPhase { return Object.hasOwn(PHASES, phase); }

export function motionPhaseFor(phase: string): ActiveAvatarPhase | "still" {
  if (activeAvatarPhase(phase)) return phase;
  if (phase === "error") return "tool";
  if (phase === "approval") return "thinking";
  return "still";
}

export function poseForAvatar(timeSeconds: number, phase: string, seedNumber = 0): AvatarPose {
  const kind = motionPhaseFor(phase);
  if (kind === "still") return { ...NEUTRAL };
  const [speed, sway, bob, tilt, squash, brow, secondary] = PHASES[kind];
  const v = (seedNumber >>> 0) / 4294967296, p = v * Math.PI * 2;
  const u = (Number.isFinite(timeSeconds) ? timeSeconds : 0) * CADENCE * speed * (.94 + .12 * v);
  const sin = Math.sin, breath = sin(u * 1.67 + p);
  return {
    x: sway * (.72 * sin(u * 1.37 + p) + .28 * sin(u * .53 + p * 1.7)),
    y: bob * (.70 * sin(u * 1.91 + p * .83) + .30 * sin(u * .71 + p)),
    rotate: tilt * (.78 * sin(u * 1.13 + p + .45) + .22 * sin(u * .43 + p * .6)),
    scaleX: 1 + squash * (.7 * breath + .3 * sin(u * .67 + p)),
    scaleY: 1 - squash * (.6 * breath + .2 * sin(u * .67 + p)),
    glassesX: secondary * .5 * sin(u * 1.37 + p - .35),
    glassesY: secondary * .6 * sin(u * 1.91 + p * .83 - .45),
    glassesRotate: secondary * .7 * sin(u * 1.13 + p + .05),
    leftBrowY: -brow * (.55 * sin(u * 1.1 + p) + .45),
    leftBrowRotate: brow * .55,
    rightBrowY: -brow * (.5 * sin(u * 1.1 + p + .4) + .5),
    rightBrowRotate: -brow * .55,
  };
}

export function dampAvatarPose(current: AvatarPose, target: AvatarPose, deltaSeconds: number): AvatarPose {
  const dt = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(.05, deltaSeconds)) : 0;
  const weight = -Math.expm1(-12 * dt);
  return Object.fromEntries(KEYS.map(key => [key, current[key] + (target[key] - current[key]) * weight])) as AvatarPose;
}

const neutralPose = (pose: AvatarPose) => KEYS.every(key => Math.abs(pose[key] - NEUTRAL[key]) < .001);
type FrameCallback = (now: number) => boolean;
interface FrameScheduler {
  add(callback: FrameCallback): void;
  remove(callback: FrameCallback): void;
}
const schedulers = new WeakMap<Window, FrameScheduler>();

function schedulerFor(view: Window): FrameScheduler {
  const existing = schedulers.get(view);
  if (existing) return existing;
  const callbacks = new Set<FrameCallback>();
  let frame: number | null = null;
  const tick = (now: number) => {
    frame = null;
    for (const callback of [...callbacks]) if (callbacks.has(callback) && callback(now) === false) callbacks.delete(callback);
    if (callbacks.size && frame === null) frame = view.requestAnimationFrame(tick);
  };
  const scheduler: FrameScheduler = {
    add(callback) {
      callbacks.add(callback);
      if (frame === null) frame = view.requestAnimationFrame(tick);
    },
    remove(callback) {
      callbacks.delete(callback);
      if (!callbacks.size && frame !== null) { view.cancelAnimationFrame(frame); frame = null; }
    },
  };
  schedulers.set(view, scheduler);
  return scheduler;
}

export function attachAvatarMotion(svg: SVGSVGElement, initial: Partial<AvatarMotionOptions> = {}): AvatarMotionController {
  const document = svg.ownerDocument, view = document.defaultView;
  if (!view) return { update() {}, destroy() {} };
  const scheduler = schedulerFor(view);
  const portrait = svg.querySelector<SVGGElement>(".bot-avatar-portrait");
  const glasses = [...svg.querySelectorAll<SVGGElement>(".bot-avatar-glasses")];
  const left = svg.querySelector<SVGGElement>(".bot-avatar-brow-left"), right = svg.querySelector<SVGGElement>(".bot-avatar-brow-right");
  let settings = { phase: "ready", seed: 0, paused: false, ...initial };
  let current: AvatarPose = { ...NEUTRAL }, elapsed = 0, previous: number | null = null, destroyed = false;
  let visible = !view.IntersectionObserver;
  const media = view.matchMedia?.("(prefers-reduced-motion: reduce)");
  const write = (pose: AvatarPose) => {
    if (portrait) portrait.style.transform = `translate(${pose.x}px, ${pose.y}px) rotate(${pose.rotate}deg) scale(${pose.scaleX}, ${pose.scaleY})`;
    for (const node of glasses) node.style.transform = `translate(${pose.glassesX}px, ${pose.glassesY}px) rotate(${pose.glassesRotate}deg)`;
    if (left) left.style.transform = `translateY(${pose.leftBrowY}px) rotate(${pose.leftBrowRotate}deg)`;
    if (right) right.style.transform = `translateY(${pose.rightBrowY}px) rotate(${pose.rightBrowRotate}deg)`;
  };
  const stop = () => {
    scheduler.remove(tick);
    previous = null;
    svg.removeAttribute("data-animated");
  };
  const tick = (now: number) => {
    const dt = previous === null ? 0 : Math.max(0, Math.min(.05, (now - previous) / 1000));
    previous = now;
    elapsed += dt;
    const active = motionPhaseFor(settings.phase) !== "still";
    current = dampAvatarPose(current, poseForAvatar(elapsed, settings.phase, settings.seed), dt);
    if (!active && neutralPose(current)) { current = { ...NEUTRAL }; write(current); stop(); return false; }
    write(current);
    return true;
  };
  const refresh = () => {
    if (destroyed) return;
    if (settings.paused || media?.matches) { stop(); current = { ...NEUTRAL }; write(current); return; }
    if (!visible || document.hidden) { stop(); return; }
    if (motionPhaseFor(settings.phase) !== "still" || !neutralPose(current)) {
      svg.setAttribute("data-animated", "true");
      scheduler.add(tick);
    } else stop();
  };
  const observer = view.IntersectionObserver ? new view.IntersectionObserver(entries => {
    visible = entries.some(entry => entry.target === svg && entry.isIntersecting);
    refresh();
  }, { threshold: 0 }) : null;
  write(current);
  observer?.observe(svg);
  media?.addEventListener?.("change", refresh);
  document.addEventListener("visibilitychange", refresh);
  refresh();
  return {
    update(next) { if (!destroyed) { settings = { ...settings, ...next }; refresh(); } },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      write(NEUTRAL);
      observer?.disconnect();
      media?.removeEventListener?.("change", refresh);
      document.removeEventListener("visibilitychange", refresh);
    },
  };
}

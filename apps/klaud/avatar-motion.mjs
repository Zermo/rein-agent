// Shared by the desktop portraits and the interactive preview. All distances are
// in the original 128px viewBox; angles are degrees and time is elapsed seconds.
const PHASES = Object.freeze({
  // speed, sway, bob, tilt, squash, brow, secondary
  working: [1, 1.2, 1.1, 1.8, .010, .9, .45],
  thinking: [.72, 1.6, .7, 2.1, .008, 1.5, .5],
  responding: [1.2, 1.25, 1.6, 1.7, .016, 1.4, .7],
  tool: [1.45, .85, 1.1, 1.25, .012, .75, .6],
  journaling: [.88, 1.1, .85, 1.5, .009, 1, .4],
  autonomy: [.63, 1.75, 1.3, 2.2, .012, 1.1, .55],
});
const NEUTRAL = Object.freeze({ x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1,
  glassesX: 0, glassesY: 0, glassesRotate: 0,
  leftBrowY: 0, leftBrowRotate: 0, rightBrowY: 0, rightBrowRotate: 0 });
const KEYS = Object.keys(NEUTRAL);
const CADENCE = 1.8;

export function seedForAvatar(id) {
  let hash = 2166136261;
  for (const code of String(id ?? "").slice(0, 4096)) hash = Math.imul(hash ^ code.codePointAt(0), 16777619);
  return hash >>> 0;
}

export function activeAvatarPhase(phase) { return Object.hasOwn(PHASES, phase); }

export function poseForAvatar(timeSeconds, phase, seedNumber = 0) {
  if (!activeAvatarPhase(phase)) return { ...NEUTRAL };
  const [speed, sway, bob, tilt, squash, brow, secondary] = PHASES[phase];
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
    leftBrowY: -brow * (.6 * sin(u * 2.13 + p) + .4 * sin(u * .79 + p * .7)),
    leftBrowRotate: brow * 1.3 * sin(u * 1.41 + p - .3),
    rightBrowY: -brow * (.55 * sin(u * 1.87 + p + .9) + .45 * sin(u * .67 + p)),
    rightBrowRotate: -brow * 1.3 * sin(u * 1.53 + p + .4),
  };
}

// Exponential damping has the same response at 30, 60, and 120Hz. A stalled
// frame is capped so returning to a visible window cannot jump the portrait.
export function dampAvatarPose(current, target, deltaSeconds) {
  const dt = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(.05, deltaSeconds)) : 0;
  const weight = -Math.expm1(-12 * dt);
  return Object.fromEntries(KEYS.map(key => [key, current[key] + (target[key] - current[key]) * weight]));
}

const neutralPose = pose => KEYS.every(key => Math.abs(pose[key] - NEUTRAL[key]) < .001);
const schedulers = new WeakMap();

// One frame callback per window, even with many visible bots. Subscribers remove
// themselves when settled; idle portraits never leave an empty loop running.
function schedulerFor(view) {
  if (schedulers.has(view)) return schedulers.get(view);
  const callbacks = new Set();
  let frame = null;
  const tick = now => {
    frame = null;
    for (const callback of [...callbacks]) if (callbacks.has(callback) && callback(now) === false) callbacks.delete(callback);
    if (callbacks.size && frame === null) frame = view.requestAnimationFrame(tick);
  };
  const scheduler = {
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

/** Attach to a rendered portrait SVG; update phase/seed/paused without remounting.
 *  update(partialOptions) retargets its motion. destroy() releases every listener
 *  and frame subscription. The helper never changes text, geometry, or ARIA.
 */
export function attachAvatarMotion(svg, initial = {}) {
  const document = svg.ownerDocument, view = document.defaultView;
  const scheduler = schedulerFor(view);
  const portrait = svg.querySelector(".bot-avatar-portrait");
  const glasses = [...svg.querySelectorAll(".bot-avatar-glasses")];
  const left = svg.querySelector(".bot-avatar-brow-left"), right = svg.querySelector(".bot-avatar-brow-right");
  let settings = { phase: "ready", seed: 0, paused: false, ...initial };
  let current = { ...NEUTRAL }, elapsed = 0, previous = null, destroyed = false;
  let visible = !view.IntersectionObserver;
  const media = view.matchMedia?.("(prefers-reduced-motion: reduce)");
  const write = pose => {
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
  const tick = now => {
    const dt = previous === null ? 0 : Math.max(0, Math.min(.05, (now - previous) / 1000));
    previous = now;
    elapsed += dt;
    const active = activeAvatarPhase(settings.phase);
    current = dampAvatarPose(current, poseForAvatar(elapsed, settings.phase, settings.seed), dt);
    if (!active && neutralPose(current)) { current = { ...NEUTRAL }; write(current); stop(); return false; }
    write(current);
    return true;
  };
  const refresh = () => {
    if (destroyed) return;
    if (settings.paused || media?.matches) { stop(); current = { ...NEUTRAL }; write(current); return; }
    if (!visible || document.hidden) { stop(); return; }
    if (activeAvatarPhase(settings.phase) || !neutralPose(current)) {
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

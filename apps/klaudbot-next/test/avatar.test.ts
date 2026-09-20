import assert from "node:assert/strict";
import test from "node:test";
import { AVATAR_BROWS, AVATAR_STATES, AVATAR_STYLES, avatarForBot, isAvatarPhase } from "../lib/avatar-catalog.ts";
import { activeAvatarPhase, attachAvatarMotion, dampAvatarPose, poseForAvatar, seedForAvatar, type AvatarPose } from "../lib/avatar-motion.ts";

const neutral: AvatarPose = {
  x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1,
  glassesX: 0, glassesY: 0, glassesRotate: 0,
  leftBrowY: 0, leftBrowRotate: 0, rightBrowY: 0, rightBrowRotate: 0,
};

// Golden samples from authoritative apps/klaud/avatar-motion.mjs, not a second
// implementation of the formula. Elapsed 2.75s, seedForAvatar("bot-1"). This test
// is standalone and never requires a reference checkout or a browser service.
const sourcePoses = {
  working: [-0.8114542540111875, 0.9914439099687182, -1.7287191003791393, 1.0082625017373281, 0.9934083202410132, -0.18145601897088542, 0.20884504704172135, -0.3089291789168409, -0.25238786498944604, -0.73866706522801, -0.47905130544906893, -0.6905863150999101],
  thinking: [-1.0075320733532214, -0.28113822849902304, -0.7073373443910864, 0.9966325155888794, 1.003303441394107, -0.0590930727553284, -0.28797355810145586, 0.0853878107735962, -0.2841539344114815, -0.823773658803996, -0.7723524196194418, 1.9499393087649934],
  responding: [0.3864862187964416, -0.11885294892123943, -0.5066119611369512, 1.0068219010314432, 0.9944624012835729, 0.15703274232012274, 0.12437527500918964, -0.280651864366823, 0.10245936350272045, 1.2553234814939869, 0.5543385247879599, -1.472858185631661],
  presenting: [-0.7440499999255638, 1.2872859878533578, -1.873963237755456, 1.012798897291106, 0.9896359919016445, -0.19394094701792391, 0.4118518157315818, -0.48789396118228473, -0.007306963748309658, -0.4939470867994614, -0.2716839353269888, -1.3318908006324683],
  tool: [0.2848805584929711, -0.6390274714376868, 0.8902144143362942, 0.9898658012256333, 1.0083503228290545, 0.23904960552687698, -0.30224173796029746, 0.3119358028517536, -0.44655085070632805, 0.5302038768424924, -0.15763817419589388, 0.8288974060421417],
  journaling: [-1.0875963555775912, 0.3380715738089492, -1.354936395268279, 1.0021873021986765, 0.9986353124686069, -0.1956302747538234, -0.06854094524849495, -0.17597640557972224, -0.8194914509549531, -1.2997168074783174, -0.9899777763109088, 0.3953861103942893],
  autonomy: [-0.26877243078425267, -0.36591075514769644, 0.16135332574169398, 0.9959712562665541, 1.0039637635444705, 0.10529230251772109, -0.1303943943835692, 0.26728166378412055, 0.5547940324233838, 0.30346380637145637, 0.007648478909978435, 1.096105831954098],
};

test("catalog preserves original six styles, labels, deterministic IDs and hash bounds", () => {
  assert.deepEqual(AVATAR_STYLES.map(({ id, label }) => [id, label]), [
    ["aviator", "Aviator"], ["motorcycle", "Rider"], ["builder", "Builder"],
    ["baseball", "Slugger"], ["medic", "Medic"], ["explorer", "Explorer"],
  ]);
  assert.ok(Object.isFrozen(AVATAR_STYLES));
  assert.ok(AVATAR_STYLES.every(Object.isFrozen));
  for (const [id, seed, avatar] of [
    [undefined, 2166136261, "motorcycle"], ["bot-1", 3391207752, "aviator"],
    ["alpha", 1569418667, "explorer"], ["🦊", 2420435037, "baseball"],
    ["x".repeat(5000), 3759922629, "baseball"],
  ] as const) {
    assert.equal(seedForAvatar(id), seed);
    assert.equal(avatarForBot(id), avatar);
    assert.equal(avatarForBot(id, "cap"), avatar);
    for (const style of AVATAR_STYLES) assert.equal(avatarForBot(id, style.id), style.id);
  }
  assert.equal(seedForAvatar("x".repeat(4096) + "a"), seedForAvatar("x".repeat(4096) + "b"));
  assert.deepEqual(Object.keys(AVATAR_BROWS), Object.keys(AVATAR_STATES));
  assert.equal(AVATAR_STATES.responding, "Replying");
  assert.equal(AVATAR_STATES.approval, "Waiting for approval");
  assert.deepEqual(AVATAR_BROWS.thinking, ["M39 64 L56 65", "M72 59 Q81 55 89 58"]);
  assert.equal(isAvatarPhase("__proto__"), false);
});

test("all seven active phases match authoritative source motion", () => {
  for (const [phase, expected] of Object.entries(sourcePoses)) {
    assert.equal(activeAvatarPhase(phase), true);
    const actual = Object.values(poseForAvatar(2.75, phase, seedForAvatar("bot-1")));
    assert.equal(actual.length, expected.length);
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-12, `${phase} pose key ${index}`));
    assert.deepEqual(poseForAvatar(NaN, phase, 12), poseForAvatar(0, phase, 12));
    assert.deepEqual(poseForAvatar(Infinity, phase, 12), poseForAvatar(0, phase, 12));
    assert.notDeepEqual(poseForAvatar(1, phase, 12), poseForAvatar(1, phase, 13));
  }
});

test("ready, approval, error and unknown phases are static, with fresh neutral poses", () => {
  for (const phase of ["ready", "approval", "error", "", "unknown", "toString", "__proto__"]) {
    assert.equal(activeAvatarPhase(phase), false);
    const pose = poseForAvatar(600, phase, 3391207752);
    assert.deepEqual(pose, neutral);
    pose.x = 100;
    assert.deepEqual(poseForAvatar(0, phase), neutral);
  }
});

test("damping is frame-rate independent and caps stalled or invalid frame deltas", () => {
  const target = poseForAvatar(2.75, "responding", seedForAvatar("bot-1"));
  for (const dt of [-1, 0, NaN, Infinity]) assert.deepEqual(dampAvatarPose(neutral, target, dt), neutral);
  assert.deepEqual(dampAvatarPose(neutral, target, 100), dampAvatarPose(neutral, target, .05));
  const results = [30, 60, 120].map(hz => {
    let pose = { ...neutral };
    for (let i = 0; i < hz; i++) pose = dampAvatarPose(pose, target, 1 / hz);
    return pose;
  });
  for (const key of Object.keys(neutral) as (keyof AvatarPose)[]) {
    assert.ok(Math.abs(results[0][key] - results[1][key]) < 1e-12);
    assert.ok(Math.abs(results[1][key] - results[2][key]) < 1e-12);
  }
  assert.deepEqual(neutral.x, 0, "damping must not mutate input");
});

// Minimal DOM/clock adapters: no jsdom, remote service, or rendering dependency.
function motionFixture(withObserver = true) {
  const frames = new Map<number, FrameRequestCallback>();
  const visibilityListeners = new Set<() => void>();
  const mediaListeners = new Set<() => void>();
  const observers = new Set<FakeObserver>();
  let nextFrame = 0;
  const media = {
    matches: false,
    addEventListener(_name: string, callback: () => void) { mediaListeners.add(callback); },
    removeEventListener(_name: string, callback: () => void) { mediaListeners.delete(callback); },
  };
  class FakeObserver {
    callback: (entries: { target: object; isIntersecting: boolean }[]) => void;
    target: object | null = null;
    constructor(callback: FakeObserver["callback"]) { this.callback = callback; observers.add(this); }
    observe(target: object) { this.target = target; }
    disconnect() { observers.delete(this); }
  }
  const view = {
    requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    IntersectionObserver: withObserver ? FakeObserver : undefined,
    matchMedia() { return media; },
  };
  const document = {
    defaultView: view, hidden: false,
    addEventListener(_name: string, callback: () => void) { visibilityListeners.add(callback); },
    removeEventListener(_name: string, callback: () => void) { visibilityListeners.delete(callback); },
  };
  function svg() {
    const attributes = new Map<string, string>();
    const nodes = new Map([".bot-avatar-portrait", ".bot-avatar-glasses", ".bot-avatar-brow-left", ".bot-avatar-brow-right"].map(name => [name, { style: { transform: "" } }]));
    const element = {
      ownerDocument: document,
      querySelector(selector: string) { return nodes.get(selector) ?? null; },
      querySelectorAll(selector: string) { return nodes.has(selector) ? [nodes.get(selector)!] : []; },
      setAttribute(name: string, value: string) { attributes.set(name, value); },
      removeAttribute(name: string) { attributes.delete(name); },
    };
    return { element: element as unknown as SVGSVGElement, attributes, nodes };
  }
  return {
    frames, visibilityListeners, mediaListeners, observers, svg,
    step(now: number) {
      for (const [id, callback] of [...frames]) { frames.delete(id); callback(now); }
    },
    intersect(target: object, value: boolean) {
      for (const observer of observers) if (observer.target === target) observer.callback([{ target, isIntersecting: value }]);
    },
    hide(value: boolean) { document.hidden = value; for (const listener of visibilityListeners) listener(); },
    reduce(value: boolean) { media.matches = value; for (const listener of mediaListeners) listener(); },
  };
}

test("one shared RAF per window; offscreen, hidden, paused and reduced-motion handling", () => {
  const fixture = motionFixture();
  const a = fixture.svg(), b = fixture.svg();
  const motionA = attachAvatarMotion(a.element, { phase: "working", seed: 10 });
  const motionB = attachAvatarMotion(b.element, { phase: "thinking", seed: 20 });
  const portrait = () => a.nodes.get(".bot-avatar-portrait")!.style.transform;
  const resting = portrait();
  assert.equal(fixture.frames.size, 0, "wait for an intersection report");
  fixture.intersect(a.element, true);
  fixture.intersect(b.element, true);
  assert.equal(fixture.frames.size, 1, "many bots must share a scheduler");
  fixture.step(0); fixture.step(16);
  assert.notEqual(portrait(), resting);
  const beforeHide = portrait();
  fixture.hide(true);
  assert.equal(fixture.frames.size, 0);
  assert.equal(a.attributes.has("data-animated"), false);
  assert.equal(portrait(), beforeHide, "hidden portraits hold their last pose");
  fixture.hide(false);
  fixture.step(100000);
  assert.equal(portrait(), beforeHide, "resuming a visible window does not jump time");
  fixture.step(100016);
  assert.notEqual(portrait(), beforeHide);
  fixture.reduce(true);
  assert.equal(fixture.frames.size, 0);
  assert.equal(portrait(), resting, "reduced motion resets transforms");
  fixture.reduce(false);
  assert.equal(fixture.frames.size, 1);
  motionA.update({ paused: true }); motionB.update({ paused: true });
  assert.equal(fixture.frames.size, 0);
  assert.equal(portrait(), resting);
  motionA.update({ paused: false });
  assert.equal(fixture.frames.size, 1);
  fixture.intersect(a.element, false);
  assert.equal(fixture.frames.size, 0);
  motionA.destroy(); motionB.destroy(); motionA.destroy();
  assert.equal(fixture.observers.size, 0);
  assert.equal(fixture.visibilityListeners.size, 0);
  assert.equal(fixture.mediaListeners.size, 0);
  assert.equal(fixture.frames.size, 0);
  motionA.update({ phase: "tool", paused: false });
  assert.equal(fixture.frames.size, 0, "destroyed controllers cannot restart");
});

test("idle never loops, active-to-ready settles, and missing observer remains supported", () => {
  const fixture = motionFixture(false), svg = fixture.svg();
  const motion = attachAvatarMotion(svg.element);
  assert.equal(fixture.frames.size, 0);
  const resting = svg.nodes.get(".bot-avatar-portrait")!.style.transform;
  motion.update({ phase: "tool", seed: 10 });
  fixture.step(0); fixture.step(30);
  assert.notEqual(svg.nodes.get(".bot-avatar-portrait")!.style.transform, resting);
  motion.update({ phase: "ready" });
  for (let i = 2; i < 100; i++) fixture.step(i * 30);
  assert.equal(fixture.frames.size, 0);
  assert.equal(svg.nodes.get(".bot-avatar-portrait")!.style.transform, resting);
  motion.destroy();
  const detached = attachAvatarMotion({ ownerDocument: { defaultView: null } } as unknown as SVGSVGElement);
  detached.update({ phase: "working" }); detached.destroy();
});
# Asset and interaction provenance

All source reads were from the provided, read-only
`klaudbot-next-ultra-reference` checkout. Only the allowlisted files below were
copied or ported into this project. No credentials, local configuration, server
state, harness code, live service data, or legacy application bundles were copied.
No downloads or remote edits were needed.

## Strict TypeScript ports

| Destination | Authoritative reference source |
| --- | --- |
| `components/avatars.tsx` | `apps/klaud/avatars.jsx` |
| `lib/avatar-catalog.ts` | `apps/klaud/avatar-catalog.mjs` |
| `lib/avatar-motion.ts` | `apps/klaud/avatar-motion.mjs` |
| `lib/sounds.ts` | `apps/klaud/sounds.mjs` |

The six SVG drawings, viewBox, colors, catalog order, labels, descriptions and
phase-specific brows are unchanged. Avatar selection retains the original bounded
FNV-style bot-ID hash. The explicit first catalog choice is `aviator`; without an
explicit choice the bot ID determines the style (an empty ID selects `motorcycle`).

Motion retains the original seven phase parameter sets, 1.8 cadence, seeded
sinusoids, exponential damping (12), 50 ms frame-delta cap, single RAF scheduler
per window, idle settling, reduced-motion reset, visibility pause, offscreen
pause, and teardown. Type-only additions and a safe detached-document no-op do
not change normal rendered motion. `test/avatar.test.ts` contains independent
source golden samples and pure Node scheduler/lifecycle tests. During porting,
882 pose samples and every catalog label/brow were compared directly against the
read-only source, with exact equality.

Sound preserves the original synthesized eight cues (`hover`, `click`, `key`,
`send`, `tool`, `reply`, `error`, `ready`), waveforms, frequencies, gain envelopes,
quiet 0.72 master level, cooldowns, six-voice default cap, trusted-event unlock,
hidden-page suspension and storage key `rein-klaud:sound-effects:v1`.
It installs no library and makes no audio-file or service requests.
`test/sounds.test.ts` verifies the original send envelopes and all cue cooldowns,
trusted-event gating, storage failures, voice limits, hidden/disabled suspension,
cleanup, and browsers without Web Audio using only in-memory Node adapters.

## Byte-identical static copies

Source paths are relative to the reference checkout. SHA-256 values identify the
copied bytes, not transformed output from a Next.js build.

| Destination | Source | SHA-256 |
| --- | --- | --- |
| `app/tokens.css`, `public/tokens.css` | **root** `tokens.css` (not the narrower app token file) | `a5c5cd83a7f1bdd1aacfcba78fe68f70b1dd1809d107cb6c1fc6da78c0654ac8` |
| `app/avatars.css`, `public/avatars.css` | `apps/klaud/avatars.css` | `84d5e86d7a684ac3f919ec32e742d8488a5add6a9bd70d2b6d0dc870c06ee229` |
| `public/icon.svg` | `apps/klaud/icon.svg` | `03ce46fa13249bd31bf001cbc1fae2687c77da03f642e853a0c94731f3df4def` |
| `public/icon.png`, `public/favicon.ico` | `apps/klaud/icon.png` | `6247c6d9dd93372f3e55a94642c7cc9d557f7ca52a923b773974a84edb5c5cd7` |
| `public/setup.css` | `apps/klaud/setup.css` | `9a5e9bf205430ebe1bb7374a3b1c6442d66bdb8d455b621b0feb71a4175cc3be` |
| `public/rein-logo.svg` | `apps/klaud/dist/rein-logo.svg` | `4f96c1e34cd35eaad3c95bd7b2803e29132d7643ed42aaf936c432c6288cca96` |
| `public/rein-field-guide-card.jpg` | `apps/klaud/dist/rein-field-guide-card.jpg` | `a04c0703286054b50221843031a1210e680bb7a8b926a3258bf9f2fd9267c8a2` |

The two `rein-*` images are public field-guide assets supplied in the reference
distribution; only those individual files were selected, not the distribution
directory or any runtime. `favicon.ico` is deliberately a byte-for-byte PNG alias,
as permitted by the compatibility contract, rather than a re-encoded ICO drawing.

## Compatibility URLs and CSS ownership

`public/browser.js` and `public/renderer.js` are new, side-effect-free empty ES
modules with explanatory comments. They do not load a legacy renderer, browser
setup flow, Electron bridge, or backend connection. The real app is booted by
Next.js bundled assets.

`public/styles.css` forwards only `tokens.css` and `avatars.css`. Main application
styles are bundled by Next.js from `app/globals.css`, which the UI owner imports
alongside the exact `app/tokens.css` and `app/avatars.css`. The standalone public
stylesheets preserve compatibility URLs; they do not replace the bundled UI CSS.
# Design — Rein Cloud

This is the shared visual system for rein-klaʊd. App views use the same field-manual language as Rein's public installation guide and repository artwork.

## Genre

Editorial, expressed as an industrial computer field manual. The interface is functional before it is decorative.

## Macrostructure family

- App views: Workbench. One persistent masthead, a narrow bot rail when enabled, and one working area for Bots, Chat, or Settings.
- Setup views: Split Workbench. The existing field-guide card anchors the left side; the live connection form owns the right.
- Content pages: Long Document, using the same rules, labels, and typography.

## Theme

- Paper: `oklch(94.78% 0.0241 85.79)`
- Paper secondary: `oklch(92.51% 0.0303 83.63)`
- Ink: `oklch(27.82% 0.0115 145.26)`
- Muted ink: `oklch(46.72% 0.0228 133.29)`
- Rule: `oklch(79.27% 0.0344 83.69)`
- Action rust: `oklch(53.50% 0.1545 33.87)`
- Signal mustard: `oklch(81.87% 0.1258 83.16)`
- Terminal green: `oklch(38.72% 0.0512 164.23)`
- Night paper: `oklch(22.07% 0.0097 145.24)`
- Night action rust: `oklch(75% 0.128 39)`
- Night focus gold: `oklch(87% 0.11 83)`

Rust marks actions, focus, and active navigation. Mustard marks activity and diagram fields. Green belongs to tool output and healthy terminal states. No gradients, glass, blue SaaS chrome, soft shadows, or pill controls.

## Typography

- Display: Impact with Haettenschweiler, Arial Narrow, Liberation Sans Narrow, and DejaVu Sans Condensed fallbacks, weight 900, upright.
- Body: Avenir Next with Helvetica Neue and Arial fallbacks, weight 400.
- Mono: SFMono-Regular with Consolas and Liberation Mono fallbacks, weight 600 for operational labels.
- Display tracking: `-0.025em`; all-caps leading never below `1`.
- Body copy: 16 px minimum, 1.55 line height, 65 characters maximum.

## Spacing

A named four-point scale lives in `tokens.css`. App styles use those names rather than ad hoc gaps.

## Motion

- Buttons move by one pixel on hover and return on press.
- Views use one short opacity and vertical-position reveal.
- State changes use the three named easing tokens.
- Reduced motion keeps only opacity changes at 150 ms or less.
- Typing, thinking, note-writing, and autonomy use distinct terminal signals
  driven by actual runtime events. Stop the animation when that activity ends.
  A running daemon alone is not evidence that it is doing autonomy work.
- Keep phase names readable beside the animation. Decorative frames are hidden
  from assistive technology; reduced motion shows a static phase symbol.
- Rain is Rein Cloud's ambient motif: sparse square drops, a pixel cloud, and
  the established rust/paper/amber palette. Keep it in frame or wallpaper areas,
  away from reading and input surfaces. Provide an off switch, pause while hidden,
  and use static rain with reduced motion. Ambient rain does not imply agent work.
- The OS build is named **rein-dərāchō**. Its rain theme shares Rein-klaud's
  palette and field-guide artwork; keep the OS name on OS-facing surfaces.

## Sound

- Sounds are short synthesized cues, never audio samples or loops.
- Hover is a soft phosphor tick. Click and key cues resemble quiet relays. Send, tool, reply, ready, and error each have a restrained distinct pattern.
- Audio starts only after a trusted pointer or keyboard action. It never auto-plays on launch.
- The always-visible SFX control stores a device-local choice. Audio never carries information that is absent from text or ARIA.

## Microinteractions stance

- Show results in place. Do not add success toasts.
- Focus is immediate and visibly outlined.
- Hover feedback appears only for fine pointers and has a keyboard-focus equivalent.
- All controls keep a stable one-pixel border and a 44 px target.

### Interaction references

Use [Beautiful UI](https://beautifului.dev), [beUI](https://beui.dev),
[Rare UI](https://rareui.com), [Transitions](https://transitions.dev), and
[shadcn/ui](https://ui.shadcn.com) as references for control behavior, accessible
disclosure, and restrained motion. Adapt useful patterns to Rein's square field
controls, paper surfaces, hard rules, and existing sound cues. Keep the palette,
typography, and reduced-motion behavior above; a reference is not a new theme or
a reason to add a component dependency.

## Navigation and control voice

- Masthead: N6 newspaper masthead adapted to native desktop chrome. A full Rein lockup anchors the left; Bots, Chat, and Settings read as a numbered field index.
- Primary actions: square rust controls with paper text and direct verbs.
- Secondary actions: paper controls with an ink rule.
- No footer is added to the desktop app.

## Per-view allowances

- Setup may show the supplied field-guide card.
- Chat may use hard rules, mono folios, and terminal-green tool blocks.
- Bots and Settings share the same field rows and control geometry.
- App views do not introduce new decorative illustration.

## What every view shares

- The R/horse monogram and `rein-klaʊd` name.
- Cream, charcoal, rust, mustard, and terminal green.
- Condensed display type, plain body type, and mono operational labels.
- Square controls, hard rules, and numbered identity labels.
- The same SFX control and keyboard/focus behavior.

## Native assets

- The Dock and window icon uses the operator-approved field-guide computer illustration with real transparent corners and an R/horse screen mark.
- The system tray uses dedicated 1x and 2x R/horse template images. Ready shows the mark alone; working adds one status dot. macOS supplies the correct light or dark menu-bar color.

## Exports

### tokens.css

The canonical implementation is the repository-root `tokens.css` file. It contains the complete palette, type, spacing, motion, rule, and radius tokens.

### Tailwind v4

```css
@theme {
  --color-paper: oklch(94.78% 0.0241 85.79);
  --color-ink: oklch(27.82% 0.0115 145.26);
  --color-accent: oklch(53.50% 0.1545 33.87);
  --color-signal-gold: oklch(81.87% 0.1258 83.16);
  --color-signal-green: oklch(38.72% 0.0512 164.23);
  --font-display: Impact, "Arial Narrow", sans-serif;
  --font-body: "Avenir Next", "Helvetica Neue", Arial, sans-serif;
  --font-mono: "SFMono-Regular", Consolas, monospace;
  --spacing-md: 1rem;
  --text-base: 1rem;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

### DTCG

```json
{
  "color": {
    "paper": { "$value": "oklch(94.78% 0.0241 85.79)", "$type": "color" },
    "ink": { "$value": "oklch(27.82% 0.0115 145.26)", "$type": "color" },
    "accent": { "$value": "oklch(53.50% 0.1545 33.87)", "$type": "color" },
    "gold": { "$value": "oklch(81.87% 0.1258 83.16)", "$type": "color" },
    "green": { "$value": "oklch(38.72% 0.0512 164.23)", "$type": "color" }
  },
  "font": {
    "display": { "$value": "Impact", "$type": "fontFamily" },
    "body": { "$value": "Avenir Next", "$type": "fontFamily" },
    "mono": { "$value": "SFMono-Regular", "$type": "fontFamily" }
  },
  "space": { "md": { "$value": "1rem", "$type": "dimension" } }
}
```

### shadcn/ui

```css
:root {
  --background: 94.78% 0.0241 85.79;
  --foreground: 27.82% 0.0115 145.26;
  --primary: 53.50% 0.1545 33.87;
  --primary-foreground: 98.62% 0.0142 84.58;
  --muted: 92.51% 0.0303 83.63;
  --muted-foreground: 46.72% 0.0228 133.29;
  --border: 79.27% 0.0344 83.69;
  --input: 79.27% 0.0344 83.69;
  --ring: 44% 0.132 33.87;
  --radius: 2px;
}
```

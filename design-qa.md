# Rein Cloud design QA

## Evidence

- Source visual truth: `docs/assets/rein-field-guide-card.png`
- Primary implementation capture: `.hallmark/qa-welcome-light.jpg`
- Combined comparison input: `.hallmark/qa-reference-welcome-comparison.jpg`
- Additional rendered states:
  - `.hallmark/qa-chat-night.jpg`
  - `.hallmark/qa-settings-light.jpg`
  - `.hallmark/qa-chat-minimum.jpg`
  - `.hallmark/qa-error-minimum.jpg`
  - `.hallmark/qa-responsive-320.png`
  - `.hallmark/qa-icon-sizes.png`
- Runtime: packaged `apps/klaud/dist/index.html` in Electron 44.2.0
- Main viewport: 1084 x 768 CSS px at 1x capture density
- Minimum viewport: 733 x 530 CSS px at 1x capture density, within two pixels of the app's 720 x 520 content target after native window chrome
- Source pixels: 1280 x 640
- Primary implementation pixels: 1084 x 768
- Combined input pixels: 2400 x 779, downsampled from a 4728 x 1536 side-by-side render for repository size; the original source was centered without cropping and the implementation used its complete window capture
- State: disconnected Light setup for the primary comparison; connected Night chat, connected Light settings, minimum-size chat, and minimum-size error states as supporting evidence

The source is a social-card brand reference rather than a desktop screen mock. The comparison therefore judges exact visual language and asset fidelity rather than identical region geometry. The app embeds the source card itself in the setup view and uses the same supplied Rein mark, palette, condensed display hierarchy, monospaced field labels, hard rules, square controls, and cream paper surface.

## Full-view comparison

The combined input shows the source and implementation in one image. Palette balance, mark color, display type, operational labels, rule weight, and industrial field-guide tone carry directly into the app. The welcome screen retains a clear live connection task beside the art instead of turning the reference card into a nonfunctional poster. No source illustration, logo, or nonstandard icon was replaced with CSS, text, emoji, or an approximate drawing.

## Focused-region comparison

A separate crop was unnecessary because the 2400 px comparison keeps the mark, display headlines, field labels, rules, image treatment, radio controls, and primary action readable in one input. The original 4728 px comparison was also inspected before downsampling.

## Required fidelity surfaces

- Fonts and typography: the implementation uses the same condensed black headline character as the source through the documented Impact/Haettenschweiler/Arial Narrow stack, with Liberation Sans Narrow and DejaVu Sans Condensed preserving that character on Linux. Body copy remains readable at 16 px, and operational labels use the repository's mono stack. Headline wrapping, weights, tracking, and line height remain stable at both tested desktop sizes.
- Spacing and layout rhythm: the setup screen uses a deliberate split workbench, while connected views use a fixed masthead, agent rail, and working surface. Four-point spacing tokens govern controls and rows. The 733 x 530 pass kept navigation, SFX, transcript, and composer controls reachable without horizontal overflow.
- Colors and visual tokens: Light uses the exact cream, rust, mustard, green, charcoal, and rule palette from the source. Night remaps surfaces to charcoal and uses lighter rust and green signals designed for that surface. Runtime measurements across all three accents show Night text contrast of 7.39:1 or better, action text of 6.79:1 or better, focus contrast of 11.56:1, and control borders of 5.11:1 against the page and 4.30:1 against fields. App CSS consumes semantic variables from root `tokens.css`; no raw color literals appear in `apps/klaud/styles.css`.
- Image quality and asset fidelity: the setup card is the supplied 1280 x 640 field-guide artwork, shown at its natural 2:1 ratio with no crop or stretch. The masthead uses the supplied Rein R/horse asset. The operator-approved native icon extends the card's CRT, cable, keyline, paper texture, and five-color palette; it has transparent corners, stays readable from 32 to 256 px, and is shown with its dedicated ready/working tray marks in `.hallmark/qa-icon-sizes.png`.
- Copy and content: setup, Bots, Chat, Settings, errors, approvals, and the composer use concise field-console language while preserving the original actions. Operator, agent reply, and tool execution rows have explicit numbered identity labels.

## Interactions and runtime checks

- Started an isolated local Rein server from the welcome screen.
- Created and reopened a `Rain` field unit.
- Tested Bots, Chat, and Settings navigation.
- Switched Night to Light and confirmed both rendered themes.
- Muted and re-enabled sound from Settings and confirmed the always-visible header control updated in sync.
- Clicked the full Attach row outside its radio input and the full Night row outside its checkbox. Both changed state, and the Attach row created the expected real-time 48 kHz oscillator and filtered-noise graph.
- Loaded user, assistant, tool-call, and tool-result records to inspect every reply identity treatment.
- Submitted a run without a configured model to verify working, error, dismiss, and restored-ready behavior.
- Resized the native window to its minimum and checked persistent controls, scrolling, and horizontal fit.
- Used the Electron renderer's device-metrics override at 320, 375, 414, and 768 CSS px. At every width, `clientWidth`, document `scrollWidth`, and body `scrollWidth` matched exactly; the 320 px state is captured in `.hallmark/qa-responsive-320.png`.
- Attached Chrome DevTools Protocol to the actual Electron renderer: a trusted UI click created a real-time 48 kHz AudioContext, resumed it to `running`, built oscillator, gain, filtered-noise, and destination nodes, then disconnected the short-lived cue graph.
- Enabled the Runtime and Log domains after the interaction pass. The document was complete, the app root was present, and no console errors or warnings were reported.
- Confirmed active bots expose `aria-pressed`, Ready/Working exposes a polite live status, and transcript streaming uses immediate auto-scroll.
- Verified the native icon is a 1024 px PNG with alpha 0 at every corner. Ready and working tray images are distinct at 22 px and 44 px Retina sizes: black-and-alpha templates on macOS and cream-outlined field-guide colors on Windows and Linux.
- Restarted the native app and verified the macOS application menu and process title report `rein-klaʊd` instead of Electron.

## Findings

No actionable P0, P1, or P2 differences remain after the independent review and correction pass. The source does not prescribe a dark theme, connected workspace, responsive behavior, or sound controls; those states consistently extend its visual language without displacing the core task.

## Comparison history

- Pass 1: compared the source and rendered Light setup, then inspected Night chat, Light settings, minimum chat, and minimum error captures. No P0/P1/P2 issue was found. The Hallmark gate sweep then tightened focus geometry, display line height, setup padding, and single-line button behavior. The final Light setup was recaptured and replaced in `.hallmark/qa-reference-welcome-comparison.jpg`; it still has no actionable P0/P1/P2 difference.
- Pass 2: an independent code and runtime review found weak Night accent, focus, and control-border contrast; missed label-row sound targets; streaming smooth-scroll churn; incomplete selection/status semantics; Linux display fallback loss; stale renderer launches; and incomplete native icon handling. Each issue was corrected. The Night chat capture was refreshed after the final token change, and runtime contrast now clears the applicable 3:1 and 4.5:1 thresholds.
- Pass 3: the first native icon was rejected by the operator as unpolished. The approved replacement carries the field-guide CRT illustration into the Dock, keeps true transparent corners, and pairs with separate ready/working Retina tray templates. `.hallmark/qa-icon-sizes.png` records the 32, 64, 128, and 256 px review plus both tray states.

## Follow-up polish

- P3: sound character still benefits from subjective listening on more than one speaker or headphone setup; automated tests and the live graph prove behavior and safe levels, but timbre is a human preference.

final result: passed

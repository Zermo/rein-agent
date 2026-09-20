# klaʊdbot · Field console / 01

Merged sandbox (Grok Build UI + Codex Ultra API fidelity). TypeScript / Next.js App Router rebuild of **the same klaʊdbot product**. This tree is the future replacement for `apps/klaud`, not another public brand. **Sandbox only. Nothing here deploys, edits Caddy, starts a LaunchAgent, changes a model host, or touches live credentials.**

## Build and start in the sandbox

Node 24 or newer. Validated with Node 26.3.0. All dependencies are pinned in the lockfile.

```sh
cd /Users/portal/Projects/klaudbot-next-ultra
npm ci
npm run build
npm start
```

**Listen: `http://127.0.0.1:4322` — loopback only.** Production Next, not a development preview. Stop with Ctrl+C when running in the foreground. No service registration is needed.

Default upstream is the existing backend at `http://10.0.0.56:4317`. This Mac cannot directly reach that LAN interface. For the delivered local process, the same product's existing public ingress is used without credentials:

```sh
cd /Users/portal/Projects/klaudbot-next-ultra
KLAUD_ORIGIN=https://openbot.zermo.org npm start
```

This allows a real `/health` check and an honest sign-in screen. **It does not borrow an Authelia session, bypass login, or impersonate Tom.** A loopback browser cannot inherit cookies scoped to `zermo.org`; complete authenticated live testing requires the operator's existing login on the intended origin or a LAN bearer entered voluntarily. No bearer is loaded from disk. The optional LAN input is memory-only and is never rendered on `openbot.zermo.org`.

## Validation

```sh
cd /Users/portal/Projects/klaudbot-next-ultra
npm run typecheck
npm test
npm run build
# Install Chromium only if not already present:
npx playwright install chromium
npm run test:browser
npm audit
```

Browser verification starts its own **isolated fixture backend** on an ephemeral loopback port and a temporary production Next process on **4324**, tests interactions, and tears both down. It never sends a run, setting change, or bot creation to Ares. Generated screenshots and the machine-readable report are under `/Users/portal/Projects/klaudbot-next-ultra/test-results/` (gitignored).

An existing Chromium installation can be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE` (an absolute executable path). This machine's browser download stalled during extraction, so validation used the already-installed Chromium headless shell via that option; no browser or service was launched on the live host.

The unmodified source harness was copied read-only from disk into `/Users/portal/Projects/klaudbot-next-ultra-reference`. Its original `test/klaud-serve.test.ts` can be checked independently:

```sh
cd /Users/portal/Projects/klaudbot-next-ultra-reference
node --test test/klaud-serve.test.ts
```

This creates only test-temporary homes with synthetic credentials. No live token, session, registry, cwd, skill, or MEMORY file is used.

## What is rebuilt

- Compact Rein masthead; numbered Bots / Chat / Computer / Settings; vintage headwear avatars and motion from the original source; root token palette and Avenir type.
- Full-height workbench: 200px agent rail, flush chat, always-present 280px context rail. Narrow screens hide only the left roster and stack the context rail below chat.
- Ledger immediately followed by composer. Streaming user/assistant rows survive history loading; full answers are never CSS-clipped; long answers use default-open native disclosure. Per-answer Path opens only the right-side timeline.
- Path: visible cream 2px spine, horizontal connector ticks, offset cards, tool accents, selected-node inversion. Snippets are capped at 500 characters, not chat answers.
- CRT: fixed cream ink `#f4ead4` on `#12100e` / `#1a1814`, cwd-backed icons, Take hold / Release, inert glass, dismissible file window, image / sandboxed HTML / text previews. Misses stay in that window. One latest PNG/SVG/HTML auto-opens, never every reference.
- SSE `/run`; cancellation; in-app Deny / Allow / Whitelist / Always allow; all four renderer tools; public progress and activity tail (80 lines). No native confirmation dialog.
- Persisted server approval/reasoning preferences and shell patches; device-local rain and quiet relay/CRT sounds; hidden-tab/reduced-motion handling; assisted setup flow.

## Honest backend boundaries

- `computer: "local"` labels the bot's existing cwd. Taking hold unlocks file inspection; it does **not** pause the agent or provide a remote OS desktop, container, VM, or computer-use agent.
- The inspected live harness has **no `/setup` or model/account provisioning endpoint**. The browser wizard keeps DGX Spark, saves a device-local work profile, and prepares a reviewed starter message. Its task limits are requests, **not enforced server budgets**. It never migrates a home or rewrites model credentials. Browser `onboardingInspect()` reports completed as specified.
- `/settings` persists `reasoningEffort`, but this source version does not visibly pass that setting into `createRunner`. The UI does not claim an inference change was verified. A provider/harness change is a separate decision; this rebuild does not alter it.
- The existing history endpoint may return previews above 32,768 characters with `truncated:true`. The UI keeps full text it received during a run and never clips it. It cannot retrieve omitted history bytes through an API the harness does not expose; the preview marker remains visible on a fresh load.
- No OpenMaus, CopilotKit, Three.js, Rakazo, or additional agent runtime is installed.

## API and security

Every section-4 endpoint is wired, plus the existing paginated history endpoint. See `/Users/portal/Projects/klaudbot-next-ultra/CONTRACT.md` for the exact table and `/Users/portal/Projects/klaudbot-next-ultra/SHIM.md` for the Next-only proxy boundary. **No harness compatibility edit was needed.**

Next serves `/`, `/index.html`, its generated assets, and the named legacy public assets without authentication. Legacy `browser.js` / `renderer.js` are compatibility no-ops: Next boots the app; a second legacy renderer must not mount. Static/health requests still pass Host/Origin checks.

`KLAUD_ORIGIN` is server-only, not `NEXT_PUBLIC_*`. Never put a token or cookies in this variable, a URL, source control, logs, or a message. `KLAUD_TRUST_AUTH_PROXY` is off and must remain off in the sandbox. Future ingress details and rollback are in `/Users/portal/Projects/klaudbot-next-ultra/HANDOFF.md`.

PostCSS is overridden to 8.5.23 to resolve the advisory chain found during installation, without forcing an unrelated Next major-version migration. `npm audit` was rechecked after the override.
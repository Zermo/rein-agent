# Sandbox validation — September 20, 2026

## Passing checks

| Check | Result |
| --- | --- |
| `npm run build` | Production build passes; TypeScript checked; App Router static shell + dynamic catch-all |
| `npm run typecheck` | Strict TypeScript passes |
| `npm test` | **62 passed, 0 failed** — API, SSE parser, history ordering/identity, public tools, inspect safety/size, Host/Origin/auth, native streaming/cancel, avatar and sound behavior |
| Original `test/klaud-serve.test.ts` | **17 passed, 0 failed** in read-only source snapshot with its original public distribution files; no harness edits |
| Production Chromium checks | **12 scenario groups passed**, zero uncaught page errors |
| `npm audit` | **0 vulnerabilities** |
| Source-token parity | Root `tokens.css` byte-identical; catalog, SVG geometry and 882 motion samples match reference |
| Credential-file scan | No `.env*` or `.token` files in deliverable source; no harness copied into app |

## Browser proof

The browser suite used a synthetic local fixture, an ephemeral loopback backend and temporary production Next port 4324. Both test processes were shut down. The existing Chromium headless shell was selected explicitly after the matching browser download stalled during extraction:

```sh
cd /Users/portal/Projects/klaudbot-next-ultra
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/Users/portal/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell npm run test:browser
```

Assertions cover:

1. Every named static public file and health loads without an auth redirect; production middleware rejects unknown Host and Origin.
2. Exact title `klaʊdbot`, full long reply, open disclosure, scrolling, ledger immediately followed by composer.
3. You → tool → Reply timeline, cream 2px spine and selected-node inversion.
4. Cream CRT text in **both night and light** themes, hold/release, file close, inspect misses isolated to window, HTML sandbox and blocked remote-resource beacon.
5. SSE, public frontend shell patch and confirmation, native Whitelist approval, policy storage, local-id survival and one automatic SVG presentation.
6. POST cancellation and no false fault banner for an intentional stop.
7. Persisted settings and browser setup profile; reviewed starter remains unsent.
8. Bot POST contains only name, followed by avatar PATCH and preference selection.
9. 390px phone layout, visible context rail and no horizontal page overflow.
10. No bearer input on the public hostname, including when its API is unavailable.
11. Sign-in button sends the window to the fixed Authelia return URL.
12. Direct public API 302 is rejected inside fetch and the **window**, not fetch, goes to Authelia.

Machine-readable results: `/Users/portal/Projects/klaudbot-next-ultra/test-results/browser-proof.json`.
Screenshots: `path-desktop.png`, `crt-inspect-error.png`, `mobile.png`, and `running-sandbox-auth.png` in `/Users/portal/Projects/klaudbot-next-ultra/test-results/`.

## Process left running

- App tree: `/Users/portal/Projects/klaudbot-next-ultra`
- Production listener: **127.0.0.1:4322**
- Process observed at verification: Node PID **11526** (transient; inspect current PID before stopping)
- Launch command: `KLAUD_ORIGIN=https://openbot.zermo.org NEXT_TELEMETRY_DISABLED=1 npm start`
- Log: `/tmp/klaud-ultra-start.log`
- Local `/health`: `{"ok":true,"name":"rein-klaud"}`
- Existing public `/health`: `{"ok":true,"name":"rein-klaud"}`
- Local unauthenticated `/state`: **401 auth_required**, no fabricated identity.
- A fresh Chromium window on the running sandbox loaded title `klaʊdbot`, displayed the Authelia door, and produced zero uncaught page errors.

## Not claimed

This Mac cannot reach `10.0.0.56:4317` directly. No authenticated live Ares run, live bot creation, setting write, credential/cookie reuse, or multi-hour SSE soak was performed. LAN authenticated proof is still required before any merge cutover. Browser setup cannot provision models or enforce runner budgets through the inspected backend, and persisted reasoning effort application remains a backend limitation; see README.

No Caddy edits/reload/cut, LaunchAgent registration/kickstart, token reads/mint/rotation, Slack messages, model restarts, or container operations occurred. All source changes are in the separate sandbox. The other build seat's sandbox and original local checkouts were left untouched.
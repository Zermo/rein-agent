# Mastra Factory: study and Dareecho integration

Branch: `codex/mastra-factory`. Date: 2026-09-10.

## What Factory is

Mastra Factory is an open-source environment for building software with
coding agents: it takes GitHub/Linear issues and turns them into
investigations, plans, implementations, and reviewed pull requests. One
server process serves both the web UI and the API. The agent that does the
work runs inside a sandbox (platform, E2B, or local); auth, storage, and
sandboxes are each independently configurable, so the Mastra platform is
optional.

## Where the code lives

| Piece | Location | Package | License |
| --- | --- | --- | --- |
| Factory server core | `mastra-ai/mastra` → `mastracode/factory` | `@mastra/factory` 0.14.1-alpha (295 TS files, ~111k lines) | Apache-2.0 |
| Factory UI (SPA) | `mastra-ai/mastra` → `mastracode/factory-ui` | served by the server | Apache-2.0 |
| Scaffolder (`npm create factory`) | `mastra-ai/mastra` → `mastracode/mastra-factory` | `create-factory` 0.1.18-alpha | Apache-2.0 |
| Generated project (the copyable unit) | `mastra-ai/softwarefactory-template` | `mastra-factory` 0.1.0 | Apache-2.0 |
| Supervisor agent skill | template → `.agents/skills/mastra-factory/` | operates via `mastra api factory` | Apache-2.0 |

Forks created for this work (account `tullman17-coder`):

- `github.com/tullman17-coder/mastra`
- `github.com/tullman17-coder/softwarefactory-template`

The template is the pure-copy unit: it depends only on published npm
packages (`@mastra/factory`, `@mastra/core`, `@mastra/code-sdk`,
`@mastra/memory`, `@mastra/pg`, `@mastra/libsql`, `@mastra/e2b`,
`@mastra/platform-workspace`, `@mastra/redis-streams`,
`@mastra/auth-workos`, `zod`) plus the `mastra` CLI. No monorepo build is
required: `npm install && npm run dev`.

## Verdict: can it be copied purely?

Yes, with three documented caveats.

**1. License.** Apache-2.0 throughout the Factory surface. The Mastra
monorepo additionally licenses every `ee/` directory under a Kepler
Enterprise license: production use (beyond development and testing on your
own systems) requires a written agreement. EE-licensed code sits inside the
dependency closure — `packages/core/src/auth/ee` and
`packages/core/src/agent-builder/ee` are shipped inside `@mastra/core` —
but it is dormant in open-source mode: the FGA checks guard on
`mastra.getServer()?.fga` before the lazy import of
`auth/ee/fga-check`, and the core license client defaults to
`mode = 'open-source'`. Practical exposure is low; for a production
Dareecho deployment, the strict reading should be confirmed with Kepler.

**2. Node runtime.** `@mastra/factory` requires Node `>= 22.19.0`
(`create-factory` `>= 22.13.0`; the template pins `>= 22.19.0`). Rein's
published bundle still supports Node 18, so Factory cannot be folded into
`dist/rein.js`. It runs as a separate service with its own Node 22+
runtime — consistent with Dareecho's development setup (Node 22.18+/24+).
Expect a large dependency tree: `@mastra/core` alone unpacks to ~64 MB,
`@mastra/factory` to ~5 MB.

**3. Alpha maturity.** The Factory packages are `0.14.x-alpha` /
`0.1.x-alpha`. The surface is stable enough to operate (the template ships
a varlock-validated `.env.schema`), but expect movement upstream.

## What a platform-free run needs

From `src/mastra/index.ts` in the template (the single place deployment env
is read):

- **Storage:** `DATABASE_URL` (Postgres + pgvector) or, in development, a
  local libSQL file. Both power the full app surface (auth, intake, audit,
  work items, integrations).
- **Auth:** `MASTRACODE_AUTH_DISABLED=1` (single operator), a self-managed
  WorkOS pair, or the platform default.
- **Sandbox:** `FACTORY_SANDBOX_PROVIDER=local` runs git and the build
  tools directly on the host (allow-listed env only; no tenant isolation —
  fine for a single-operator machine).
- **Integrations:** GitHub App (`GITHUB_APP_*`), Linear, and Slack are each
  optional; partial credential groups stay disabled and reportable.
- **Models:** built-in Anthropic/OpenAI keys or user-defined
  OpenAI-compatible providers (`url`, `apiKey`, `models`) — the
  `CustomProviderRecord` domain in `@mastra/factory` exists exactly for
  self-hosted endpoints.
- **Telemetry:** PostHog captures fire only under the `mastra-studio`
  platform auth provider and are kill-switchable via
  `MASTRACODE_TELEMETRY_DISABLED`.
- **Credential encryption:** `FACTORY_CREDENTIAL_ENCRYPTION_KEY`
  (`openssl rand -base64 32`) must be generated and backed up; without it
  stored provider keys persist as plaintext.
- **PubSub/Redis:** optional, for multi-replica deployments.

## Native Dareecho integration: a wrapped app, not a rebrand

Decision: Mastra Factory keeps its name, interface, and icon. Dareecho
hosts it. The app is installed alongside Dareecho — "look what's inside":
open it and the machine's software factory is running, with issues,
sessions, plans, and pull requests visible live.

### What this branch ships

- **`vendor/mastra-factory/`** — the pure copy: an unmodified copy of
  `mastra-ai/softwarefactory-template` at the pinned commit, with a
  `PROVENANCE.md` record (upstream, SHA, date, license, fork for tracking).
- **`apps/factory/`** — the native wrapper, following the `apps/klaud`
  patterns (Electron 44, own lockfile, `package-macos.mjs` with signing,
  notarization, ZIP roundtrip, and build report):
  - `provision.mjs` (Electron-free, unit-tested): installs the generated
    project into `~/.local/share/rein-factory` from the bundled template
    once, never overwrites user state, generates
    `FACTORY_CREDENTIAL_ENCRYPTION_KEY`, and writes `.env` (local sandbox,
    single-operator auth, no platform telemetry, single-machine libSQL
    storage or Postgres via `DATABASE_URL`).
  - `main.mjs`: starts the Factory server (`npm run start`), waits for
    readiness, attaches to an already-running server instead of starting a
    duplicate, opens the Factory UI in a native window (external links go
    to the user's browser), and stops the owned server on quit.
  - `NOTICE` + `README.md`: attribution and the no-rebrand policy; the app
    icon is the Factory PWA mark.
  - `test/`: 11 passing tests for provisioning and lifecycle.

### What stays Mastra

The agent loop that executes sessions (Mastra agents/`code-sdk`/memory
inside the sandbox), the UI, the supervisor skill (bundled with the
template for agents to operate Factory), and the branding. Replacing the
agent loop with the Rein loop is a deeper integration and a separate
effort.

### Done on this branch

- `rein os factory setup|start|dev|stop|status|open` — the terminal drives
  the same supervisor as the app. The supervisor module
  (`apps/factory/supervisor.mjs`) is shared: server state (pid file, log,
  port) lives under `~/.local/state/rein-factory`, the generated project
  under `~/.local/share/rein-factory`, and either surface can start, stop,
  and inspect the same server. Two profiles: `start` is the production
  profile (built server, requires `DATABASE_URL`) and `dev` is the
  single-machine profile (dev server, libSQL storage, no database); the app
  picks by configuration. 12 CLI tests cover setup idempotence (install and
  build each run once), both profiles, the start/status/stop lifecycle,
  stale pid handling, foreign-port detection, and dispatch. Verified
  end to end against the real Mastra Factory: setup → dev start → status →
  stop on a scratch home.

### Next increments

1. Kit staging: include the app (or its source, as the kit does for
   `apps/klaud`) in `rein os prepare` payloads with the verifier updated.
2. Model wiring: pre-register the Dareecho model host as the Factory's
   default custom OpenAI-compatible provider on setup.
3. Offline dependency bundle in the .app (today the one-time `npm install`
   needs network) and the Dareecho OS service unit.

## Risks and open questions

- Alpha versions upstream; pin and re-verify on each upgrade.
- EE-licensed dormant code inside `@mastra/core` — confirm the strict
  license reading before production deployment.
- Local sandbox has no tenant isolation; acceptable for single-operator
  Dareecho, not for multi-tenant hosting.
- WorkOS (if used for auth) is an external SaaS; `MASTRACODE_AUTH_DISABLED=1`
  removes it from the loop.
- Node 22.19+ is a hard floor for the service runtime, separate from the
  Rein bundle's Node 18 support.
- One-time `npm install` of Factory dependencies needs network; the
  offline bundle is a listed next increment.

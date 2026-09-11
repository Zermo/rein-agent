# Mastra Factory (Dareecho wrapper)

A native macOS window and supervisor that hosts [Mastra Factory](https://factory.mastra.ai/)
alongside Dareecho: open the app, and the machine's software factory is
running — issues, sessions, plans, and pull requests visible live.

This is not a rebrand. The app is Mastra Factory: its name, interface, and
icon stay Mastra's. Dareecho is the host. See `NOTICE`.

## What it does

1. Installs a generated Mastra Factory project into user state
   (`~/.local/share/rein-factory`) from the bundled, unmodified upstream
   template (`vendor/mastra-factory`). It creates it once and never
   overwrites it.
2. Generates the credential-encryption key and writes `.env` once: local
   sandbox, single-operator auth, no platform telemetry, single-machine
   libSQL storage (or Postgres when `DATABASE_URL` is provided).
3. Installs the Factory dependencies one time (`npm install`).
4. Starts the Factory server (`npm run start` in the project directory) and
   waits for it to be ready. If a Factory server is already running on the
   port, the app attaches to it instead of starting another.
5. Opens the Factory UI in a native window. External links open in the
   user's browser.

## Runtime requirements

- Node `>= 22.19.0` and npm on `PATH` for the Factory server (the wrapper
  itself runs on Electron's bundled Node).
- A one-time network install of the Factory dependencies.
- Git and the target repository's build tools for the local sandbox.

## Configuration

| Variable | Effect |
| --- | --- |
| `FACTORY_PROJECT` | Project directory (default `~/.local/share/rein-factory`) |
| `FACTORY_PORT` | Server port (default 4111) |
| `FACTORY_START_TIMEOUT_MS` | Readiness wait (default 120000) |
| `DATABASE_URL` | Postgres + pgvector storage instead of single-machine libSQL |

Model providers connect through the Factory UI (Settings › Models),
including the Dareecho model host as a custom OpenAI-compatible provider.

## Commands

```sh
npm ci            # wrapper dependencies (Electron)
npm test          # provisioning and lifecycle tests (plain Node)
npm run dev       # run the wrapper against the vendored template
npm run package:macos [-- --release]
```

## Not included yet

- `rein os factory` CLI verbs (setup/start/stop/status/open) and kit
  staging — the next increment.
- Offline dependency bundle in the .app (today the one-time `npm install`
  needs network).
- Linux/Windows packaging and the Dareecho OS service unit.

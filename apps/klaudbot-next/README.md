# klaʊdbot

One product. Next.js field console for the [rein-agent](https://github.com/Zermo/rein-agent) klaud harness.

This tree is the UI (`apps/klaud` replacement). The server gate is `rein serve`. Credentials stay on the host — never in this repo.

## Server gate (harness)

From a rein-agent checkout, Node 18+:

```sh
node bin/rein.js serve --port 4317 --host 127.0.0.1
```

- `/` and `/health` are open. `/health` should read `{"ok":true,"name":"rein-klaud"}`.
- Every other API route needs the serve bearer. The CLI writes it under `$REIN_HOME/klaud/` (default `~/.rein/klaud/`). Do not copy that file into git, Slack, or the browser bundle.
- Identity the model actually follows is `$REIN_HOME/klaud/identities/<BotName>.md` (20k cap). Soul / directive / loops in this UI upsert a marked block into that file.

LAN bind is opt-in (`--host <private-ip>`). Put Authelia (or equivalent) on API paths at the edge; leave `/`, `/_next/*`, and `/health` public.

## UI

Node 24+.

```sh
cp .env.example .env.local
npm ci
npm run build
KLAUD_ORIGIN=http://127.0.0.1:4317 npm start
```

Listens on `KLAUD_BIND_HOST:KLAUD_PORT` (default `127.0.0.1:4322`).

```sh
npm run typecheck
npm test
```

## What is not in this repo

- Serve tokens, Authelia secrets, Apple / TestFlight keys, model API keys
- House Caddy, LaunchAgents, or live identity files
- A native iOS build (Save/Share already speaks `window.klaudNative` / `webkit.messageHandlers.klaud` for a later port)

Rollback for a reverse-proxy edge that already points at klaud: send everything to the serve port.

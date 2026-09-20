# HANDOFF.md — Zai / klaʊdbot Next sandbox

One product: **klaʊdbot**. Not a sibling name. This tree is the merged sandbox
replacement for `apps/klaud` (Grok Build UI layout + Codex Ultra API fidelity).
Harness on thebrain stays. **Do not Caddy-cut. Do not touch live :4317.**

## Start

```sh
cd /Users/portal/Projects/klaudbot-next-ultra
npm ci
npm run build
KLAUD_ORIGIN=http://10.0.0.56:4317 npm start
```

- Listen: **127.0.0.1:4322** (loopback only, this sandbox Mac).
- If this Mac cannot dial the LAN origin, `KLAUD_ORIGIN=https://openbot.zermo.org npm start` is connectivity proof only — no Authelia session, no bearer from disk, no impersonation.
- Catch-all Next proxy (not naive `rewrites()`) forwards `/state` `/run` `/bots` `/inspect` `/settings` `/health` `/prefs` `/activity` `/runs/*` to `KLAUD_ORIGIN` (default `http://10.0.0.56:4317`). SSE `/run` is unbuffered, no gzip, no idle socket timeout.
- Static Next assets (`/`, `/_next/*`, `/index.html`, public files) stay on Next. Authelia is **not** applied to them.

Package name is `klaudbot`. Title is `klaʊdbot`. Do not rename the product.

Grok Build sandbox (`/Users/portal/Projects/klaudbot-next-sandbox`, :4320) and the read-only harness snapshot (`klaudbot-next-ultra-reference`) are inputs. This tree is the merge.

## Future Caddy sketch — DO NOT APPLY

Keep live `openbot.zermo.org` on `reverse_proxy 10.0.0.56:4317` until Tom says `go next shell` **and** LAN proof below is green.

When (later) Next listens elsewhere than :4317:

```caddyfile
# ILLUSTRATIVE. Not loaded. Preserve TLS, cookie domain, Authelia policy.
# API + health stay on klaud serve. Authelia on API only. Static Next public.

@klaud_api path /state /run /bots /bots/* /prefs /settings /activity /runs/* /inspect /inspect/*
handle @klaud_api {
	# Existing Authelia forward_auth to 10.0.0.47 /api/authz/forward-auth
	# Host auth.zermo.org; copy Remote-User / Remote-Email; X-Forwarded-URI /
	reverse_proxy 10.0.0.56:4317 {
		flush_interval -1
		dial_timeout 10s
	}
}

handle /health {
	reverse_proxy 10.0.0.56:4317
}

handle {
	# No Authelia: /, /index.html, /_next/*, public CSS/JS/icons
	reverse_proxy 127.0.0.1:4322
}
# No encode gzip/zstd on /run SSE. No read_timeout / write_timeout on API dials.
```

## Rollback

`reverse_proxy 10.0.0.56:4317` for everything (current live). This sandbox did not change Caddy.

## Proof gates (before any live switch)

1. `GET http://10.0.0.56:4317/health` with `Host: 10.0.0.56:4317` → `{"ok":true,"name":"rein-klaud"}`
2. UI title `klaʊdbot`
3. Sign in → `https://auth.zermo.org/`
4. Path spine visible (2px `#f4ead4` left rule + ticks)
5. CRT text `#f4ead4` on `#12100e` readable in night and light
6. Chat column is ledger → composer (nothing between)

No tokens in git or Slack. No LaunchAgent. No Caddy `/load`.

## Tom approval — 2026-09-20

Tom: `approve` in the Zai Slack thread (sandbox merge).

Approved: this tree is the single klaʊdbot Next sandbox (Grok UI + Ultra API). Product name stays klaʊdbot.

**Not approved / not applied:** Caddy cut, `go next shell`, LaunchAgent, token mint/rotation, public listener change. Live origin remains `reverse_proxy 10.0.0.56:4317` for everything.


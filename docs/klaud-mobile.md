# Rein Klaud mobile gateway

The mobile gateway lets a native Rein Klaud client use the agent that is already
running on an operator-controlled computer. The host keeps the model session,
tools, approvals, durable history, and long-running work. The phone is a client;
locking it or moving it into the background does not cancel the host run.

The gateway is separate from the desktop bridge. Plain `rein serve` remains
loopback-only and keeps its existing endpoints and disconnect behavior.

## Start it on a private interface

Choose the numeric address of the interface the phone can reach:

```sh
rein serve --mobile --host 192.168.50.12 --port 4318
```

Port `4318` is the mobile default. Pass `--port 0` explicitly when an ephemeral
port is useful for testing. Plain `rein serve` continues to choose an ephemeral
loopback port by default.

Rein accepts loopback, RFC 1918 private IPv4, IPv4 link-local, RFC 6598 private
mesh, IPv6 ULA, and IPv6 link-local addresses. It rejects hostnames, wildcard
addresses such as `0.0.0.0` and `::`, and public addresses. The bind address is
required; there is no network-facing default.

Every route, including health and discovery metadata, requires the bearer token.
The first start creates a mode-`0600` token under `$REIN_HOME/klaud/`. The same
host and port reuse that device credential across restarts. Delete that token
file while the gateway is stopped to revoke paired clients and create a new
credential at the next start.

The gateway serves HTTP on the selected private interface. Carry it over a
trusted encrypted private mesh, or put TLS in front of it before sending a bearer
credential across an untrusted network. Do not publish the port to the internet.

When a private-mesh TLS proxy gives the gateway a public-suffix DNS name, trust
that one origin explicitly while retaining the private numeric bind:

```sh
rein serve --mobile --host 100.100.10.8 --port 4318 \
  --trusted-origin https://rein.mesh.example
```

`--trusted-origin` accepts one exact HTTPS origin with no credentials, path,
query, fragment, or wildcard. The gateway then accepts that HTTP `Host` and
`Origin` through the private proxy. Configure the proxy to preserve both headers.
This option does not permit Rein itself to bind a public or wildcard address.

## Local discovery

An enabled non-loopback gateway makes a best-effort mDNS advertisement:

```text
service: _rein-klaud._tcp.local
TXT:     path=/v1/mobile
TXT:     version=1
```

macOS uses its built-in `dns-sd` proxy registration and publishes the selected
bind address. Linux uses `avahi-publish-address` plus
`avahi-publish-service` when Avahi is installed. Both platforms publish the same
address-derived `.local` hostname, so the service resolves to the configured
private interface and the gateway can authorize its exact Host value.
Avahi cannot publish a scoped IPv6 address containing `%interface`, so Rein
skips Linux discovery for that bind rather than announcing an unusable service;
connect with the printed scoped URL instead.
Cross-platform publication is not claimed on systems without those facilities:
they work by explicit address. Discovery failure never stops the gateway. Use
`--advertise=false` to disable publication. The bearer token is never advertised.

## Version 1 HTTP contract

All paths live under `/v1/mobile` and require
`Authorization: Bearer <token>`. JSON writes require
`Content-Type: application/json`.

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/v1/mobile` | API version and capability names |
| `GET` | `/v1/mobile/health` | Authenticated gateway health |
| `GET`, `POST` | `/v1/mobile/state` | Read or patch the shared Klaud shell |
| `GET`, `POST` | `/v1/mobile/bots` | List or create bots |
| `GET` | `/v1/mobile/bots/:botId/messages?before=:cursor` | Read paged durable history |
| `POST` | `/v1/mobile/prefs` | Save the selected bot preference |
| `POST` | `/v1/mobile/runs` | Start detached host work; returns `202` and a mobile run ID |
| `GET` | `/v1/mobile/runs/:runId` | Run status, cursor window, and pending actions |
| `GET` | `/v1/mobile/runs/:runId/events?after=:sequence` | Replay and follow numbered AG-UI events |
| `POST` | `/v1/mobile/runs/:runId/cancel` | Request cancellation; returns `202` |
| `POST` | `/v1/mobile/runs/:runId/approvals/:actionId` | Answer `{ "allow": true | false }` |
| `POST` | `/v1/mobile/runs/:runId/tools/:callId` | Answer `{ "result": "...", "isError"?: boolean }` |

Start a run with the same logical fields as the desktop surface:

```json
{
  "runId": "4d47ff0e-d50f-46e8-bf85-59e93279f859",
  "threadId": "mobile-thread-1",
  "botId": "klaud-bot-example",
  "message": "Continue the current task",
  "tools": []
}
```

Native clients should create and persist a lowercase UUID in `runId` before they
send the request. Repeating the same request with that ID returns the existing
run instead of starting a second one. Reusing the ID with different input returns
`409`. Older clients may omit `runId` and let the gateway create it.

The iOS console also journals the exact request in a per-origin, protected local
file before sending. It removes that file after a validated `202` or a confirmed
terminal outcome. If later status lookup returns `404`, the client must not infer
that the request was never executed: an intervening gateway restart can erase
the in-memory receipt. Rein therefore requires an explicit **Retry same request**
or **Discard** choice and never sends the journaled request to another origin.
Discard removes only the local retry copy, checks for an already accepted run,
and does not send a cancellation.

Full event buffers are kept for the latest 64 runs. When an older terminal run
leaves that window, the gateway retains a lightweight receipt for 30 days and up
to 16,384 evictions. A matching retry returns the terminal receipt and a
`rein.run.done` stream without executing again; durable bot history supplies the
finished transcript. Once either the age or capacity limit is exceeded, clients
must treat that run ID as expired.

The response contains `runId`, `eventsUrl`, and `statusUrl`. The mobile run ID is
the only run identifier exposed by this API; gateway-internal bridge IDs are not
part of the contract.

At most eight detached runs may be active at once, and one thread may have only
one active run. Admission returns `429` or `409` before starting extra work.

### Resumable events

The event route uses server-sent events. Each AG-UI event has an SSE `id` and a
JSON envelope with the same monotonically increasing sequence:

```text
id: 17
event: rein.run.event
data: {"sequence":17,"event":{"type":"TEXT_MESSAGE_CONTENT","delta":"..."}}
```

Reconnect with `?after=17` or `Last-Event-ID: 17`. Query text takes precedence
when both are supplied. The gateway replays records after the cursor, then keeps
the socket open for new records. Closing this socket removes only that
subscription; the host-side run continues. A terminal stream ends with
`rein.run.done`.

The retained window is bounded to 10,000 events and approximately 8 MiB per run.
A cursor older than `oldestSequence - 1` receives `410`; a cursor ahead of
`lastSequence` receives `409`. The client can reload durable bot history if its
event cursor has expired.

### Pending work after reconnect

`GET /v1/mobile/runs/:runId` returns a `pending` array while the runner is waiting:

```json
{
  "id": "action-id",
  "kind": "approval",
  "tool": "write",
  "summary": "{\"path\":\"notes/example.md\"}"
}
```

Frontend tools use `kind: "tool"` and may include their validated `args`. A
reconnected client routes the answer through the matching approval or tool URL.
Unanswered approvals and frontend tools remain recoverable for 30 minutes and
then fail closed on the host.
Late, duplicate, expired, and cross-run answers return `404`. Cancellation and
gateway shutdown reject pending work through the existing runner abort path.
If the private bridge accepts cancellation but its response is lost, the mobile
request returns `502` with an unknown-outcome message. Keep the run ID and retry
or query its status; the eventual host event remains authoritative and an
accepted cancellation is reported as `cancelled`.

The stream reuses Rein's public AG-UI mapping for text, tool calls, tool results,
state snapshots, state deltas, and terminal outcomes. Private model reasoning is
not serialized.

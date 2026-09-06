# rein-klaʊd for iPhone and iPad

rein-klaʊd is a native SwiftUI operator console for a Rein host. The agent
loop, model connection, shell tools, durable sessions, and optional autonomy
helper keep running on the host. Closing the app or locking the phone does not
stop an active host run; the app reconnects to its numbered event stream when
it returns.

The app carries the same field-guide interface as the desktop console: cream
paper, charcoal rules, rust controls, terminal-green tool records, numbered
transcript entries, and short vintage-computer sound cues. Messages identify
the operator, agent reply, and tool execution in text as well as color.

## Start the mobile gateway

The mobile gateway is separate from the normal loopback-only desktop bridge.
Enable it on an interface that the phone can reach, replacing the example
address with a private address on that host:

```sh
rein serve --mobile --host 192.168.50.12 --port 4318
```

The mobile default is port `4318`; `--port 0` explicitly requests an ephemeral
test port.

Rein prints the gateway URL and the private file containing its reusable
bearer token. The token file is readable only by the local user. Keep that
terminal or service running while using the mobile app.

On a LAN, tap **Find Rein nearby** in the app. Discovery is user initiated and
uses the `_rein-klaud._tcp` Bonjour service; it does not scan the subnet. Enter
the address manually when Bonjour cannot cross a mesh network.
On Linux, also enter the printed URL for a scoped link-local IPv6 bind because
Avahi cannot advertise an address containing `%interface`.

Use plain HTTP only for a private numeric IP, a scoped link-local IPv6 address,
or a `.local` name. Use HTTPS for every other DNS or mesh name. When a reverse
proxy or mesh gateway changes the hostname, add that exact HTTPS origin to the
host command as described by `rein serve --help`.

## Connect the app

1. Open rein-klaʊd on the iPhone or iPad.
2. Choose a discovered LAN host or enter the gateway origin.
3. Copy the bearer token from the path printed by the host command.
4. Leave **Vintage console sounds** on, or turn it off before connecting.
5. Tap **Connect to Rein**.

The app saves the gateway origin in its local preferences and puts the bearer
token in the iOS Keychain with this-device-only protection. It does not write
the token to logs.

## Work from iOS

Choose or create a bot, open Chat, and send a request. The transcript streams
from the host. Tool calls have their own ledger rows, and actions covered by
Rein's approval policy open a native allow-or-deny alert. Settings for Night
mode, density, signal color, sidebar, and activity visibility stay synchronized
with the host.

If the connection drops, the host keeps the run alive. The app reconnects with
an event cursor and recovers pending approvals when it becomes active. Use
**Stop** to cancel a run deliberately.

## Build from source

The source lives in `apps/klaud-ios` and has no third-party runtime packages.
Install Xcode 26 and XcodeGen, then run:

```sh
cd apps/klaud-ios
./scripts/build.sh
./scripts/test.sh
```

Choose an Apple Developer team through the `REIN_APPLE_TEAM_ID` environment
variable when archiving. Release metadata and the App Store Connect CLI upload
script live under `apps/klaud-ios/AppStore`; account identifiers and signing
credentials stay outside the repository.

## Support

For app issues, setup help, feedback, or feature requests, use the public
[Rein support issue tracker](https://github.com/Zermo/rein-agent/issues/new).
Include the Rein version and iOS version, but never paste a bearer token, API
key, private host address, or raw session export.

Read the [rein-klaʊd privacy page](https://github.com/Zermo/rein-agent/wiki/Rein-klaud-privacy)
or return to [Install](https://github.com/Zermo/rein-agent/wiki/Install).

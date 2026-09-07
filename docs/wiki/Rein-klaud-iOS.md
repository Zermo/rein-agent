# rein-klaʊd for iPhone and iPad

rein-klaʊd is a native SwiftUI operator console for a Rein host. The agent
loop, model connection, shell tools, durable sessions, and optional autonomy
helper keep running on the host. Closing the app or locking the phone does not
stop an active host run; the app reconnects to its numbered event stream when
it returns. The app can also talk directly to a saved API account for text
assistance without a reachable Rein host.

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

## Connect an API account

Open **Accounts** and choose **API accounts**. Enter an account name, API base
URL, exact model ID, and API key, then tap **Save API account**. Supported direct
providers are self-hosted OpenAI-compatible servers, OpenAI, Anthropic, Gemini,
xAI, and OpenRouter. Private self-hosted servers can use a key or accept requests
without one. Public endpoints require HTTPS.

Tap **Use for direct chat** to send a message directly from the phone. The reply
identifies the account and model used. Direct conversation provides text
assistance; host tools, command execution, and background autonomy still need a
Rein host. API keys stay in this device's Keychain, scoped to their account and
endpoint. Changing an endpoint never transfers its saved key.

**Use this API on connected host** sends the selected endpoint, model, and key
to that host for its next run. This button is available for the host's supported
API adapters. Anthropic accounts support direct chat only.

## Authorize a cloud subscription

Subscriptions use an official CLI on a reachable Rein host. Install Codex,
GitHub Copilot, or Grok Build there, then connect the app to that host. In
**Accounts > Cloud subscriptions on this host**:

1. Tap **Authorize** beside the available CLI.
2. Tap **Open device authorization** and complete the provider's verification
   page on the phone. Enter the one-time code when requested.
3. Return to the app and wait for sign-in to complete.
4. Leave the CLI model as `default` or enter a model your account can access,
   then tap **Use on host**.

ChatGPT uses Codex device authorization, GitHub Copilot uses Copilot device
codes, and eligible Grok subscriptions use Grok Build device authorization.
Claude and Gemini use API keys in this app. The provider determines account
eligibility, available models, and usage limits.

The official CLI keeps its tokens on the selected host in Rein's isolated
profile. The phone receives the verification URL, one-time code, and status.
Sign-in does not open a browser on the host. If a CLI cannot provide a supported
device challenge, update it or run `rein login <provider>` in a terminal there.
These subscriptions require that host to stay reachable; add another Rein host
if you want a reserve route with its own CLI accounts and tools.

Update Rein on the host if the app asks for a newer account-setup API. A host
started with provider or model environment overrides may need its launch
configuration changed before the app can select a different provider.

## Keep a reserve connection

**Use saved fallbacks when a connection fails** is off by default. Add backup
Rein hosts and API accounts, then enable it if you want automatic routing when
a connection fails.

Before a new host request is sent, the app checks the primary host. If it is
unavailable, it tries backup hosts in the saved order. A backup has its own
sessions, so review its selected agent and send the retained draft yourself.
The primary host stays saved for reconnecting. If no backup connects, a saved
API account can answer directly from the phone. Direct requests may try other
saved API accounts after eligible network, rate-limit, or service failures.
Cloud API requests can incur charges and subscription requests use the
provider's allowance.

Fallback never resends an accepted host run or a request whose delivery is
unknown. The original host keeps that run and its pending approvals. The app
can reconnect to it later. A different host never receives its pending IDs or
saved retry request.

**Include recent visible messages in direct fallback** is also off by default.
Enable it to include recent operator and assistant text when starting a direct
fallback conversation. It excludes tool results, tool-call messages, and unsent
optimistic messages. The text goes to the selected API provider. Direct
transcripts are saved in protected files on the phone and excluded from device
backups. **New conversation** opens an empty direct conversation.

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

# klaʊdbot for iPhone and iPad

This is the native SwiftUI operator console for Rein. The agent loop, model,
shell tools, durable sessions, and headless autonomy stay on the operator's Rein
host. The iOS app connects to the opt-in mobile gateway, renders current work,
and carries explicit operator approvals. Suspending or disconnecting the app
does not cancel a host run. The app also supports direct API conversations
when a host is unavailable or the operator chooses an API account.

The interface follows the same Rein field guide as the desktop app: cream paper,
charcoal rules, rust actions, mustard activity, terminal-green tool records,
condensed headings, and a numbered transcript ledger. Every exchange identifies
`OPERATOR INPUT`, `klaʊdbot / AGENT REPLY`, or `TOOL CALL / EXEC`. Light and Night
themes, density, signal color, and activity settings follow the shared host
state. Eight short 48 kHz PCM cues reproduce the desktop cue frequencies and
timing without a runtime dependency. Sounds are on by default and the switch is
stored only on the device.

The checked-in [branding previews](../../docs/branding.md#product-previews)
include the iPhone live-run capture alongside the desktop and Dareecho assets.
Use them as the visual reference for changes; static rain and activity color
must never imply a host run is active.

An exact first-line `[RESULT]`, `[OPINION]`, `[CHOICE]`, `[CHANGE]`, or `[EDIT]`
marker becomes part of the visible reply label and is removed from the message
body. Near matches remain ordinary text. Completion rows show only the model
stop reason and reasoning-token count reported by the provider; private thought
content is never requested or rendered.

## Requirements

- Xcode 26 with the iOS 26 simulator runtime
- XcodeGen (`brew install xcodegen`)
- For host tools and CLI subscriptions, a Rein host reachable from the device
  through the same LAN, a private mesh, or an HTTPS gateway
- For direct chat, a reachable self-hosted API or a supported cloud API account

No third-party runtime packages are used. XcodeGen creates the project from
`project.yml`.

## Start the host

Choose a numeric private interface address that the phone can reach:

```sh
rein serve --mobile --host 192.168.50.12 --port 4318
```

Port `4318` is used when `--port` is omitted. Pass `--port 0` only when an
ephemeral test port is intentional.

The command prints the gateway URL and the path to its reusable bearer token.
The gateway advertises `_rein-klaud._tcp` on a local network when the platform
supports it. Discovery begins only after the user taps **Find Rein nearby**;
the app never scans subnets. Bonjour normally does not cross a private mesh, so
enter the mesh address manually there.
Linux Avahi discovery is also skipped for scoped link-local IPv6 binds because
Avahi cannot publish the `%interface` address; use the printed scoped URL.

Use HTTP only with a numeric private address or a `.local` name. A scoped IPv6
link-local address uses the escaped zone form, such as
`http://[fe80::1%25en0]:4318`; scoped ULA and public IPv6 addresses are refused.
Use HTTPS for every other DNS or mesh name, including unqualified hostnames and
public-suffix mesh names such as `.netbird.cloud` and `.ts.net`. The token is stored with
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` in Keychain and is not logged.

## API accounts and cloud subscriptions

Open **Accounts** to save a named endpoint, model ID, and API key. Direct chat
supports OpenAI Chat Completions-compatible self-hosted servers, OpenAI, Gemini,
xAI, OpenRouter, and Anthropic's Messages API. A private self-hosted server can
use an API key or accept requests without one. Public API endpoints require
HTTPS. API keys are scoped to the account and endpoint in this device's Keychain.
Editing an endpoint never carries its old key to the new address.

Choose **Use for direct chat** to send text from the phone to that API. Direct
conversation has no host tools, filesystem access, or background autonomy.
For supported host API adapters, **Use this API on connected host** explicitly
sends the endpoint, model, and key to that host for new runs. Anthropic direct
accounts cannot be selected as a host API adapter.

To use a subscription, connect to a Rein host and open **Cloud subscriptions on
this host**. Install its official CLI on that host first:

| Account | CLI installation on the host | Device sign-in |
| --- | --- | --- |
| ChatGPT through Codex | `npm install -g @openai/codex` | `codex login --device-auth` |
| GitHub Copilot | `npm install -g @github/copilot` | `copilot login --device-code` |
| Eligible Grok subscription | `npm install -g @xai-official/grok` | `grok login --device-auth` |

Tap **Authorize**, open the verification page on the phone, and approve the
provider's challenge. Rein runs the official CLI with its isolated profile on
the selected host. The app receives only the verification URL, one-time code,
and status. The CLI manages its credentials on that host. After sign-in, enter
a CLI model or leave `default`, then tap **Use on host**. This changes new runs;
existing runs keep their current provider. Claude and Gemini use API keys in
this app. Subscription eligibility and usage limits belong to each provider.

Mobile account setup requires an updated Rein host. Host launch environment
variables can override saved settings; the app reports those conflicts rather
than saving an ineffective provider selection. A CLI that requires a terminal
must be updated or authorized with `rein login <provider>` on that host.

## Fallback and local conversation storage

**Use saved fallbacks when a connection fails** starts off. When enabled, a
read-only check before a new host request tries saved backup hosts in order if
the primary host is unavailable. A different host has its own agents and
sessions, so the draft stays in the composer for review before sending there.
If no backup connects, a saved API account can answer directly on the phone.
The primary host remains saved for reconnecting later.

An accepted run or a request with unknown delivery stays tied to its original
host. Fallback never replays that request on another host or provider. Direct
chat requests may try other saved API accounts after eligible connection,
rate-limit, or service failures when automatic fallback is enabled. These
API calls can incur charges. Backup hosts using CLI subscriptions consume the
provider's allowance.

**Include recent visible messages in direct fallback** also starts off. When
enabled, it copies up to 20 recent operator and assistant messages into a new
direct conversation, excluding tool results, tool-call messages, and unsent
optimistic messages. Existing direct conversation history remains separate from
host history. **New conversation** starts an empty direct conversation.

The app saves direct transcripts in protected Application Support files and
excludes them from device backups. Account names, endpoints, and preferences
stay in local settings. Keys and gateway tokens stay in Keychain. Gateway bearer
tokens and host CLI credentials are never included in direct provider requests.

## Build and test

```sh
./scripts/build.sh
./scripts/test.sh
```

Both default to the iPhone 17 Pro simulator. Override the destination when
needed:

```sh
REIN_IOS_DESTINATION='platform=iOS Simulator,name=iPad Pro 13-inch (M5)' ./scripts/build.sh
```

The tests cover private/public URL policy, split and CRLF SSE frames, resumable
mobile event envelopes and replay cursors, shell and transcript reduction,
explicit reply markers, reported completion metadata, the Keychain storage
abstraction, account and endpoint validation, direct API protocols, fallback
routing, protected direct transcripts, and the device-local sound preference.

## Signing

The proposed bundle identifier is `org.zermo.rein-klaud.ios` and the display
name is `klaʊdbot`. No personal team identifier is committed. In Xcode, choose
the intended Apple Developer team under **Signing & Capabilities**, or provide
it to `xcodebuild` as a build setting:

```sh
xcodebuild -project ReinKlaud.xcodeproj -scheme ReinKlaud \
  -destination 'generic/platform=iOS' \
  DEVELOPMENT_TEAM="$REIN_APPLE_TEAM_ID" archive
```

The App Store icon is an opaque 1024-pixel export of the approved Rein desktop
icon. `PrivacyInfo.xcprivacy` declares no tracking or collected-data categories;
it covers UserDefaults for the device interface preference and system uptime for
the short interval between local sound cues. Review those declarations whenever
telemetry or another data flow is added.

## Mobile transport

Host requests use `/v1/mobile`; direct API requests use the selected provider
endpoint. Authenticated `/accounts` routes expose safe provider settings and
manage bounded official-CLI device sign-ins. They never return stored API keys
or raw CLI output. Before `POST /runs`, the app saves the exact
request in Application Support with complete iOS file protection and backup
exclusion. The queue holds at most 16 gateway origins and expires unconfirmed
requests after 24 hours. A status hit reattaches without another POST. A status
`404` never resends silently because a restarted gateway may have forgotten work
that already produced effects; the console instead offers **Retry same request**
and **Discard**. Explicit Retry uses the original client-generated ID and exact
tool declarations. Discard removes only the saved retry, checks whether that run
already exists on the host, and does not send a cancellation. A validated `202`
removes the protected request and then the client subscribes to numbered events
with `after=<sequence>`.
The host owns the backend stream, so losing an iOS subscriber does not interrupt
the task. When the app becomes active, it queries run status and reconstructs
pending approvals. Frontend tools are acknowledged on both success and failure,
preventing the host from waiting on a malformed local request.

`ReinGatewayClientProtocol` is the transport boundary. Views and reducers do not
construct routes, which keeps later mobile API revisions contained in one file.

## Accessibility

Text uses Dynamic Type-relative fonts, controls keep a 44-point minimum target,
role and status labels are available to VoiceOver, and Reduce Motion replaces
the transcript scroll animation with an immediate update. Color and sound repeat
information already present in text.


## Bot identity and guided setup

klaʊdbot is the new visible name. The existing bundle ID, Keychain services, Bonjour service, and preference keys stay unchanged so installed copies retain their settings.

Onboarding offers a Rein host or a direct model account. A saved host stays available for reconnection. After the first successful link to a host, setup lists its existing bots and offers a name and avatar for a new one. Completing this step is remembered separately for each host. The iOS app can discover advertised gateways; it does not inspect another computer’s filesystem or migrate a desktop installation.

Every bot has a vintage headwear avatar: Aviator, Rider, Builder, Slugger, Medic, or Explorer. Existing bots without an avatar get the same stable selection as the desktop app. The picker saves appearance to the gateway, so it follows that bot on other clients. It leaves sessions, model settings, and permissions unchanged.

During reported work, the native Canvas portrait moves continuously with the same procedural sway, bob, eyewear lag, and independent eyebrows as desktop. Each bot's ID seeds its cadence. Public gateway progress distinguishes thinking, replies, tool execution, note writing, and autonomy work; no private thought content is inspected. The expression stays with the running bot when the operator selects another one. Ready, approval, and error states settle to still portraits. The animation timeline stops when settled, outside its scroll viewport, off screen, or while the app is inactive. Reduce Motion renders a static expression immediately.

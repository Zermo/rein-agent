# rein-klaʊd for iPhone and iPad

This is the native SwiftUI operator console for Rein. The agent loop, model,
shell tools, durable sessions, and headless autonomy stay on the operator's Rein
host. The iOS app connects to the opt-in mobile gateway, renders current work,
and carries explicit operator approvals. Suspending or disconnecting the app
does not cancel a host run.

The interface follows the same Rein field guide as the desktop app: cream paper,
charcoal rules, rust actions, mustard activity, terminal-green tool records,
condensed headings, and a numbered transcript ledger. Every exchange identifies
`OPERATOR INPUT`, `REIN / AGENT REPLY`, or `TOOL CALL / EXEC`. Light and Night
themes, density, signal color, and activity settings follow the shared host
state. Eight short 48 kHz PCM cues reproduce the desktop cue frequencies and
timing without a runtime dependency. Sounds are on by default and the switch is
stored only on the device.

An exact first-line `[RESULT]`, `[OPINION]`, `[CHOICE]`, `[CHANGE]`, or `[EDIT]`
marker becomes part of the visible reply label and is removed from the message
body. Near matches remain ordinary text. Completion rows show only the model
stop reason and reasoning-token count reported by the provider; private thought
content is never requested or rendered.

## Requirements

- Xcode 26 with the iOS 26 simulator runtime
- XcodeGen (`brew install xcodegen`)
- A Rein host reachable from the device through the same LAN, a private mesh,
  or an HTTPS gateway

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
abstraction, and the device-local sound preference.

## Signing

The proposed bundle identifier is `org.zermo.rein-klaud.ios` and the display
name is `rein-klaʊd`. No personal team identifier is committed. In Xcode, choose
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

The client uses `/v1/mobile` exclusively. Before `POST /runs`, it saves the exact
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

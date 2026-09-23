# klaʊdbot

Display name: **klaʊdbot**. The app is still powered by the Rein agent harness.
The bundle id remains `org.zermo.rein-klaud`, and the installed app filename
remains `rein-klaud.app`, so existing installations and curl updates retain
their identity.

This Electron app connects to `rein serve`. The server runs the agent loop and
stores bot conversations. The React window displays that state and handles
operator approvals. The packaged Mac app includes its runtime. Node 22.18+
is required only to develop or build it from source.

Install the latest published Mac app:

```sh
curl -fsSL https://github.com/Zermo/rein-agent/releases/latest/download/install-macos-app.sh | bash
```

The installer selects Apple Silicon or Intel, verifies the release checksum,
bundle identity, architecture and code-signature integrity, then installs into
`~/Applications`. It preserves any prior valid app as a backup and refuses to
replace a running, modified, or unrelated app. Quit before updating and rerun
the same command. Add `--no-launch` after `bash -s --` to leave the app closed.
App updates preserve configuration and conversations. First-run setup can copy
an earlier Rein installation into klaʊdbot's separate home as described below.
Development releases have an ad hoc signature and are not notarized; normal
macOS approval still applies. The installer never changes system protections.

The window uses the same retro field guide design as Rein's setup guide and the
canonical R-horse mark. Light mode uses cream paper with charcoal ink. Night
mode reverses that contrast for low-light work. Vintage-computer interface
sounds are on by default, unlock after the first interaction, and can be
disabled in Settings. The sound choice stays on this device. The renderer
synthesizes each tone without audio files or an added dependency.

From this directory:

```sh
npm install
npm run dev
```

Installation downloads the platform's Electron binary through its supplied
`install-electron` command. It does not start the app or a server.

The first launch opens assisted setup. It checks `~/.rein`, or the `REIN_HOME`
supplied when launching the app, for an existing harness. Inspection returns
only setup flags and counts; it starts no model discovery, gateway, or autonomy
service. When a previous installation is found, choose:

- **Bring my Rein with me:** copy model configuration and its saved credentials,
  supported CLI sign-in files, operator documents, notes, and saved conversations
  into `~/.klaudbot`. Existing bot conversations keep their session identity;
  other eligible conversations appear as imported-session bots.
- **Start fresh:** create a separate `~/.klaudbot` home without copying the
  earlier connection, credentials, or conversations.

Both choices preserve the source Rein home. Migration copies an explicit set of
private files; it does not move the source, copy running-process tokens and
locks, or enable background services. An interrupted setup can resume, while an
unrelated existing `~/.klaudbot` directory is preserved rather than overwritten.

After choosing a starting point, the app starts its local gateway and guides
the operator through:

1. **Connect a model.** Keep the migrated connection or configure a self-hosted
   API, cloud API key, or supported official subscription CLI. Finding running
   model servers and including known LAN or mesh peers are explicit actions.
   A connection check verifies the model list; the first sent message checks
   generation. Model setup can be deferred.
2. **Make it yours.** Keep an existing work-style profile or choose communication,
   pacing, examples, and listening preferences. Everyday assistance is included.
   Suggested native skills are optional. Review the turn budget and autonomy
   iteration limit; changing these limits does not enable autonomy.
3. **Meet your bot.** Continue an imported bot or create one with a name and
   avatar. A suggested first task fills the message box without sending it.

The model setup page also offers **Inspect this computer** and **Inspect saved
model host**. The latter uses the saved SSH connection to run the shipped,
read-only hardware probe through standard input; the host needs Node.js 18 or
newer, but Rein is not installed there by the check. The report identifies which
machine was measured, available memory, GPU memory sharing, serving CLIs on PATH,
and recognized server process names. It does not read process arguments.
Model-fit rows are catalog estimates at 16,384 context tokens and one concurrent
request, not a benchmark of the configured model. An API URL without an SSH
connection cannot supply the remote hardware report. No serving software or
models are installed or started by inspection.

The local gateway uses `~/.klaudbot/workspace` as its writable working directory,
including during source development. Packaged apps launch the embedded Rein
bundle; source runs use the checkout's `dist/rein.js`, or `bin/rein.js` when that
bundle is absent. Rebuild the root bundle after changing harness source. The
gateway runs on an ephemeral loopback port, and the app privately reads its
token from `~/.klaudbot/klaud/serve-<port>.token`. Tokens stay in the main process
and are not logged or sent to the renderer.

For an app-owned gateway, `REIN_HOME` selects the migration source, not the new
klaʊdbot home. Model-routing and API-key environment overrides are stripped
before launching that gateway; use assisted setup or `~/.klaudbot/config.json`
to configure it. This prevents a fresh setup from silently inheriting the old
connection. Neither packaged nor source runs write user work into the app bundle
or the source checkout.

After the local first-run setup is complete, an existing server can be
supplied when launching the app. If the connection fails, the connection
screen also offers **URL + token**. Run
`rein serve` in another terminal, then:

```sh
REIN_KLAUD_URL=http://127.0.0.1:4317 \
REIN_KLAUD_TOKEN="$(cat "$HOME/.rein/klaud/serve-4317.token")" \
npm run dev
```

Replace the example port with the URL printed by your server. Use the matching
token path if that server uses another `REIN_HOME`. `REIN_KLAUD_URL` and
`REIN_KLAUD_TOKEN` select that external gateway on subsequent app launches;
they do not bypass first-run setup. Only plain HTTP on `127.0.0.1`
with an explicit port is accepted. Model APIs are accessed by the gateway.

`npm run build` produces the renderer in `dist/` without launching the app.
`npm start` launches an already built app. `npm test` runs local state and
transport checks without a model server. This package has its own dependencies
and lockfile; it does not add dependencies to the Rein CLI package.

Closing the window hides it and keeps the connection and any owned local server
running. Open the tray menu or click the macOS Dock icon to return. Launching the
app again also shows the existing window. **Quit klaʊdbot** in the tray or app
menu exits the app and stops the server it started. An external server remains
owned by its launcher. The app does not install a login item or background service.

Shell settings are saved by Rein and reflected through validated AG-UI snapshots
and deltas. Invalid deltas trigger a fresh snapshot without changing part of the UI.
Normal tray mode shows run status, quiet mode keeps only Open and Quit, and hidden
mode removes the tray icon. With the tray hidden, use the Dock icon or launch the
app again to reopen it. Use the app menu to quit.

**Bash approval** defaults to **Auto** for commands within an authorized run.
Choose **Ask every time** in Settings to review each Bash call in a native dialog.
Other tool approvals and the harness's task controls still apply. The choice is
saved by the connected Rein backend, so it survives an app or server restart.

**Reasoning effort** applies to new runs. **Provider default** leaves the server's
choice unchanged. Low, Medium, High, and Off are offered only where Rein has a
compatible request mapping. A self-hosted server may ignore the field or support
only an on/off switch; its model and chat template determine what happens.
Subscription CLIs manage their own reasoning settings and expose only Provider
default here. Unsupported choices fail without saving. Higher effort may use
more tokens and time; it is not a measured accuracy or reasoning score.

Run controls are stored in the connected gateway's `$REIN_HOME/klaud/run-settings.json`
(`~/.klaudbot/klaud/run-settings.json` for the app-owned gateway). Updating them preserves the model connection,
turn and iteration budgets, and session files. Transcript view and sound choices
stay on the device. The three transcript views are:

- **Replies:** operator messages, agent replies, and failed tools.
- **Activity:** replies plus compact tool records and public progress; expand a
  record to inspect its arguments and output. This is the default view.
- **Full:** expanded tool arguments and output alongside the conversation.

Tool calls and results share one record, and each assistant turn keeps its own
reply. Completion labels show actual stop reasons and provider-reported reasoning
token counts when available. Private thought content is not displayed. These
controls retain the cream, charcoal, rust, and vintage-computer sound theme.

Every bot has a recognizable portrait: **Aviator**, **Rider**, **Builder**,
**Slugger**, **Medic**, or **Explorer**. Original vector artwork shows an invisible
person wearing rust-orange headwear and eyewear, with two expressive eyebrows;
the Medic adds a mask and stethoscope. Older bots receive a stable look based on
their ID. Choosing another avatar changes only the portrait, preserving the bot's
session and history. Hats retain their orange accent in both paper and night
themes.

Animated terminal signals identify **Thinking**, **Typing**, **Journaling**, and
tool execution from actual run events. Journaling means the durable `notes`
tool is writing or appending; reading notes remains a tool operation. Generic
**Working** covers the wait before the model reports a more specific phase.
The phase stays visible in Replies view when the activity signal is enabled.
Reduced motion replaces animation with static symbols and readable labels.
Avatar eyebrows follow those same runtime states, including waiting for approval
and errors. They represent reported activity, not inferred feelings. Ready,
approval, and error portraits settle into stillness. During work, the whole
portrait drifts, tilts, and breathes, while eyewear and brows move independently.
Each bot has a stable motion pattern; phase changes blend from its current pose.
The desktop uses the existing SVG artwork and a shared animation scheduler,
with no 3D dependency. Hidden and offscreen portraits suspend their updates;
reduced motion keeps a static expression.

**Rain effects** adds sparse pixel rain and a small cloud in a separate console
frame above the masthead. It never covers conversation or input. The device-local
switch defaults on, pauses the rain while hidden, and uses a static motif with
reduced motion. It adds no looping sound or animation dependency.

The separate **Autonomy work** signal observes an active background scan or
routine in the connected backend's home. A live owner, a running record, and its
deadline must agree; an idle daemon or stale record does not animate. The
authenticated activity check reads metadata only, starts no services or model
calls, and pauses when the app view is hidden or disconnected. An unavailable
check displays a quiet status rather than claiming the engine is working.

The main process uses authenticated `GET /state`, `POST /state`, `GET /bots`,
`POST /bots`, `PATCH /bots/:id`, `GET /bots/:id/messages`, `GET /settings`,
`POST /settings`, `GET /setup`, `POST /setup`, `POST /setup/probe`,
`POST /setup/discover`, account-setup routes, `POST /prefs`, and `POST /run`. Streaming
frontend tools and approvals use `/runs/:runId/tools/:callId` and
`/runs/:runId/approvals/:id`; Stop uses `/runs/:runId/cancel`. The renderer receives
no bearer token and cannot choose arbitrary HTTP routes or run Node.js. The
native account-sign-in action opens only validated official device-verification
URLs. Frontend tool arguments are handled as data. `patchShell` is persisted
before its acknowledgment; `setPref` is persisted by the server on acknowledgment.
`confirmAction` and native approvals require a user decision in a native dialog.

Reloading during a run replays events against its saved starting transcript. If a
long run exceeds the bounded replay cache, it keeps running. A reloaded window
shows saved messages and refreshes the transcript when the run finishes.
Saved conversations load in bounded pages; use **Load earlier messages** to read
older turns. Large individual messages show a shortened preview, with the full
record retained in Rein's session history.

The app uses the Rein field-guide computer icon for its window and Dock, plus
dedicated R-horse tray icons for ready and working states. macOS receives native
template images; Windows and Linux receive outlined field-guide colors that stay
legible on light and dark panels. See `NOTICE` for dependency licenses.

To package the committed CLI bundles and current desktop source on a Mac:

```sh
npm ci
npm run package:macos -- --arch arm64
npm run package:macos -- --arch x64
```

Each command writes `.build/rein-klaud-macos-<arch>.zip`, `.zip.sha256`, and a
`.zip.json` build report. The app includes only explicit runtime assets,
licenses and bundled skills. A headless smoke starts the embedded gateway and
checks authenticated state without a model request, local account, or window.
Cross-architecture execution uses existing Rosetta when available; otherwise
the report records that its runtime smoke did not run.

Default packages use ad hoc development signing. For notarized distribution,
set `REIN_MAC_SIGN_IDENTITY` to an installed Developer ID Application identity
and `REIN_MAC_NOTARY_PROFILE` to an existing notarytool Keychain profile, then
add `--release`. That mode requires accepted notarization and staples the ticket.
The build never submits anything to the Mac App Store.

The **Native Mac app** GitHub workflow builds both architectures from a supplied
tag. Its optional publish input uploads ZIPs, checksum files, build reports and
the curl helper to that tag's release. Those CI packages use development signing;
see [release notes](../../docs/macos-development-release.md).

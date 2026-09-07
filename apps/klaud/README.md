# rein-klaʊd

Display name: **rein-klaʊd**. Bundle id: `org.zermo.rein-klaud`.

This Electron app connects to `rein serve`. The server runs the agent loop and
stores bot conversations. The React window displays that state and asks before
approving an action. The packaged Mac app includes its runtime. Node 22.18+
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
Configuration and conversations stay in their existing local directories.
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

The first window offers **Start local rein serve** or **URL + token**. Starting
locally launches the bundled Rein CLI (or the checkout's CLI during development)
as a separate process with an ephemeral port. Packaged apps use
`$REIN_HOME/workspace`, defaulting to `~/.rein/workspace`, as the writable working
directory. They do not write into the signed app. It reads the runtime token from `$REIN_HOME/klaud/serve-<port>.token`, or from
`~/.rein/klaud/` when `REIN_HOME` is unset. Tokens stay in the main process and
are not logged or saved by the app.

To use a server you already started, run `rein serve` in another terminal, then:

```sh
REIN_KLAUD_URL=http://127.0.0.1:4317 \
REIN_KLAUD_TOKEN="$(cat "$HOME/.rein/klaud/serve-4317.token")" \
npm run dev
```

Replace the example port with the URL printed by your server. Use the matching
token path if you set `REIN_HOME`. Only plain HTTP on `127.0.0.1` with an explicit
port is accepted. The app does not connect directly to model APIs.

`npm run build` produces the renderer in `dist/` without launching the app.
`npm start` launches an already built app. `npm test` runs local state and
transport checks without a model server. This package has its own dependencies
and lockfile; it does not add dependencies to the Rein CLI package.

Closing the window hides it and keeps the connection and any owned local server
running. Open the tray menu or click the macOS Dock icon to return. Launching the
app again also shows the existing window. **Quit rein-klaʊd** in the tray or app
menu exits the app and stops the server it started. An external server remains
owned by its launcher. The app does not install a login item or background service.

Settings are saved by Rein and reflected through validated AG-UI snapshots and
deltas. Invalid deltas trigger a fresh snapshot without changing part of the UI.
Normal tray mode shows run status, quiet mode keeps only Open and Quit, and hidden
mode removes the tray icon. With the tray hidden, use the Dock icon or launch the
app again to reopen it. Use the app menu to quit.

The main process uses authenticated `GET /state`, `POST /state`, `GET /bots`,
`POST /bots`, `GET /bots/:id/messages`, `POST /prefs`, and `POST /run`. Streaming
frontend tools and approvals use `/runs/:runId/tools/:callId` and
`/runs/:runId/approvals/:id`; Stop uses `/runs/:runId/cancel`. The renderer receives
no bearer token and cannot choose arbitrary HTTP routes, open remote pages, or
run Node.js. Frontend tool arguments are handled as data. `patchShell` is persisted
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

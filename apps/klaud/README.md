# rein-klaʊd

Display name: **rein-klaʊd**. Bundle id: `org.zermo.rein-klaud`.

This Electron app connects to `rein serve`. The server runs the agent loop and
stores bot conversations. The React window displays that state and asks before
approving an action. Node 22.18+ is required to install and build the Electron app.

From this directory:

```sh
npm install
npm run dev
```

Installation downloads the platform's Electron binary through its supplied
`install-electron` command. It does not start the app or a server.

The first window offers **Start local rein serve** or **URL + token**. Starting
locally launches this checkout's Rein CLI as a separate process with an ephemeral
port. It reads the runtime token from `$REIN_HOME/klaud/serve-<port>.token`, or from
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

The droplet SVG and tray bitmap are original artwork. See `NOTICE` for dependency
licenses. Packaging an installable `.app` is outside this first version; the bundle
id is recorded in package metadata and used for application identity where the
platform supports it.

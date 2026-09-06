# Terminal activity and optional NodeTerm

Rein runs in the terminal where you invoke it: Ghostty, Terminal, a NodeTerm
terminal node, or another compatible terminal. Bare `rein` keeps the current
working directory. The standard curl installer guides setup and starts
interactive Rein in that same terminal when the connection is ready.

Operator prompts are cyan and numbered. Each REIN reply advances a marker and
accent color; its number also distinguishes it without color. Messages,
thinking status, tool actions, and tool results have separate labels. Steering
input has its own operator prompt. Display updates wait while you edit that
input; the agent keeps running. Only a thinking status is displayed, not a
private reasoning trace.

## Inspect activity in the terminal

```text
/legend
/activity
/activity 3
```

The timeline numbers visible replies and tool activity. Select a numbered step
to inspect its details without opening another window. Thinking appears as a
status; provider-reported reasoning-token counts are displayed only when
available. These controls need no additional app or tmux installation.

For an explicit split view, install tmux and run `rein --visual`. Chat appears
beside a terminal activity tree. Arrow keys select steps, `f` follows new work,
and `q` closes the activity pane. `rein watch <activity-id>` reopens a terminal
view. `rein canvas <activity-id>` serves an optional canvas and prints its local
URL; only `--browser` requests a browser launch. There is no automatic browser
fallback from terminal or NodeTerm sessions.

## Review proactive suggestions here too

Use `/autonomy` for status and `/autonomy show <id>` to read a full proposal in
the current chat terminal. `/autonomy approve <id>` enables read-only checks;
add `--allow-writes` only to authorize ordinary tools, commands, and file writes
for that proposal. `/autonomy dismiss <id>` dismisses or disables it.
`/autonomy pause` and `/autonomy resume` control the background supervisor.
These commands do not open another window or enter a nested dashboard.

## Optional NodeTerm installation

If you want NodeTerm's separate native app, opt in:

```sh
curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh \
  | bash -s -- --nodeterm
```

Or install and register it after Rein is set up:

```sh
rein desktop install --no-launch
rein desktop status
rein desktop open
```

The macOS installer supports Apple Silicon and Intel, verifies the selected
release's checksum, signature, and Gatekeeper assessment, and installs into
`~/Applications`. It preserves an existing copy. Rein does not bundle or modify
NodeTerm, change the operating system's terminal association, or remove
quarantine. The `--nodeterm` installer option leaves the app closed; open it
explicitly when wanted. On other supported desktops, use
[NodeTerm's official releases](https://nodeterm.dev/releases).

Registration adds a Rein custom agent while preserving other agents and
settings. It writes settings only while NodeTerm is closed. If the app is
running, close it when convenient and rerun `rein desktop install --no-launch`.
Existing sessions are not killed to register Rein. You can run `rein` inside
an ordinary NodeTerm terminal node before registration.

NodeTerm's separate canvas still uses its own project and node controls. Those
steps are optional and are not part of Rein's normal terminal startup. Legacy
saved desktop preferences remain visible in `rein desktop status`, but bare
`rein` stays in the terminal. Use `rein desktop open` to open the native app.

```sh
rein --terminal                  # explicitly stay in this terminal
rein desktop use terminal        # save that preference
```

The preference lives in `~/.rein/desktop.json`, or your `REIN_HOME`. It is
separate from model credentials, endpoints, and session history. Installer
`--no-launch` suppresses the final interactive session; `--skip-setup` and
`--yes` also do not launch chat automatically.

## Upstream references

- [NodeTerm releases](https://nodeterm.dev/releases)
- [Settings store](https://github.com/eneskirca/nodeterm/blob/v0.3.4/src/core/settings-store.ts)
- [Agent capability definitions](https://github.com/eneskirca/nodeterm/blob/v0.3.4/src/shared/agents/config.ts)
- [NodeTerm license](https://github.com/eneskirca/nodeterm/blob/v0.3.4/LICENSE)

# NodeTerm desktop and reply identities

Rein 0.10.0 separates operator turns, agent replies, and tools in the terminal.
Operator prompts are cyan and numbered. Each REIN reply advances a quarter-circle
marker and accent color, with a reply number that also works without color.
Steering input gets its own operator prompt. Display updates wait while you edit
that input; the agent keeps running. After Enter, output resumes under the same
reply identity. Only a thinking status is displayed, not the reasoning trace.

## Native installation

The standard curl installer adds the separate official NodeTerm app on a local
macOS desktop. It supports Apple Silicon and Intel, checks the pinned release's
SHA256, verifies its signature and Gatekeeper assessment, and installs into
`~/Applications` without sudo. An existing app is preserved. Rein does not bundle
or modify NodeTerm, remove quarantine, or change the operating system's terminal
association.

The pinned release is NodeTerm 0.3.4, matching the verified
[official Homebrew cask](https://github.com/nodeterm/homebrew-tap/blob/main/Casks/nodeterm.rb).
NodeTerm manages its own later updates. On Linux or Windows, install the native
app separately from [NodeTerm's releases](https://nodeterm.dev/releases).
Remote shells and CI do not install or launch the desktop app automatically.

```sh
rein desktop install --no-launch
rein desktop status
rein desktop open
```

Registration adds a dedicated Rein custom agent and selects it as NodeTerm's
default, preserving other agents and settings. It does this only while NodeTerm
is closed, because NodeTerm caches its settings and does not watch external edits.
If the app is running, close it when convenient and rerun the install command
above. Running sessions are never killed to register an agent. You can use
`rein --terminal` in a NodeTerm terminal node before registration is complete.

## What opening Rein does

Bare `rein` in an interactive local macOS shell opens an installed NodeTerm.
Choose a project, then add an agent node; Rein is the default after registration.
NodeTerm 0.3.4 has no supported external API for launching a chosen project and
command, so that final step is manual. The launcher does not simulate a successful
session launch or silently discard command-line options.

`rein --resume ID`, model options, explicit activity options, scripts, one-shot
requests, and piped input stay in the terminal where you invoked them. Use:

```sh
rein --terminal                  # this session stays in this terminal
rein desktop use terminal        # future bare invocations stay here too
rein desktop install             # select the NodeTerm preference again
```

The preference is stored separately in `~/.rein/desktop.json`, or under your
`REIN_HOME`. Your model credentials, saved endpoint, and session history stay
intact. Updates preserve an explicitly selected terminal preference. The curl
installer also accepts `--terminal-only` and `--no-launch`.

## Default activity view

Inside a local NodeTerm session, interactive Rein records its visible activity
and opens the detailed node view automatically. When NodeTerm supplies the
current session with canvas-control capability, Rein uses its official shim to
open the view as a native web node. It never fabricates another agent identity
or borrows another node's token.

Baseless custom agents do not have that capability in NodeTerm 0.3.4, so their
detailed activity view opens in the default browser. Their chat remains a native
NodeTerm canvas node. If an authorized native embedding attempt is refused, Rein
prints the view URL without retrying through another app. `--no-browser` or
`--visual=false` skips automatic opening. A remote session does not automatically
send a remote loopback URL to the desktop.

The activity server listens only on loopback, requires its per-session capability
token for activity data, and closes when the interactive session ends. The token
is in the URL fragment. The view contains visible responses and tool activity,
not private thinking text. `--visual` remains the explicit tmux split view.

## Upstream contracts

- [Native entry point](https://github.com/eneskirca/nodeterm/blob/v0.3.4/src/main/index.ts)
- [Settings store](https://github.com/eneskirca/nodeterm/blob/v0.3.4/src/core/settings-store.ts)
- [Agent capability definitions](https://github.com/eneskirca/nodeterm/blob/v0.3.4/src/shared/agents/config.ts)
- [NodeTerm license](https://github.com/eneskirca/nodeterm/blob/v0.3.4/LICENSE)

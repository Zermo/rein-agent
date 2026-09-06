# Install Rein

You need Node.js 18 or newer, npm, Git, curl, and Bash for the installer. It supports macOS, Linux, and WSL. NodeTerm users run the same commands in a normal shell tab.

```sh
node --version
npm --version
git --version
curl --version
```

Install the prebuilt CLI, then choose a model connection separately:

```sh
curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh \
  | bash -s -- --skip-setup
rein --version
```

On a local macOS desktop, this also installs the separate official NodeTerm app
if missing. Existing apps are preserved. When NodeTerm is closed, Rein registers
itself as its default agent. If it is already running, close it when convenient
and run `rein desktop install --no-launch` to finish registration.

`--skip-setup` skips onboarding, connection checks, and app launch. Add
`--terminal-only` to skip the native app and keep Rein in your current terminal.
Other platforms, remote shells, and CI retain terminal installation.
 Existing configuration and sessions remain in `~/.rein`, or your custom `REIN_HOME`.

For native Windows, install with npm and rerun the same command to update:

```sh
npm install --global git+https://github.com/Zermo/rein-agent.git
rein setup
```

## Connect a model

For a model on this computer, start the server, load a model, and run:

```sh
rein setup
```

Rein checks localhost ports 11434, 1234, 8080, and 8000 for Ollama, LM Studio, llama.cpp, and vLLM. If discovery misses yours, choose the custom API option and enter the URL shown by your model server. For another machine, supply its reachable hostname or IP and port; Rein does not scan LAN or mesh peers.

For other routes, use [Self-hosted models](https://github.com/Zermo/rein-agent/wiki/Self-hosted-models) or [Cloud connections](https://github.com/Zermo/rein-agent/wiki/Cloud-connections).

## Make a first request

```sh
rein setup --status &&
rein --no-tools -p "Reply with the single word: ok"
```

HTTP connections should report `connection: passed`, followed by a short model reply. Subscription connections report the official CLI's authentication status; the model request checks that the connection works.

Bare `rein` opens an installed NodeTerm on a local macOS desktop. Choose a project
and add a Rein agent node; NodeTerm has no external API to launch that session
for you. In a terminal node, run `rein --terminal`. Commands with session options
stay in the terminal where you entered them. To always stay there, run
`rein desktop use terminal`.

Interactive chat has numbered OPERATOR and REIN labels with distinct colors.
Local NodeTerm sessions open the detailed activity view automatically, using a
browser when the native node cannot embed it. `--no-browser` disables that opening.
Install tmux for the explicit split view, `rein --visual`. Ordinary chat does not
require tmux.

## Update

On macOS, Linux, or WSL:

```sh
rein update && rein --version
```

Restart running Rein sessions afterward. The update preserves your settings, notes, and sessions, and your model can be offline. If an older build has no `rein update` command, rerun the curl command above.

## If setup stalls

- If `rein` is not found, open a new shell. Run `npm prefix -g` and check that its `bin` directory is on your `PATH` on macOS or Linux.
- If a reasoning model reports `no valid chat completion`, update Rein and rerun `rein setup --status`. Version 0.9.3 expanded the short connection probe for reasoning responses.
- If the installer finds edits in `~/.rein/repo`, commit or move those edits before updating. It preserves them instead of replacing the checkout.
- `Existing config found` means Rein kept saved settings. A failed connection check is a separate result.

The [field guide](https://zermo.github.io/rein-agent/) has the same installation steps with a checklist and print view.

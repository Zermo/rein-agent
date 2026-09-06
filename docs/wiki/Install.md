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

`--skip-setup` skips onboarding and connection checks. Existing configuration and sessions remain in `~/.rein`, or your custom `REIN_HOME`.

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

Move into the project you want Rein to work on and run `rein`. Install tmux if you want the chat and activity view with `rein --visual`. Ordinary chat does not require tmux.

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

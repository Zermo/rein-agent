# Install Rein

The first-run wizard helps you choose how Rein works with you, connect a model,
and make a first request. You can revise every work preference later.

## Before you begin

You need Node.js 18 or newer, npm, Git, curl, and Bash for the installer. It
supports macOS, Linux, and WSL. Open Terminal, a NodeTerm shell, or your preferred
terminal and check:

```sh
node --version
npm --version
git --version
curl --version
```

If a command is missing, install that tool before continuing. Node.js includes
npm. Download Node.js from its [official site](https://nodejs.org/en/download).

## Install and start the wizard

```sh
curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh | bash
```

Keep this terminal open. Setup reads your answers from it even though the
installer arrived through a pipe. Follow the numbered choices shown by Rein.
If you already installed Rein, start the same walkthrough with `rein setup`.

On a local macOS desktop, the installer also adds the separate official NodeTerm
app if missing. Existing apps are preserved. When NodeTerm is closed, Rein
registers itself as its default agent. If it is already running, close it when
convenient and run `rein desktop install --no-launch` to finish registration.
Other platforms and remote shells retain terminal installation.

For native Windows, install with npm, then start the wizard:

```sh
npm install --global git+https://github.com/Zermo/rein-agent.git
rein setup
```

## Tell Rein how you work

Answer four questions about the work you plan to do, how much explanation you
want, how you prefer changes handled, and where you want to talk to Rein. Setup
shows your operator profile and recommends a skill pack. Go back to change an
answer, choose another pack, or skip packs before saving.

The questions record work preferences. There are no scores for health,
intelligence, personality type, or attention span. The same answers always
produce the same recommendation. You can change it as your work changes.

Your private Rein home receives four files:

| File | What it controls |
| --- | --- |
| `SOUL.md` | Agent voice and response style |
| `USER.md` | Your work preferences |
| `AGENTS.md` | Rein's operating brief for working with you |
| `profile.yaml` | The machine-readable `operator_profile` and enabled pack |

The default location is `~/.rein`, or your custom `REIN_HOME`. Project
`AGENTS.md` files, model credentials, and saved sessions stay in place. See the
[operator-profile guide](https://github.com/Zermo/rein-agent/wiki/Operator-profile)
for pack contents and controls.

## Connect a model

Continue in the wizard. Reuse a saved connection or choose where your model
runs. For a model on this computer, start its server and load a model before
Rein checks for it. You can install
[LM Studio](https://lmstudio.ai/download) or [Ollama](https://ollama.com/download)
if you do not have a model server yet. The
[self-hosted models guide](https://github.com/Zermo/rein-agent/wiki/Self-hosted-models)
walks through serving a model.

Rein checks localhost ports 11434, 1234, 8080, and 8000 for Ollama, LM Studio,
llama.cpp, and vLLM. If discovery misses yours, choose the custom API option and
enter the URL shown by your model server. For another machine, supply its
reachable hostname or IP and port. Rein checks that address rather than scanning
LAN or mesh peers.

For a supported subscription login or API key, follow
[Cloud connections](https://github.com/Zermo/rein-agent/wiki/Cloud-connections).
Enter keys at the hidden prompt. Setup tests the selected connection and saves
it in your private `config.json`.

To revisit only this step:

```sh
rein setup --connection-only
```

## Choose whether Rein should suggest work

The final setup stage offers proactive suggestions for a folder you choose.
Choose manual scans for that folder, enroll it and start the background service,
or skip this and use ordinary chat.

Suggestions use your Rein task history and the workspace's current state.
Proposed tasks stay pending until you approve them. Background runs have fixed
budgets and can be paused. Choosing an assertive work style or a skill pack does
not grant background approval or change tool permissions.

Review and control suggestions later:

```sh
rein autonomy status
rein autonomy tui
rein autonomy pause
rein autonomy disable
```

`disable` stops and removes Rein's service while keeping reports and decisions.
The [README](https://github.com/Zermo/rein-agent#proactive-work-from-task-history)
has enrollment, budgets, and approval details.

## Make a first request

Check your saved model connection, then ask for a short reply without tools:

```sh
rein setup --status &&
rein --no-tools -p "Reply with the single word: ok"
```

HTTP connections should report `connection: passed`, followed by a short model
reply. Subscription connections report the official CLI's authentication status;
the model request checks that the connection works.

Open a folder you want to work in. Bare `rein` opens an installed NodeTerm on a
local macOS desktop. Choose that project and add a Rein agent node. In your
current terminal and directory, use `rein --terminal`.

Try a small first task:

> Read the files in this folder and explain what is here. Suggest one useful
> next step, and wait for me before changing anything.

Chat has numbered OPERATOR and REIN labels with distinct colors. Local NodeTerm
sessions open the detailed activity view automatically, using a browser when
the native node cannot embed it. `--no-browser` disables that opening. Install
tmux for the explicit split view, `rein --visual`. Ordinary chat does not need tmux.

## Change preferences or update

```sh
rein profile
rein setup profile
rein profile pack none
rein update && rein --version
```

`rein setup profile` edits only your work profile, without contacting a model.
`rein profile pack none` disables profile-pack skills. Updates preserve your
profile, settings, notes, and sessions, and your model can be offline. Restart
running Rein sessions afterward.

For an older build without `rein update`, use:

```sh
curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh \
  | bash -s -- --skip-setup
```

For native Windows, rerun the npm installation command.

## Installer options

Add options after `bash -s --` in the curl command:

| Option | Effect |
| --- | --- |
| `--skip-setup` | Install without onboarding, connection checks, or app launch |
| `--yes` | Run unattended connection setup; do not invent an operator profile |
| `--no-launch` | Keep the native app closed after setup |
| `--terminal-only` | Skip NodeTerm installation and save a terminal preference |

If the installer cannot access an interactive terminal, run `rein setup` from
one afterward.

## If setup stalls

- If `rein` is not found, open a new shell. Run `npm prefix -g` and check that
  its `bin` directory is on your `PATH` on macOS or Linux.
- If the model connection fails, keep the server running and use
  `rein setup --connection-only` to check its URL, model, or login. Your saved
  profile can be used when you return.
- If a reasoning model reports `no valid chat completion`, update Rein and
  rerun `rein setup --status`.
- If the installer finds edits in `~/.rein/repo`, commit or move those edits
  before updating. It preserves them instead of replacing the checkout.
- `Existing config found` means Rein kept saved settings. A failed connection
  check is a separate result.

The [field guide](https://zermo.github.io/rein-agent/) has the same installation
steps with a checklist and print view.

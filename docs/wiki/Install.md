# Install Rein

The first-run wizard has five stages: work preferences, task limits, model
connection, optional follow-ups, and a first request. You can revise these
choices later.

## Before you begin

You need Node.js 18 or newer, npm, Git, curl, and Bash for the installer. It
supports macOS, Linux, and WSL. Open Ghostty, Terminal, a NodeTerm terminal node,
or your preferred terminal and check:

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

When setup has a working model connection, the installer starts interactive
Rein in this same terminal and directory. There is no app project to create or
browser activity page to open. NodeTerm is optional: add `--nodeterm` after
`bash -s --` to install and register its separate macOS app, then open it yourself
with `rein desktop open` when wanted. Installing it does not redirect ordinary
`rein` commands away from your terminal.

For native Windows, install with npm, then start the wizard:

```sh
npm install --global git+https://github.com/Zermo/rein-agent.git
rein setup
```

## Tell Rein how you work

Answer six questions about the tasks you want help with, explanation style,
initiative, pacing, understanding, and listening. Everyday organization and
small life improvements are included alongside code, services, research, and
creative work. Options include small steps, examples, checkpoints, and recaps.
The terminal is the supported surface today.

Setup suggests workflows based on your task focus. Review the exact skills,
choose another pack, or skip packs before saving. These are editable support
preferences, with no score for health, personality, ability, or attention.
The same answers always produce the same recommendation.

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

## Give tasks enough room to finish

The next stage sets task limits without contacting a model. Standard settings
allow 300 model turns per prompt and 25 rounds for `rein loop` or `rein improve`.
A turn is one model call, including retries. A loop round can use several turns.
Ordinary chat uses the turn limit only.

Keep the standard or your existing settings, choose extended 1000/100 or short
100/10, enter exact values, or skip without saving. Larger limits allow more
work and more model usage. They do not enlarge the model's context window or
output limit, and background work keeps its own budgets.

```sh
rein setup budgets
rein setup budgets --status
```

At the turn limit, Rein marks the task `PAUSED`. Review the saved progress and
reply `continue` to give it another turn budget. One-shot `-p` mode saves the
session, prints a resume command, and exits with code 3. See
[task limits](https://github.com/Zermo/rein-agent/wiki/Task-limits) for exact
settings and how long runs preserve context.

## Connect a model

Continue in the wizard. Reuse a saved connection or choose where your model
runs. For a model on this computer, start its server and load a model before
Rein checks for it. You can install
[LM Studio](https://lmstudio.ai/download) or [Ollama](https://ollama.com/download)
if you do not have a model server yet. The
[self-hosted models guide](https://github.com/Zermo/rein-agent/wiki/Self-hosted-models)
walks through serving a model.

Setup checks localhost, configured endpoints, and known LAN/mesh peers. It shows
servers needing a key or a loaded model as well as ready servers. The scan has a
10-second budget and does not sweep subnets. Use `--discover-network=false` to
limit setup to localhost and configured endpoints. For missing hosts or unusual
ports, enter the URL shown by your server. See
[Server discovery](https://github.com/Zermo/rein-agent/wiki/Server-discovery).

Setup also checks the machine running Rein and suggests a local model. Choose
**Help me host a model** for serving recipes and prerequisites. Run `rein hardware`
on a remote model host to assess that host's memory; the gateway cannot infer it.

For a supported subscription login or API key, follow
[Cloud connections](https://github.com/Zermo/rein-agent/wiki/Cloud-connections).
Enter keys at the hidden prompt. Setup tests the selected connection and saves
it in your private `config.json`.

To revisit only this step:

```sh
rein setup --connection-only
```

## Choose whether Rein should suggest work

The follow-up stage offers proactive suggestions for a folder you choose.
Choose manual scans for that folder, enroll it and start the background service,
or skip this and use ordinary chat.

Suggestions use your Rein task history and the workspace's current state.
Default checks use deterministic rules without model calls. An optional small
headless helper can filter new candidates for the harness; it has no user chat
or tools and is not downloaded by default. Its dedicated worker and model store
are separate from your main model server. Use `rein autonomy guardian plan` to
review fit and downloads, then `rein autonomy guardian install` to start it. Add
`--install-runtime` only when you want a missing standalone runtime downloaded.
For personalized proposals, explicitly choose `rein autonomy planner main`.
It uses up to two calls to your main model per changed scan, with your saved
preferences and history; cloud allowances can apply. Approved task execution
uses your main model separately, so its normal resource usage and account
limits still apply. Proposed tasks stay pending until you approve them. Background runs have fixed
budgets and can be paused. Choosing an assertive work style or a skill pack does
not grant background approval or change tool permissions.

Review proposals from the same Rein chat terminal:

```text
/autonomy
/autonomy show <id>
/autonomy approve <id>
/autonomy dismiss <id>
/autonomy pause
/autonomy resume
```

`approve` permits read-only checks. Add `--allow-writes` only when you explicitly
want that proposal to use normal tools, including commands and writes. No
second terminal is needed. The optional standalone dashboard is
`rein autonomy tui`; use `rein autonomy disable` from your shell to remove the
supervisor service.

`disable` stops and removes Rein's service while keeping reports and decisions.
See [background coordination](https://github.com/Zermo/rein-agent/wiki/Background-coordination)
for the optional local helper, runtime installation, budgets, and stop controls.

## Make a first request

Check your saved model connection, then ask for a short reply without tools:

```sh
rein setup --status &&
rein --no-tools -p "Reply with the single word: ok"
```

HTTP connections should report `connection: passed`, followed by a short model
reply. Subscription connections report the official CLI's authentication status;
the model request checks that the connection works.

The installer starts Rein in your current terminal after successful interactive
setup. To start another session later, open a folder and run `rein`. Ghostty,
Terminal, and other compatible terminals use the same interface.

Try a small first task:

> Help me make one small thing easier today. Ask what is getting in the way,
> then suggest a next step I can realistically start.

For a project, try:

> Read the files in this folder and explain what is here. Suggest one useful
> next step, and wait for me before changing anything.

Chat has numbered OPERATOR and REIN labels with distinct colors. Tool calls and
results have their own labels. Use `/activity` to read the numbered activity
timeline, `/activity 3` to inspect a step, and `/legend` for the label key.
No separate app or browser is needed. `rein --visual` explicitly starts a tmux
split view; ordinary chat and `/activity` do not need tmux.

## Change preferences or update

```sh
rein profile
rein setup profile
rein setup budgets
rein profile pack none
rein update && rein --version
```

`rein setup profile` edits only your work profile. `rein setup budgets` changes
task limits. Both work without contacting a model.
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
| `--skip-setup` | Install without onboarding, connection checks, or interactive launch |
| `--yes` | Run unattended connection setup; do not invent an operator profile |
| `--no-launch` | Finish setup without starting interactive Rein |
| `--terminal-only` | Explicitly keep the terminal default |
| `--nodeterm` | Install/register the optional NodeTerm macOS app; leave it closed |

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

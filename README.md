# rein

[![Rein repository card](docs/assets/rein-repo-card.jpg)](https://zermo.github.io/rein-agent/)

A terminal-first, local-first agent harness. One message model, one event
protocol, zero runtime dependencies — any OpenAI-compatible server, local by
default, any provider by choice.

```
┌─────────────────────────────────────────────────────────────────┐
│  harness/   REPL · canvas · print · loop · native tools        │  ← the product
├─────────────────────────────────────────────────────────────────┤
│  agent/     event-driven loop · steering · sessions (JSONL)     │  ← the behavior
├─────────────────────────────────────────────────────────────────┤
│  ai/        one message model · one event protocol · compat    │  ← the translation
│             Ollama · LM Studio · llama.cpp · vLLM · any API    │
└─────────────────────────────────────────────────────────────────┘
```

Three surfaces share the same loop:

| Surface | What it is | Entry point |
| --- | --- | --- |
| **rein** (terminal) | The harness: REPL, one-shot, loops, gates, autonomy, web, meat review | `rein` |
| **rein-klaud** (desktop) | Native Mac app over Rein's loopback AG-UI server: named bots, saved chat, approvals; pairs with an iOS companion | `rein klaud` |
| **Dareecho** (machine) | Learn the machine before replacing its OS, keep your files, and run a software factory on it | `rein learn` · `rein os` · Mastra Factory app |

The current release is **v0.15.0**. Open the
[retro installation field guide](https://zermo.github.io/rein-agent/) for a
visual walkthrough with copyable commands, and the
[public wiki](https://github.com/Zermo/rein-agent/wiki) for setup, models, and
deployment. For offline use, open `docs/install.html` from a local checkout.

[![Retro Rein installation guide](docs/assets/rein-field-guide-card.jpg)](https://zermo.github.io/rein-agent/)

[Repo cards and logo files](docs/branding.md) · [Publish the guide](docs/guide-deployment.md)

## What Rein is

An agent harness you run in the terminal you already use — Ghostty, Terminal,
a NodeTerm terminal node, or any compatible shell. It speaks one message model
(user / assistant[content blocks] / toolResult) and one streaming event
protocol (`start → *_start → *_delta → *_end → done|error`) over every
provider quirk: Ollama, LM Studio, llama.cpp, vLLM, any OpenAI-compatible
server, or the official Codex/Copilot/Grok CLIs for subscription accounts.

The guided setup asks how you work, suggests an optional workflow pack, sets
task limits, connects a model, and offers follow-ups before your first task in
the same terminal. It can help with everyday plans and small improvements as
well as coding, services, research, and creative work.

Built by studying three codebases:

- **[pi](https://github.com/earendil-works/pi)** — the architecture. Its
  `packages/ai` proves the hard part of an agent harness is the
  *translation layer*; its `packages/agent` proves the loop is just:
  stream → run tools (parallel) → repeat, with steering queues, hooks, and
  truncation safety. Rein implements these interfaces with zero runtime npm
  dependencies. Pinned native components ship under `vendor/`; esbuild bundles
  the CLI to plain JS because Node won't type-strip `.ts` under
  `node_modules`.
- **[karpathy/autoresearch](https://github.com/karpathy/autoresearch)** — the
  *loop* that runs an agent forever against one metric, keeping what improves
  and discarding what doesn't. rein encodes that twice: `rein loop` (any
  project, any metric) and `rein improve` (the harness itself is the target).
- **[karpathy/nanoGPT](https://github.com/karpathy/nanoGPT)** — the values:
  readable over clever, with explicit limits on context and tool output.

## Requirements

- Node ≥ 18 for the installed CLI (ships prebuilt; zero runtime deps)
- Node ≥ 23.6 (or ≥ 22.18) to develop from source or run the test suite
  (native TypeScript type-stripping)
- Any OpenAI-compatible server. Local ones are probed automatically in
  priority order: **Ollama** → **LM Studio** → **llama.cpp** → **vLLM**.
- tmux and bash for persistent shells and `--visual` on macOS/Linux/WSL.
  Ordinary chat and foreground bash work without tmux. Meat ships prebuilt
  WASM; users do not need Go. Native Windows tmux is not supported.
- The **Mastra Factory** app and its server need Node ≥ 22.19 — they run as a
  separate service alongside the harness, not inside it, so the terminal CLI
  keeps its Node 18 floor.

## Install

Install on macOS, Linux, or WSL and start the guided setup:

```sh
curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh | bash
```

On macOS the installer also installs the native klaʊdbot app and opens it
after successful guided setup. On Linux and WSL it starts interactive Rein in
the current terminal. Neither path requires NodeTerm or a browser activity
page.

To install only the Mac app from the latest published release, with its own
runtime and no global Node installation:

```sh
curl -fsSL https://github.com/Zermo/rein-agent/releases/latest/download/install-macos-app.sh | bash
```

The app goes into `~/Applications`. Choose **Start local rein serve** in its
first window. Development releases are ad hoc signed and are not notarized;
normal macOS approval checks apply. See the [Mac release notes](docs/macos-development-release.md).

Answer six practical questions about your tasks and communication preferences,
review a suggested workflow pack, then connect a model. You can change answers
before saving, choose another pack, or skip skills. The final step offers
optional follow-ups for a folder you choose and a first task to try.

Flags after `bash -s --`: `--skip-setup` skips onboarding, model checks, and
launch; `--yes` runs unattended connection setup without inventing a profile;
`--no-launch` finishes setup without starting interactive Rein. `--no-app`
skips the native Mac app; `--app-only` installs just that app.
`--terminal-only` keeps setup and chat in the current terminal. NodeTerm is
optional: use `--nodeterm` only when you want its separate native macOS app
installed and registered. Open it explicitly with `rein desktop open`.

```sh
rein                            # start in this terminal and directory
rein --terminal                 # explicitly keep the terminal surface
rein desktop use terminal       # save that preference
rein desktop install --no-launch # install/register optional NodeTerm
rein desktop status
```

The [klaʊdbot desktop](docs/klaud.md) adds named bots, saved chat, live shell
preferences, and approval dialogs over Rein's loopback AG-UI server. The Mac
app includes the CLI and its runtime. From a development checkout, run
`npm --prefix apps/klaud ci` once, then `rein klaud`. The terminal CLI still
has zero runtime dependencies.

The wizard detects local AI servers (Ollama, LM Studio, llama.cpp, VLLM),
accepts remote hosts, and offers cloud API keys or supported subscription
logins. It tests API connections and saves `~/.rein/config.json` (or
`$REIN_HOME/config.json`). Run `rein setup` again for the full walkthrough.
Use `rein setup --connection-only` to change only the model connection, or
`rein setup --status` to check it.

Or install manually:

```sh
npm install --global git+https://github.com/Zermo/rein-agent.git
rein setup
```

The CLI ships prebuilt (`dist/rein.js`, committed), so the install needs no
build step and no devDependencies. To rebuild the bundle after changing
source: `npm install && npm run bundle` (esbuild, dev-only). The
compatibility commands `rein-agent` and `rein` point to the same CLI.

Developing from source: `npm ci --include=dev && npm test` (offline smoke and
regression suites). For a repository-based workspace in ChatGPT, follow the
[Codex cloud development setup](docs/cloud-development.md).

To update an installed copy on macOS, Linux, or WSL:

```sh
rein update
```

This downloads the latest installer with curl, then runs it with Bash and
`--skip-setup`. It installs the current prebuilt bundle from `main`,
preserving your configuration, credentials, notes, and sessions under
`$REIN_HOME` (default `~/.rein`). Restart running Rein sessions after the
update. Local changes in the installer checkout are preserved; commit or move
them before updating.

Native Windows users can rerun the manual npm installation command above.

```sh
# local, with the Ollama app or server already running:
ollama pull qwen2.5-coder:7b
rein

# any provider:
rein --provider deepseek --model deepseek-chat
rein --provider openai --model gpt-4o
REIN_BASE_URL=http://localhost:11434/v1 REIN_MODEL=qwen2.5-coder:7b rein -p "hello"
```

### Tell Rein how you work

The operator-profile wizard asks six practical questions: how to explain an
answer, what you want help with, how much initiative to take, useful pacing,
what makes unfamiliar information clearer, and how to check understanding.
Options include everyday organization and making one small thing easier, as
well as coding, services, research, and creative work. Preferences such as
small steps, examples, checkpoints, or recaps are editable choices, not
diagnoses or measurements of attention or ability. The supported conversation
surface is the terminal.

| Pack | Suggested for | Bundled workflows |
| --- | --- | --- |
| `everyday` | Life organization and small improvements | `task-breakdown`, `routine-planning`, `decision-support` |
| `ship` | Code and projects | `code-change`, `tdd`, `execution-discipline` |
| `ops` | Machines and services | `service-care`, `durable-notes`, `execution-discipline` |
| `study` | Research and learning | `grounded-research`, `learning-plan` |
| `studio` | Creative work | `creative-brief`, `visual-review` |

Setup saves `SOUL.md` for agent voice, `USER.md` for your work preferences,
`AGENTS.md` for the operating brief, and `profile.yaml` for the
machine-readable `operator_profile`, support preferences, and enabled pack.
They live in your private `~/.rein`, or `$REIN_HOME`. Existing version 1
profiles are validated and adapted in memory; their files remain unchanged
until you explicitly save a new preview.

```sh
rein profile                   # view your saved preferences and pack
rein profile --json            # inspect the structured profile
rein setup profile             # revise it without connecting to a model
rein profile pack everyday     # choose everyday workflows
rein profile pack none         # disable profile-pack skills
```

### Give tasks enough room to finish

The default limits are 300 model turns per prompt and 25 iterations for
`rein loop` or `rein improve`. One turn is one model call, including retries.
One iteration is a loop round that can use several turns. Ordinary chat uses
only the turn limit.

```sh
rein setup budgets                  # offline wizard; review, change, or skip
rein setup budgets --status         # current limits and actual config path
rein setup budgets --json           # the same read-only report as JSON
rein setup budgets --yes --max-turns 750 --max-iterations 40
rein --max-turns 1000                # override for this launch
```

At the turn limit, Rein marks the task `PAUSED` and preserves completed tool
results. Review the progress, then reply `continue` for another turn budget.
One-shot `-p` mode saves a resumable session even without `--save`, prints the
resume command, and exits with code 3. This pause does not mean the task is
finished. See [task limits](https://github.com/Zermo/rein-agent/wiki/Task-limits)
for presets, resuming work, and the distinction between turns, context, and
output tokens.

## Usage

```
rein                        interactive REPL (sessions persist, steering mid-run)
rein -p "query"             one-shot; --json for the raw event stream
rein loop                   autonomous experiment loop (TASK.md + METRIC.md)
rein improve [goal]         self-improvement loop on this repo
rein gates [file] --mode m  unlazy gates: lint | status | approve | reverify
rein models                 what rein can see: local servers + provider presets
rein skills [name]          bundled workflows and enabled profile-pack skills
rein debug <folder> [--json]  offline exported-session diagnostics (counts only)
rein update                 download and install the latest published build
rein --visual               explicitly split chat and live activity in tmux
rein meat --working-tree    review tracked changes with the embedded Meat engine
rein tmux start             start a persistent bash shell
rein hardware [--json]      profile this machine + what it can run (tok/s estimates)
rein model help             managed model workflow: pinned GGUF, serving, services
rein doctor [--fix]         auto-detect the whole stack; --fix self-repairs it
rein heartbeat [--init]     self-sustaining beat: self-heal → tasks → self-advance
rein learn [--json]         Dareecho Learn: read-only boot chain + security dossier
rein learn ios [--udid U]   learn an attached iOS device via libimobiledevice
rein export browse          Finder-style TUI: choose personal files before an OS replace
rein export presets [--to D]  copy standard personal data groups; sources are never touched
rein os help                Dareecho OS: plan | prepare | rain | rainmeter | skin | factory
rein os factory setup       install Mastra Factory once (template, key, .env, deps, build)
rein os factory start       Mastra Factory, production profile (built server, DATABASE_URL)
rein os factory dev         Mastra Factory, single-machine profile (dev server, libSQL)
rein os factory stop        stop the server this supervisor started
rein os factory status      server state, URL, pid, paths (--json)
rein os factory open        start if needed, open the Factory UI in a browser
rein setup                  work preferences, task limits, model, follow-ups, first task
rein setup --connection-only  change only the model connection
rein setup profile          offline work-style wizard; review and choose a pack
rein setup budgets          offline task limits; also --status or --json
rein profile                view your profile (also: --json, setup, pack <name>)
rein login codex|copilot|grok  official browser/device account sign-in
rein klaud                  the native klaʊdbot desktop app
rein autonomy init|scan|enable|disable  background supervisor from task history
rein web install|search|fetch           Obscura-backed web search and page render
rein --version              print version
```

REPL commands: `/help /legend /new /model /tools /sessions /resume <id>
/branch /context /new-context [handoff] /skills /skill <name> <task>
/stop /quit`. While the agent is working, just type — it's injected as a
steering message after the current tool batch (pi's steering, not pi's queue).
`/stop` immediately cancels the current turn and its owned shell process
group. Queued input is discarded; send a new request when ready to continue.

## Mastra Factory — a software factory on this machine

[Mastra Factory](https://github.com/mastra-ai/mastra) is the open-source
agent-building machine from the Mastra team. Rein installs it **as
itself** — same name, same UI, same icon — as a native app that sits
alongside Dareecho: open the app and look at your machine's software factory
running live. It is not rebranded; the [NOTICE](apps/factory/NOTICE) keeps
Mastra's name, attribution, and Apache-2.0 terms where they belong.

The app (`apps/factory`) and the terminal share one supervisor
(`apps/factory/supervisor.mjs`). Whichever surface you use, the other sees
the same server:

```sh
rein os factory setup     # one-time install: template, key, .env, deps, build — never overwrites
rein os factory start     # production profile: built server, requires DATABASE_URL (Postgres)
rein os factory dev       # single-machine profile: dev server, libSQL storage, no database
rein os factory stop      # SIGTERM→SIGKILL of the server process group
rein os factory status [--json]
rein os factory open      # start if needed, then open the UI in a browser
```

Facts that matter:

- **Pure copy.** The generated project is a byte-identical copy of
  [mastra-ai/softwarefactory-template](https://github.com/mastra-ai/softwarefactory-template)
  (pinned in `vendor/mastra-factory/` with a
  [provenance record](vendor/mastra-factory/PROVENANCE.md)), provisioned once
  into `~/.local/share/rein-factory`. Setup never overwrites an existing
  project.
- **Separate service.** Factory needs Node ≥ 22.19 and carries its own
  dependency tree, so it runs as a supervised service on port 4111 instead of
  inside the Node-18 `dist/rein.js` bundle. State (pid, log, port) lives under
  `~/.local/state/rein-factory`.
- **Two profiles.** The built server always requires `DATABASE_URL`; the dev
  profile runs the single-machine libSQL storage. The app chooses by
  configuration: `DATABASE_URL` present → production, otherwise dev.
- **No rebrand, no overwrite.** Factory's name and UI stay Mastra's; your
  generated project and its `.env` are user state, created once and left
  alone on updates.

The integration study, license reading (including the dormant Kepler EE code
in `@mastra/core`), and the wrap design are in
[docs/mastra-factory-integration.md](docs/mastra-factory-integration.md).
Model wiring is done in Factory's own Settings › Models; the Dareecho model
host plugs in there as a custom OpenAI-compatible provider.

## Dareecho — learning the machine, keeping the files, building on it

Dareecho is the machine-facing tier on top of Rein. **Dareecho Learn** is the
implemented, read-only assessment pass, exposed through `rein learn`. The
export commands keep the files that are yours before anything is replaced.
`rein os` carries the OS development surface:

```sh
rein learn [--json]           read-only pass: boot chain of trust, security posture,
                              per-probe evidence. Writes a new dossier under
                              ~/.rein/redteam/ (refuses to overwrite).

rein learn ios [--udid U]     an attached iPhone or iPad via libimobiledevice.

rein export browse            Finder-style TUI: navigate, select, export. [e] exports, [q] quits.

rein export presets [--to D]  the standard personal data groups: Documents, Desktop,
                              Downloads, Pictures, Movies, Music — plus Mail,
                              keychains, browser profiles, SSH/GPG keys where present.

rein export <paths…> --to D   exactly the paths you name.

rein os plan [--json]         assess this machine and show installation gates (read-only)
rein os prepare --output D    stage a pinned Omarchy VM overlay kit, or the ChromeOS
                              userland kit (--target omarchy|chromeos)
rein os rain [--animate]      preview the rain motif in this terminal (static by default)
rein os rainmeter [--json]    Rainmeter rebuild report: pin, mapping, gates
rein os skin render|install|list   render, stage, and list Rainmeter-model skins
rein os factory …             the Mastra Factory surface above
```

Export copies. Sources are never moved or deleted; an existing target
receives newer copies of the same files. The dossier writer is stricter: it
refuses an existing directory and steps to the next free name instead. The
dossier records a red-team assessment; it does not bundle or invoke
CyberStrike's offensive tooling. `rein os` is development tooling: `plan` is
read-only, `prepare` writes only to the chosen new kit directory, and nothing
in this tier partitions disks, installs an operating system, or starts a
background service. Read the [Dareecho development guide](docs/rein-os.md)
for the VM and ChromeOS overlay boundaries, and
[Dareecho export](https://github.com/Zermo/rein-agent/wiki/Dareecho-export)
for the operator-facing sequence.

### Host models on your own hardware

Rein has an explicit [managed model workflow](docs/managed-models.md) for
pinned GGUF downloads, integrity checks, headless serving, and scoped
background services. Start with `rein model help`. Existing server discovery
remains `rein models`.

Rein connects to an OpenAI-compatible Chat Completions server on this
computer, on another machine in your LAN, or through a mesh VPN such as
NetBird or Tailscale. Choose a model that fits the serving machine's memory
and supports tool use for coding tasks. The server handles inference; Rein
runs in your project directory.

| Server | Start serving | Default local API base |
| --- | --- | --- |
| [LM Studio](https://lmstudio.ai/docs/developer/core/server) | Install the app, download and load a model, then start the server in the Developer tab | `http://localhost:1234/v1` |
| [Ollama](https://docs.ollama.com/quickstart) | Install Ollama, start the app or `ollama serve`, then `ollama pull MODEL_ID` | `http://localhost:11434/v1` |
| llama.cpp | Start its OpenAI-compatible `llama-server` with your model | `http://localhost:8080/v1` |
| vLLM | Start its OpenAI-compatible server with your model | `http://localhost:8000/v1` |

```sh
rein setup
# Or choose a known local server explicitly:
rein setup --provider lmstudio --api chat-completions
rein setup --provider ollama --api chat-completions
```

Interactive setup checks localhost, saved endpoints, and known private
LAN/mesh peers from the neighbor table, NetBird, and Tailscale. The scan is
bounded to 16 peers, 80 endpoint candidates, 8 concurrent checks, and 10
seconds. It does not sweep subnets. Server labels come from API evidence, not
a port number.

```sh
rein models --discover-network
rein models --discover-hosts model-host --discover-ports 9000
rein setup --connection-only --discover-network=false
```

### Connect through a LAN, mesh VPN, or SSH

For direct access, the model server must listen on an interface reachable
from the computer running Rein. In LM Studio enable **Serve on Local
Network**, or run `lms server start --port 1234 --bind 0.0.0.0`. For Ollama,
configure `OLLAMA_HOST`. `0.0.0.0` is a listener setting, not the address to
enter in Rein.

```sh
rein setup --api chat-completions --base-url http://model-host:1234
```

A loopback-only API is reachable from its own machine. Use your existing SSH
alias to reach it without changing the server listener:

```sh
ssh model-host
ssh -o BatchMode=yes model-host true
rein setup --ssh model-host --base-url 127.0.0.1:1234 --api chat-completions
rein -p "hello"                   # reconnects through SSH automatically
rein setup --status
```

With `--ssh`, the target URL is interpreted from the remote machine. Without
it, `127.0.0.1` means the computer running Rein. The tunnel uses an ephemeral
local loopback port and closes after each request. See the
[self-hosted model walkthrough](https://github.com/Zermo/rein-agent/wiki/Self-hosted-models).

### API keys and subscription login

For cloud APIs, setup opens the provider's key page when a key is needed,
then queries the authenticated model list. Standard environment variables
such as `OPENAI_API_KEY` or `GEMINI_API_KEY` work; `REIN_API_KEY` explicitly
supplies a key for a custom endpoint. Environment keys are not saved. Entered
keys are hidden, stored in a mode-600 config, and scoped to the saved API
endpoint and SSH host.

```sh
rein setup --provider openai
rein setup --provider gemini
rein setup --provider xai
rein setup --provider openrouter --no-browser
```

Subscription connections use installed official CLIs:

| Connection | Install once | Configure Rein |
| --- | --- | --- |
| ChatGPT through Codex | `npm install -g @openai/codex` | `rein setup --provider codex` |
| GitHub Copilot | `npm install -g @github/copilot` | `rein setup --provider copilot` |
| SuperGrok / X Premium+ | `npm install -g @xai-official/grok` | `rein setup --provider grok` |

Setup opens device sign-in and lets the official CLI display the one-time
code. `rein login codex`, `rein login copilot`, or `rein login grok` repeats
login. Rein gives each CLI its own configuration under
`$REIN_HOME/cli-auth` and leaves credential storage and refresh to that CLI.
CLI responses use Rein's text tool protocol and retain Rein's tool approvals
and Posthorse history. Each turn starts in a temporary directory with native
tools disabled or sandboxed. These bridges require current CLIs with the
isolation flags used by Rein.

Gemini API uses its documented [OpenAI-compatible endpoint](https://ai.google.dev/gemini-api/docs/openai).
The retired GitHub Models API is no longer offered, while Copilot CLI is a
separate connection. Grok subscriptions use the official Grok Build CLI; the
supported X tier is **Premium+**. Follow Rein's
[Grok guide](https://github.com/Zermo/rein-agent/wiki/Grok).

### Tool calls work for every model

The compatibility layer (`src/ai/compat.ts`) guarantees tool capability
regardless of what the model natively supports:

1. **Capability table** — model-name patterns: known-good (qwen2.5/3,
   llama3.1+, deepseek, gpt-*) use native function calling; known-weak
   (tinyllama, qwen ≤1.8b, gemma ≤2b, phi-2) start in **text protocol**.
2. **Runtime fallback** — if a native toolUse turn comes back with empty or
   unnamed arguments, rein flips that model to the text protocol
   (`<tool name="bash">{"command": "ls"}</tool>`) mid-session and tells the
   model.
3. **Learned modes** — decisions persist in `~/.rein/capabilities.json`, so
   the next session starts in the mode that already works.

Plus JSON salvage (`src/util/json-salvage.ts`): malformed tool arguments from
small models (trailing commas, raw newlines, invalid escapes, prose around
the JSON) are repaired, never fatal.

Override with `--tools native|text|auto` (auto is the default).

### Fresh context with Posthorse

Rein includes a native adaptation of [pi-posthorse](https://github.com/fitchmultz/pi-posthorse).
The pinned upstream 0.4.1 source and MIT license are in
`vendor/pi-posthorse`. Rein uses its own session and tool interfaces, so it
needs neither the Pi fork nor additional runtime dependencies.

The default toolset includes:

- `get_context_remaining({})` reports estimated tokens until rollover and the
  hard limit.
- `new_context({handoff?})` requests a fresh window after the entire tool
  batch succeeds.
- `notes({op, path?, content?, query?, offset?})` lists, reads, writes,
  appends, or searches plaintext files in `.pi/notes`.
- `history({op, query?, id?, all?, limit?, offset?})` searches and reads
  saved messages across windows.

A rollover removes earlier messages from model input while keeping the
complete transcript. The new window gets an optional handoff. Automatic
rollover uses a bounded record of user inputs, an older checkpoint, and the
latest unconsumed tool batch, with history references for the full text. It
makes no summarization request.

Configuration in `~/.rein/config.json`:

```json
{
  "contextWindow": 32768,
  "maxTokens": 4096,
  "posthorse": { "enabled": true, "reserveTokens": 4096 }
}
```

CLI overrides are `--context-window <tokens>`, `--reserve-tokens <tokens>`,
and `--no-auto-context`. Manual `/new-context [handoff]` and the
`new_context` tool remain available when automatic rollover is disabled.
`/context` prints the current budget.

Sessions persist incrementally in the REPL and with `-p --save`. Reopening a
non-empty session creates a fresh resume window: it retains the full archived
transcript in `history`, then layers the current Git checkpoint, a squashed
diff since that session's checkpoint, the newest peer-session handoff, and
`.pi/notes/MEMORY.md` over the next model request. Notes belong to the
repository and are shared by linked worktrees. History reads send the
selected stored text to the active model provider.

For llama.cpp and compatible local HTTP servers, Rein sends
`cache_prompt: true`; `/context` shows `lastPromptCacheTokens` when the
server reports it.

### Web search and scraping with Obscura

`web_search` reads DuckDuckGo's first HTML results page through the local
[Obscura browser](https://github.com/h4ckf0r0day/obscura). `web_fetch`
renders one page, executes its JavaScript, and returns the title, final URL,
and markdown. Neither tool needs an API key.

```sh
rein web install
rein web status
rein web search 'site:github.com obscura browser' --max-results 5
rein web fetch https://example.com --max-chars 20000
```

First web use installs the pinned Obscura 0.2.2 no-render build
automatically, verified against its release SHA-256 before extraction. It
lives under `$REIN_HOME/native/obscura`. Go, Rust, Chromium, and runtime npm
packages are unnecessary. Ordinary chat works without Obscura.

Each request uses temporary browser storage, with a bounded process lifetime
and output. Search supports `query`, `max_results`, `include_domains`, and
`exclude_domains`. Blocked/CAPTCHA pages and unrecognized markup produce
errors, not empty searches. Web results are evidence; the agent is instructed
to cite their source URLs.

### Completion gates (unlazy)

[unlazy](https://github.com/Leonxlnx/unlazy) (MIT, vendored at
`vendor/unlazy/`) is the anti-laziness discipline: write an acceptance ledger
**before** the work, run oracles that can actually fail, reverify before
reporting done.

```
rein gates GATES.md --mode lint        # oracles that cannot fail? caught now
rein gates GATES.md --mode status      # report only — never executes
rein gates GATES.md                    # = --mode approve: approve exact oracles, run them
rein gates GATES.md --mode reverify    # re-run everything; demote stale evidence
```

A gate passes only when its command exits 0 **and** `EXPECT:` matches the
output; the ledger records shell, CWD, exit status, and a SHA-256 output
fingerprint as `EVIDENCE:`. Untested claims are not evidence. Approval is the
trust boundary: a `CHECK:` line is never executed until its exact
command+CWD+PATH oracle is approved (stored in `~/.unlazy/approved`, outside
the repo by design). The agent sees all of this as one tool (`gates`) and a
section of the system prompt.

### Self-improvement

```sh
rein improve "make tool errors more actionable"   # or: rein improve (uses LESSONS.md)
```

1. read the goal or the `## harness` section of `LESSONS.md`
2. one concrete weakness → smallest fix
3. run `npm test`, including the smoke and regression suites
4. pass → commit the change and lesson · fail → discard the experiment and
   commit its lesson
5. repeat until `--max-iterations` (saved setting, default 25) or the agent
   says no-change

The system prompt tells every agent to append durable learnings to
`LESSONS.md` (shared memory across sessions, loaded on next start), and
`rein improve` reads exactly that file. The agent that bumps into a sharp
edge writes it down; the improve loop cuts the edge.

### Self-sustaining — `rein doctor` + `rein heartbeat`

```sh
rein doctor [--fix]    auto-detect: node → bin → repo → bundle → config →
                       server → model → hardware fit → perms → disk
                       --fix repairs what it can and re-checks. exit 1 if anything
                       is still broken — scriptable in CI and cron.

rein heartbeat         one beat, four phases, in order:
                       1. SELF-HEAL    rein doctor --fix
                       2. TASKS        each HEARTBEAT.md line → an agent run
                       3. SELF-ADVANCE one `rein improve` iteration
                       4. MEMORY       JSONL entry → ~/.rein/heartbeat.log
```

`HEARTBEAT.md` (the openclaw/hermes pattern) is a file of periodic tasks —
one per line, `#` lines are comments, empty = idle beat. Seed one with
`rein heartbeat --init`. The beat repairs its own runtime before doing any
work, so a stale checkout or stale bundle heals itself on the next tick:

```sh
rein heartbeat --init          # write a template, edit it
*/30 * * * * rein heartbeat >> ~/.rein/heartbeat.cron.log 2>&1
```

*Perception (doctor) → action (tasks) → egeneration (improve) → memory
(log)* — the baseline for self-sustaining agents.

### Proactive work from task history

`rein autonomy` adds a background supervisor and a terminal dashboard. It
uses the host's user service manager: launchd on macOS, or systemd on Linux.

```sh
rein autonomy init             # enroll this directory; supervisor stays paused
rein autonomy scan             # deterministic rules over your Rein history
rein autonomy tui              # terminal dashboard for proposals
rein autonomy enable           # register Rein's own user service
rein autonomy status | pause | resume | disable
rein autonomy plan             # print the generated service definition
```

The scan compares older and recent user/assistant excerpts with current Git
status and change statistics. Deterministic rules identify explicit follow-up
requests and prepare bounded proposals. Scanning uses no inference by
default. An optional local helper can keep or drop those candidates, but
cannot invent tasks. The dashboard shows the exact task, workspace, cadence,
reason, and cited history excerpts before approval.

The REPL reviews the same state in chat:

```text
/autonomy
/autonomy show <id>
/autonomy approve <id>          # read-only checks; add --allow-writes for tools
/autonomy dismiss <id>
/autonomy pause
/autonomy resume
```

Dashboard approvals enable read-only inspection with bounded `read`, `ls`,
and literal `search` tools. `rein autonomy approve <id> --allow-writes`
grants the normal Rein tools for that proposal. Defaults are one history
check per hour, six operations per rolling 24 hours, eight model turns per
approved run, and a 180-second cancellation deadline. For personalized
follow-ups, explicitly select `rein autonomy planner main`; return to free
deterministic checks with `rein autonomy planner rules`.

### Optional headless helper for background checks

The default coordinator makes no inference calls and uses no cloud allowance.
The optional guardian is a headless worker that accepts bounded triage
requests from the harness and returns candidate selections. It has no user
chat, persona, tools, task approval, or execution authority.

```sh
rein autonomy guardian status
rein autonomy guardian plan             # inspect this machine's fit and downloads
rein autonomy guardian setup            # verify an already running Rein-owned helper
rein autonomy guardian install          # start the worker and download its model
rein autonomy guardian install --install-runtime  # also fetch a missing runtime
rein autonomy guardian disable
```

The worker uses a dedicated loopback endpoint and private model storage. The
pinned [Qwen3 0.6B Q4_K_M model](https://ollama.com/library/qwen3:0.6b) is
about 523 MB to download. `plan` shows download sizes, memory headroom, and
extraction prerequisites. See
[background coordination](https://github.com/Zermo/rein-agent/wiki/Background-coordination)
for setup and stop controls.

### Autonomous experiment loop

```
your-project/
├── TASK.md      what to improve (agent-readable)
└── METRIC.md    fenced bash block; its output must print METRIC=<number>
rein loop --max-iterations 10
```

Run from a clean Git repository root with an initial commit. Fixed budget per
iteration, one metric, keep/discard with git, auto-stops after three
no-change iterations. This is autoresearch's `program.md` loop with the
harness as the operator.

### Local model fit — `rein hardware`

Stolen concept from [Magnitude](https://github.com/magnitudedev/magnitude)
(Apache-2.0): profile the machine, then tell you what you can actually run —
with a per-domain memory model and reserves before a model may claim memory.

```sh
rein hardware             # this machine, ranked models, prerequisites and recipes
rein hardware --json      # the same evidence for another tool
```

Recommendations consider the operator's work focus, memory headroom, context
length, quantization, and accelerator placement. The report shows engine
prerequisites and serving/check commands where a recipe exists. It never
downloads a model or starts a service by itself. Fit and throughput are
estimates, not measurements. See
[Hardware and serving](https://github.com/Zermo/rein-agent/wiki/Hardware-and-serving).

### Terminal activity and persistent bash

```sh
rein --visual
rein tmux start 'export PROJECT_MODE=dev'
rein tmux list
rein tmux send <session-id> 'printf "%s\n" "$PROJECT_MODE"'
rein tmux capture <session-id>
rein tmux attach <session-id>
rein tmux interrupt <session-id>
rein tmux stop <session-id>
```

The `bash` tool accepts `mode: "tmux"` and an optional existing `session` ID.
Environment, working directory, and interactive programs persist across
turns. Rein uses its own server and scopes sessions by workspace.
`/stop` cancels foreground work; intentionally persistent tmux sessions
remain until explicitly stopped.

Interactive Rein keeps activity in the current terminal. Messages, thinking
status, tool calls, and results have distinct labels. Use `/activity` for the
session's numbered timeline and `/activity 3` to inspect a step. `/legend`
explains the labels. This works without tmux, NodeTerm, or a browser.

`--visual` opens chat beside a terminal activity tree. Detach with
**Ctrl-b d**; the launcher prints an activity ID and a resume command.
Activity snapshots live in `$REIN_HOME/activity`, mode 0600. The canvas
listens only on 127.0.0.1. No transcript is uploaded.

### Clear operator and agent replies

Interactive chat labels every operator turn and agent reply. Operator
prompts are cyan. The `REIN` label keeps its name and cycles its accent with
each numbered reply. Tools have separate named labels. `MESSAGE` labels
ordinary assistant text; a reply that begins with an explicit `[RESULT]`,
`[OPINION]`, `[CHOICE]`, `[CHANGE]`, or `[EDIT]` heading keeps that
agent-declared purpose in its label. COMPLETE, HANDOFF, ERROR, CANCELED, and
LIMIT show how a reply ended. THINKING shows a status without exposing hidden
reasoning. `NO_COLOR` removes ANSI color while preserving the labels. Use
`/legend` for the full label key.

### Embedded Meat diff review

```sh
rein meat                     # latest commit
rein meat main HEAD           # commit range
rein meat --staged            # staged changes
rein meat --working-tree      # tracked changes against HEAD
```

Rein embeds [Bold Software's Meat](https://github.com/boldsoftware/meat) at a
pinned revision. Its Go algorithm runs as WASM in an isolated Node worker.
Meat validates the model's remove/replace/fold plan against the original
diff and produces a reading diff and summary. It does not modify files.
Limits are 4 MB of input, 32 model requests, and five minutes per review.
See the [pinned runtime and build details](vendor/meat/UPSTREAM.md).

### Native Fold components and Matt Pocock workflows

Rein integrates [Fold](https://github.com/humanlayer/fold)'s repeated-tool-batch
detector and UTF-8 output truncation, with a native skill loader based on its
stable roster design. Three identical consecutive tool batches stop the run
with an incomplete-work notice. Set `repeatToolLimit` to 0 to disable, or an
integer from 2 to 50 to tune it. Shell output keeps up to 500 lines / 20 KB.

[Matt Pocock's skills](https://github.com/mattpocock/skills) ship as native
workflows: `diagnosing-bugs`, `tdd`, and `code-review`. Invoke
`/skill diagnosing-bugs <task>` in the REPL, or read a bundled reference
without inference: `rein skills tdd tests.md`.

`rein debug /path/to/export` reads JSONL sessions offline. It reports counts
of empty responses, provider errors, nested recovery, path mistakes, large
outputs, and repeated tool batches — never transcript text, filenames, or
credentials. Both upstreams are pinned under `vendor/`;
`npm run check:natives` verifies their source and license hashes.

## Architecture notes (what I took from pi, and where I cut)

**Kept — it's load-bearing:**

- The `ai` layer as a *translation* layer: one message model, one streaming
  event protocol over an async iterable with a final-result promise. Errors
  are *in* the stream, never thrown at the caller. The OpenAI-compatible
  adapter handles missing `finish_reason`, missing usage (estimated),
  `stream_options` rejection, reasoning/thinking deltas, and tool-call
  argument chunking.
- The agent loop's control points: **steering** (inject after the current
  tool batch), **follow-up** (run when the agent would stop), parallel tool
  execution with per-tool `sequential` override (bash),
  `before/afterToolCall` hooks, `shouldStopAfterTurn`, **truncation safety**
  (a `length` stop means tool args may be cut — those calls are failed with
  an explanatory result, not executed with half-arguments).
- Sessions as append-only JSONL with a header line; branching = copy +
  append. One file, greppable, resumable.
- Short system prompt; minimal toolset: `read write edit bash grep find ls`.

**Cut — deliberate:**

- No image/audio blocks or native provider-specific reasoning APIs.
- No framework: no React TUI, no config DSL. A REPL is ~200 lines of
  readline; the print mode is ~80.
- TypeBox → a 60-line hand-rolled schema validator for the subset we use.
- Zero runtime package dependencies; subscription connections use
  separately installed CLIs.
- Mastra Factory runs as a separate supervised service, not inside the
  bundle: its Node ≥ 22.19 floor and dependency tree stay out of the
  Node 18-compatible `dist/rein.js`.

**Added (requirements):**

- The tool-capability compatibility layer — pi assumes capable models; rein
  assumes you might be running a 3B quantized GGUF on a laptop.
- The human-voice section of the system prompt is *hardcoded*: first person,
  contractions, no "Great question!", no throat-clearing, have a point of
  view, say exactly what failed.
- `rein improve` + the `LESSONS.md` convention — the harness eats its own
  dogfood on a schedule.
- Native Obscura `web_search`/`web_fetch`, with no hosted API key.
- `gates` + vendored unlazy — completion discipline with runnable oracles.
- The Dareecho tier: Learn dossiers, export runbooks, OS planning, and the
  Mastra Factory wrap — all under the same approval and budget controls.

## Layout

```
src/
├── ai/
│   ├── types.ts               message model, event protocol, Tool/Model/Context
│   ├── event-stream.ts        async queue + iterator + final-result promise
│   ├── sse.ts                 SSE line parser
│   ├── openai-completions.ts  the adapter (native + text tool protocols)
│   ├── cli-provider.ts        official Codex/Copilot/Grok CLI transports
│   ├── endpoints.ts           URL inference + authenticated model discovery
│   ├── ssh.ts                 request-scoped SSH forwarding for remote APIs
│   ├── compat.ts              capability table + runtime fallback + learned modes
│   └── models.ts              local-server discovery + provider presets + config
├── hardware/                  (stolen from Magnitude, Apache-2.0)
│   ├── profile.ts             sysctl/vm_stat + /proc: cpu, ram, gpus, bandwidth
│   ├── catalog.ts             curated local-model catalog
│   ├── fit.ts                 fits/tight/no + tok/s estimate, reserves
│   └── report.ts              `rein hardware` renderer
├── agent/
│   ├── agent-loop.ts          the loop (steering, parallel tools, hooks, safety)
│   └── session.ts             JSONL sessions, branch, list
├── harness/
│   ├── system-prompt.ts       WHO + voice + work rules + self-improvement
│   ├── runner.ts              model+loop+compat wiring (shared by all modes)
│   ├── repl.ts                interactive mode
│   ├── print.ts               one-shot mode
│   ├── improve.ts             self-improvement loop (autoresearch on this repo)
│   ├── loop.ts                experiment loop (TASK.md + METRIC.md)
│   ├── nodeterm.ts            nodeterm surface: status hooks + phone approvals
│   └── tools/                 read write edit bash grep find ls web(Obscura) gates(unlazy)
├── os/
│   ├── command.ts             `rein os` dispatch (plan | prepare | rain | rainmeter | skin | factory)
│   ├── plan.ts                machine assessment + installation gates
│   ├── prepare.ts             Omarchy / ChromeOS kit staging
│   ├── rain.ts                the rain motif preview
│   ├── rainmeter.ts           Rainmeter rebuild report
│   ├── skin/                  Rainmeter-model skin engine, install, list
│   └── factory.ts             `rein os factory` verbs over the shared supervisor
└── util/                      ansi · json-salvage · schema · truncate
apps/
├── klaud/                     native Mac app (AG-UI server, bots, chat, iOS companion)
└── factory/                   Mastra Factory native app + the shared supervisor
│   ├── main.mjs               app shell; drives apps/factory/supervisor.mjs
│   ├── supervisor.mjs         server lifecycle: start (production|dev) stop status open
│   ├── provision.mjs          template copy, credential key, .env — refuse to overwrite
│   ├── package-macos.mjs      signing, notarization, ZIP roundtrip
│   └── test/                  11 tests
vendor/
├── unlazy/                    Leonxlnx/unlazy (MIT): gate ledger + oracles
├── pi-posthorse/              pinned upstream 0.4.1 (MIT) + native adaptation
├── meat/                      Bold Software Meat (pinned) — WASM diff review
└── mastra-factory/            softwarefactory-template pure copy + PROVENANCE.md
test/
├── mock-server.ts             deterministic OpenAI-compatible server (4 models)
├── smoke.ts                   full-pipeline e2e scenarios
└── *.test.ts                  regression suites (896 passing)
```

## Testing

CI tests the newest Node.js release using the `node` version alias, alongside
the numbered versions in our compatibility range. Browser smoke tests cover
Linux, macOS, and Windows on Node 18 and the newest release.

```sh
npm test                    # offline smoke + node:test regression suites (root)
npm test --prefix apps/factory   # the Mastra Factory app + supervisor suite
npm run bundle              # rebuild the committed Node 18 CLI (byte-reproducible)
npm run check:posthorse     # verify the pinned upstream source/license snapshot
npm run check:natives       # Fold, Matt Pocock and Meat provenance
npm run test:meat-upstream  # Go 1.26.5: offline upstream algorithm tests
npm run check:meat          # Go 1.26.5: reproduce and compare the shipped WASM
```

Covers: JSON salvage, edit semantics, capability table, hardware profile +
fit assessment, the plain-JSON adapter path, doctor + heartbeat parsing, the
full Mastra Factory supervisor (profiles, lifecycle, stale pid, foreign
port, setup idempotence, dispatch), and three e2e scenarios on the mock
server — native tools, text protocol, and broken-native → runtime fallback
(the tool actually executes in each).

## Running under nodeterm

[nodeterm](https://nodeterm.dev) is a canvas that hosts **real tmux
sessions** — each node is a live terminal that survives app restarts and
machine reboots — and its **iOS companion pairs to the same tmux session**.
rein plugs into it as a custom agent:

```
Settings → Custom agents
  Label:          rein
  Launch command: rein --ask bash,write      (or just: rein)
```

- **Persistence, twice** — tmux keeps the session alive across app restarts;
  rein's JSONL sessions (`/resume`, `/branch`) keep the conversation across
  machine reboots.
- **Status** — inside a nodeterm node rein reports Claude-style hook events
  to nodeterm's loopback hook server, plus the terminal title.
- **Approvals from the phone** — with `--ask bash,write` (or `/ask` in the
  REPL), gated tools go through nodeterm's pending-files protocol. The
  answer channel is the filesystem, not loopback, so a phone over SSH can
  answer.

The integration lives in one file (`src/harness/nodeterm.ts`) and is inert
unless the `NODETERM_*` env is present. nodeterm is a surface, not a
dependency: BUSL-1.1 license, no code coupling either way.

## Known limits (honest list)

- Single model per session (no mid-run model switching)
- Subscription login needs a current official CLI and an eligible account.
  Cloud login/paid inference is not exercised by offline tests.
- Token usage depends on what the provider reports. Thinking is shown as
  status. Meat produces a reading diff after inference, not a patch
  approval UI.
- Posthorse uses estimated token budgets. Configure the server's actual
  context limit.
- `rein loop` and `rein improve` require a clean Git root with an initial
  commit.
- Mastra Factory's first `setup` needs network access to install its
  dependencies; the app itself runs from the installed project. Factory's
  production profile requires a `DATABASE_URL`; the dev profile does not.
- `rein os prepare` stages overlay kits for development VMs; it does not
  produce a bootable Dareecho image.
- Text tool protocol assumes the model can follow one example; 1–3B models
  still need nudging (the fallback nudge is built in)

## Credits

Architecture: [earendil-works/pi](https://github.com/earendil-works/pi)
(especially `packages/ai` — "the hard part is the translation layer" — and
`packages/agent`). Loop philosophy:
[karpathy/autoresearch](https://github.com/karpathy/autoresearch).
Simplicity bar: [karpathy/nanoGPT](https://github.com/karpathy/nanoGPT).
Context windows: [fitchmultz/pi-posthorse](https://github.com/fitchmultz/pi-posthorse)
(MIT, pinned source and native Rein adaptation). Completion discipline:
[Leonxlnx/unlazy](https://github.com/Leonxlnx/unlazy) (MIT, vendored).
Web engine: [Obscura](https://github.com/h4ckf0r0day/obscura), Apache-2.0,
with a pinned native runtime. Search results: DuckDuckGo HTML.
Hardware fit: [magnitudedev/magnitude](https://github.com/magnitudedev/magnitude)
(Apache-2.0). Diff review: [Bold Software Meat](https://github.com/boldsoftware/meat),
pinned under `vendor/meat/`. Fold and Matt Pocock workflows, pinned under
`vendor/`.

Mastra Factory: [mastra-ai/mastra](https://github.com/mastra-ai/mastra)
(`@mastra/factory`) and
[mastra-ai/softwarefactory-template](https://github.com/mastra-ai/softwarefactory-template),
Apache-2.0. Installed as itself — Mastra's name, UI, and icon — as a native
app alongside Dareecho, with the template vendored as a pure copy.

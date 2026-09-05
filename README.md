# rein

A minimal, local-first agent harness. Three layers, zero runtime dependencies,
any OpenAI-compatible model — local by default, any provider by choice.

```
┌─────────────────────────────────────────────────────────────────┐
│  harness/   REPL · print · improve · loop · tools (7)          │  ← the product
├─────────────────────────────────────────────────────────────────┤
│  agent/     event-driven loop · steering · sessions (JSONL)     │  ← the behavior
├─────────────────────────────────────────────────────────────────┤
│  ai/        one message model · one event protocol · compat    │  ← the translation
│             Ollama · LM Studio · llama.cpp · vLLM · any API    │
└─────────────────────────────────────────────────────────────────┘
```

Built by studying two codebases:

- **[pi](https://github.com/earendil-works/pi)** — the architecture. Its
  `packages/ai` proves that the hard part of an agent harness is the
  *translation layer* (one message model + one streaming event protocol over
  every provider quirk), and its `packages/agent` proves the loop is just:
  stream → run tools (parallel) → repeat, with steering queues, hooks, and
  truncation safety. rein rebuilds both layers from scratch in ~4,300 lines
  of its own code (plus 2.5k lines of vendored unlazy, MIT) with zero runtime dependencies, because "runs anywhere Node runs" is the point. (One dev-only tool, esbuild, bundles the CLI to plain JS at publish time — Node won't type-strip `.ts` under `node_modules`.)
- **[karpathy/autoresearch](https://github.com/karpathy/autoresearch)** — the
  *loop* that runs an agent forever against one metric, keeping what improves
  and discarding what doesn't. rein encodes that twice: `rein loop` (any
  project, any metric) and `rein improve` (the harness itself is the target).

And **[karpathy/nanoGPT](https://github.com/karpathy/nanoGPT)** — the values:
readable over clever, small over complete. Every file here fits on a screen
or two.

## Requirements

- Node ≥ 18 for the installed CLI (ships prebuilt; zero runtime deps)
- Node ≥ 23.6 (or ≥ 22.18) to develop from source or run the test suite
  (native TypeScript type-stripping)
- Any OpenAI-compatible server. Local ones are probed automatically in
  priority order: **Ollama** → **LM Studio** → **llama.cpp** → **vLLM**.

## Install

One-liner (macOS / Linux / WSL) — installs the harness and walks you through
model setup (the openclaw / hermes style onboarding):

```sh
curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh | bash
```

Flags after `bash -s --`: `--skip-setup` (install only), `--yes` (no prompts).
The wizard detects local AI servers (Ollama, LM Studio, llama.cpp, vLLM),
accepts remote hosts, and offers cloud API keys or supported subscription logins.
It tests API connections and saves `~/.rein/config.json` (or `$REIN_HOME/config.json`).
You can always re-run it: `rein setup` (`--yes` non-interactive,
`--status` config + connection check).

Or install manually:

```sh
npm install --global git+https://github.com/Zermo/rein-agent.git
rein setup
```

The CLI ships prebuilt (`dist/rein.js`, committed), so the install needs no
build step and no devDependencies. To rebuild the bundle after changing
source: `npm install && npm run bundle` (esbuild, dev-only).
The compatibility commands `rein-agent` and `rein` point to the same CLI.

Developing from source: `npm install && npm test` (offline smoke and regression suites).

```sh
# local (the default):
ollama serve && ollama pull qwen2.5-coder:7b
rein-agent

# any provider:
rein-agent --provider deepseek --model deepseek-chat
rein-agent --provider openai --model gpt-4o
REIN_BASE_URL=http://localhost:11434/v1 REIN_MODEL=qwen2.5-coder:7b rein-agent -p "hello"
```

## Usage

```
rein-agent                    interactive REPL (sessions persist, steering mid-run)
rein-agent -p "query"         one-shot; --json for the raw event stream
rein-agent loop               autonomous experiment loop (TASK.md + METRIC.md)
rein-agent improve [goal]     self-improvement loop on this repo
rein-agent gates [file] --mode m  unlazy gates: lint | status | approve | reverify
rein-agent models             what rein can see: local servers + provider presets
rein skills [name]            bundled Matt Pocock workflows and references
rein debug <folder> [--json]  offline exported-session diagnostics (counts only)
rein-agent hardware [--json]  profile this machine + what it can run (tok/s estimates)
rein doctor [--fix]           auto-detect the whole stack; --fix self-repairs it
rein heartbeat [--init]       self-sustaining beat: self-heal → HEARTBEAT.md tasks → self-advance
rein setup                    onboarding wizard (also: --yes, --status)
rein login codex|copilot       official browser/device account sign-in
rein --version                print version
```

REPL commands: `/help /new /model /tools /sessions /resume <id> /branch /context /new-context [handoff] /skills /skill <name> <task> /stop /quit`.
While the agent is working, just type — it's injected as a steering message
after the current tool batch (pi's steering, not pi's queue).
`/stop` immediately cancels the current turn and its owned shell process group.
Queued input is discarded; send a new request when ready to continue.

### Native Fold components and Matt Pocock workflows

Rein integrates [Fold](https://github.com/humanlayer/fold)'s repeated-tool-batch
detector and UTF-8 output truncation, with a native skill loader based on its
stable roster design. This is a component integration, not the full Fold CLI.
Three identical consecutive tool batches stop the run with an incomplete-work
notice. Set `repeatToolLimit` to 0 to disable, or an integer from 2 to 50 to tune it.
Shell output keeps up to 500 lines / 20 KB, including single-line output.

[Matt Pocock's skills](https://github.com/mattpocock/skills) ship as native
workflows: `diagnosing-bugs`, `tdd`, and `code-review`. The model loads them
through `skill`; users can invoke `/skill diagnosing-bugs <task>` in the REPL.
`rein skills tdd tests.md` reads a bundled reference without starting inference.
Bodies load on demand without changing the system prefix. Scripts stay inert
unless separately executed within the user's request. Skills do not themselves
provide sub-agent tools.

`rein debug /path/to/export` reads JSONL sessions offline. It reports counts of
empty responses, provider errors, nested recovery, path mistakes, large outputs,
and repeated tool batches. `--json` includes counters per session in sorted
file order; output never includes transcript text, filenames, or credentials.
The analyzer reads at most 200 files, 32 MB per file, 256 MB total, and skips
records above 8 MB. See the [September export diagnosis](docs/debug-2026-09-05.md)
for findings, fixes, and limitations. Both upstreams are pinned under `vendor/`;
`npm run check:natives` verifies their source and license hashes.

### Remote servers, API keys, and subscription login

For a server reachable over LAN or NetBird, enter its hostname or IP and port.
Rein detects common API prefixes, accepts pasted `/models` or `/chat/completions`
URLs, and preserves custom proxy paths. It probes only the host and port you supply.

```sh
rein setup --base-url dgx.internal:18083
# Unattended setup discovers the model; set REIN_API_KEY in the environment if required:
rein setup --yes --base-url dgx.internal:18083
```

A server bound to `127.0.0.1` on the DGX is reachable only from that DGX.
Use an existing SSH alias to reach it without changing the server listener:

```sh
ssh dgx                            # verify your existing SSH key/config
rein setup --yes --ssh dgx --base-url 127.0.0.1:18083
rein -p "hello"                    # reconnects through SSH automatically
rein setup --status
```

The tunnel listens on an ephemeral local loopback port and closes after each
request. SSH forwarding supports HTTP APIs, requires noninteractive SSH key
authentication, and uses the remote host's view of the target URL. Direct HTTPS
APIs use their reachable URL. Connection errors distinguish DNS, refusal, timeout,
authentication, missing API paths, and responses from a web UI.

For cloud APIs, setup opens the provider's key page when a key is needed, then
queries the authenticated model list. Standard environment variables such as
`OPENAI_API_KEY` or `GEMINI_API_KEY` work; `REIN_API_KEY` explicitly supplies a key
for a custom endpoint. Environment keys are not saved. Entered keys are hidden,
stored in a mode-600 config, and scoped to the saved API endpoint and SSH host.
Switching endpoints cannot reuse that saved key automatically.

```sh
rein setup --provider openai
rein setup --provider gemini
rein setup --provider openrouter --no-browser  # print the key-page link
```

Subscription connections use installed official CLIs:

| Connection | Install once | Configure Rein |
| --- | --- | --- |
| ChatGPT through Codex | `npm install -g @openai/codex` | `rein setup --provider codex` |
| GitHub Copilot | `npm install -g @github/copilot` | `rein setup --provider copilot` |

Setup opens device sign-in and lets the official CLI display the one-time code.
`rein login codex` or `rein login copilot` repeats login; `--device-auth=false`
selects the CLI's browser callback flow. `--no-browser` prints the link without
launching a browser. Login requires user interaction; `setup --yes` never starts it.
ChatGPT device login may need enabling in your account or workspace security
settings. Subscription access and API billing are separate. See the official
[Codex authentication guide](https://learn.chatgpt.com/docs/auth) and
[Copilot authentication guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli).

Rein gives each CLI its own configuration under `$REIN_HOME/cli-auth` and leaves
credential storage and refresh to that CLI. Copilot may use its shared OS keychain.
Use `rein login`, rather than a bare CLI login, to select Rein's configuration.
The default model follows the official CLI; pass `--model` for an available model.
CLI responses use Rein's text tool protocol and retain Rein's tool approvals and
Posthorse history. Each turn starts in a temporary directory with native tools
disabled or sandboxed; unexpected native Codex tool events stop the turn.
CLI output is returned when that CLI turn finishes, rather than token by token.
These bridges require current CLIs with the isolation flags used by Rein.

Gemini API uses its documented [OpenAI-compatible endpoint](https://ai.google.dev/gemini-api/docs/openai).
The retired GitHub Models API is no longer offered; [GitHub's retirement notice](https://docs.github.com/en/github-models)
applies to that API, while Copilot CLI is a separate connection. Other subscription
CLIs are not integrated. Compatible cloud APIs continue to use API keys.

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
The pinned upstream 0.4.1 source and MIT license are in `vendor/pi-posthorse`.
Rein uses its own session and tool interfaces, so it needs neither the Pi fork
nor additional runtime dependencies.

The default toolset includes:

- `get_context_remaining({})` reports estimated tokens until rollover and the hard limit.
- `new_context({handoff?})` requests a fresh window after the entire tool batch succeeds.
  A failed or cancelled sibling prevents the boundary from committing.
- `notes({op, path?, content?, query?, offset?})` lists, reads, writes, appends,
  or searches plaintext files in `.pi/notes`. Reads and searches are paged.
- `history({op, query?, id?, all?, limit?, offset?})` searches and reads saved
  messages across windows. Results include stable entry and window ids.
  `all: true` includes sessions from the same repository and deduplicates forks.

A rollover removes earlier messages from model input while keeping the complete
transcript. The new window gets an optional handoff. Automatic rollover uses a
bounded record of user inputs, an older checkpoint, and the latest unconsumed
tool batch, with history references for the full text. It makes no summarization
request. The record is not proof of progress; the agent must restore notes and
check live state before continuing. A single input that cannot fit a fresh window
still needs a larger context setting or a smaller input.

Automatic rollover and one best-effort checkpoint reminder are enabled with the
default tools. Context overflow errors get at most one recovery retry for the same
request, within `--max-turns`. Configuration in `~/.rein/config.json`:

```json
{
  "contextWindow": 32768,
  "maxTokens": 4096,
  "posthorse": { "enabled": true, "reserveTokens": 4096 }
}
```

Set `contextWindow` to the server's actual configured limit. Token counts are
estimates refined by reported usage. The reserve must cover the output limit and
leave room for the prompt, tools, and recovery state. CLI overrides are
`--context-window <tokens>`, `--reserve-tokens <tokens>`, and `--no-auto-context`.
Manual `/new-context [handoff]` and the `new_context` tool remain available when
automatic rollover is disabled. `/context` prints the current budget.

Sessions persist incrementally in the REPL and with `-p --save`. Reopening a
non-empty session creates a fresh resume window: it retains the full archived
transcript in `history`, then layers the current Git checkpoint, a squashed diff
since that session's checkpoint, the newest peer-session handoff, and
`.pi/notes/MEMORY.md` over the next model request. This makes a week-old branch
safe to continue after another session changed the repository without replaying
all of its old tool calls. The overlay is factual workspace evidence, not a
generated summary; verify live state before an external action. Branch preserves
window boundaries, and old Rein JSONL sessions remain readable. Print,
loop, and improve runs without a saved session retain history only for the lifetime
of their runner. Supplying a custom `RunnerOptions.tools` array replaces the
entire toolset and disables automatic rollover by default; `--no-tools` remains
pure chat.

Notes belong to the repository and are shared by linked worktrees. Normal
worktrees use the main checkout. Repositories with a separate Git directory use
`core.worktree` when configured, or the common Git directory otherwise. Outside
Git, notes belong to the working directory. Rein ignores `.pi/notes/` in this repo;
add that ignore rule to other projects if their working notes should stay local.
Notes survive session changes and package removal. History reads send the selected
stored text to the active model provider. Pi's JSONL sessions and image/custom
message types are not supported by this adaptation.

For llama.cpp and compatible local HTTP servers, Rein sends `cache_prompt: true`.
llama.cpp can reuse an unchanged live prompt prefix; `/context` shows
`lastPromptCacheTokens` when the server reports it. Provider KV cache is
opportunistic: a stopped server, evicted slot, or a week-old archived request
cannot restore its transformer state. The durable resume overlay provides the
cross-session continuity in that case.

### Web: TinyFish is the web layer

Two tools, one free API key (tinyfish.ai — Search and Fetch never draw from
the wallet):

```
web_search  fresh, never-cached, structured results (site:, recency, news,
            research-paper modes) — find the page
web_fetch   any URL → clean LLM-ready markdown, real browser behind it — read it
```

Key: `TINYFISH_API_KEY`, or `~/.rein/config.json` → `{"tinyfish": {"apiKey": "..."}}`.
The system prompt tells the agent to search first, fetch only the 1–2 pages
that matter, and name the URL behind every web-sourced fact. If the key is
missing the tool says so plainly instead of failing mysteriously.

### Completion gates (unlazy)

[unlazy](https://github.com/Leonxlnx/unlazy) (MIT, vendored at `vendor/unlazy/`)
is the anti-laziness discipline: write an acceptance ledger **before** the
work, run oracles that can actually fail, reverify before reporting done.

```
rein gates GATES.md --mode lint        # oracles that cannot fail? caught now
rein gates GATES.md --mode status      # report only — never executes
rein gates GATES.md                    # = --mode approve: approve exact oracles, run them
rein gates GATES.md --mode reverify    # re-run everything; demote stale evidence
```

A gate passes only when its command exits 0 **and** `EXPECT:` matches the
output; the ledger records shell, CWD, exit status, and a SHA-256 output
fingerprint as `EVIDENCE:`. Untested claims are not evidence — a checked box
without evidence counts as unmet. Approval is the trust boundary: a `CHECK:`
line is never executed until its exact command+CWD+PATH oracle is approved
(stored in `~/.unlazy/approved`, outside the repo by design).

The agent sees all of this as one tool (`gates`) and a section of the system
prompt: substantial work starts with `GATES.md` from
`vendor/unlazy/templates/gates-leaf.md`. The repo's own `GATES.md` is the
ledger for the current integration work — every box checked with evidence.

### Self-improvement

```sh
rein improve "make tool errors more actionable"   # or: rein improve (uses LESSONS.md)
```

The loop (autoresearch's keep/discard, pointed at rein's own source):

1. read the goal or the `## harness` section of `LESSONS.md`
2. one concrete weakness → smallest fix
3. run `npm test`, including the smoke and regression suites
4. pass → commit the change and lesson · fail → discard the experiment and commit its lesson
5. repeat until `--max-iterations` (default 5) or the agent says no-change

Two things make it a *system* rather than a one-off: the system prompt tells
every agent to append durable learnings to `LESSONS.md` (shared memory across
sessions, loaded on next start), and `rein improve` reads exactly that file.
The agent that bumps into a sharp edge writes it down; the improve loop cuts
the edge.

### Self-sustaining — `rein doctor` + `rein heartbeat`

The baseline for agents that keep themselves alive and advancing. Two commands:

```sh
rein doctor [--fix]    auto-detect: node → bin → repo → bundle → config →
                       server → model → hardware fit → perms → disk
                       --fix repairs what it can (git pull, rebuild bundle,
                       ollama pull, chmod) and re-checks. exit 1 if anything
                       is still broken — scriptable in CI and cron.

rein heartbeat         one beat, four phases, in order:
                       1. SELF-HEAL    rein doctor --fix
                       2. TASKS        each HEARTBEAT.md line → an agent run
                       3. SELF-ADVANCE one `rein improve` iteration (goal from
                                      `# improve: <goal>` in HEARTBEAT.md or --improve)
                       4. MEMORY       JSONL entry → ~/.rein/heartbeat.log
```

`HEARTBEAT.md` (the openclaw/hermes pattern) is a file of periodic tasks —
one per line, `#` lines are comments, empty = idle beat (self-heal only).
Seed one with `rein heartbeat --init`. The beat repairs its own runtime
before doing any work, so a stale checkout or stale bundle heals itself on
the next tick instead of waiting for a human to notice:

```sh
rein heartbeat --init          # write a template, edit it
*/30 * * * * rein heartbeat >> ~/.rein/heartbeat.cron.log 2>&1
```

That ordering is the point: *perception (doctor) → action (tasks) →
egeneration (improve) → memory (log)*. An agent that can check itself,
fix itself, do its periodic work, and improve itself from its own lessons
is the baseline for fully self-sustaining agents.

### Proactive work from task history

`rein autonomy` adds a background supervisor and a terminal dashboard. It uses
the host's user service manager: launchd on macOS, or systemd on Linux. Setup
offers the commands; installing the package alone does not start inference.

Start in a workspace whose Rein history you want the supervisor to inspect:

```sh
rein autonomy init
rein autonomy scan
rein autonomy tui
```

The first command enrolls the directory and leaves the supervisor paused. The
scan compares older and recent user/assistant excerpts with current Git status
and change statistics. A tool-free adviser proposes work; a second tool-free
reviewer checks it against the evidence. Unchanged history makes no model calls.
Prior approval decisions and completed run reports inform later suggestions.

The dashboard shows the exact task, workspace, cadence, reason, and cited history
excerpts before approval. Use arrows or j/k to select, `a` to review approval,
`d` to dismiss, `r` to queue an enabled task, `p` to pause/resume, and `q` to exit.
New pending proposals produce dashboard alerts. The regular REPL also reports
new proposals between turns; `/autonomy` shows their status.

Start the background service after reviewing its scope:

```sh
rein autonomy enable
rein autonomy status
rein autonomy pause
rein autonomy resume
rein autonomy disable
```

`enable` enrolls the current directory and registers only Rein's own user service.
`disable` pauses work, stops the service, and removes its registration, keeping
reports and decisions. `rein autonomy plan` prints the generated service
definition. Unsupported hosts can use `rein autonomy resume` followed by
`rein autonomy daemon` in a terminal. User services depend on the login session;
Linux persistence after logout requires a host already configured for it. The
supervisor does not prevent system sleep or attach to other applications.

The service uses saved Rein configuration and official CLI login profiles.
Terminal exports such as `REIN_BASE_URL`, `REIN_MODEL`, or API keys may be absent
from its environment. `enable` checks for those differences and stays paused
until startup is confirmed. Save the intended settings with `rein setup`, or use
`rein autonomy daemon` from the configured shell. API keys are never copied into
service definitions. To save an API key through interactive setup, unset its
shell variable for that command, then enter the key and choose to save it.
For an SSH tunnel to a DGX, the service also needs noninteractive SSH access;
an agent available only through the terminal's `SSH_AUTH_SOCK` may be unavailable.

Dashboard approvals enable read-only inspection with bounded `read`, `ls`, and
literal `search` tools. These tools exclude links, hidden files, and common
credential files. For a task that needs editing or command execution, review
`rein autonomy show <id>` and explicitly run:

```sh
rein autonomy approve <id> --allow-writes
```

This grants the normal Rein tools, including shell commands and file writes,
for that proposal. Those tools run with your account's permissions; the working
directory is not an OS sandbox. Revocation and pause cancel active background
work, and each tool call checks that its approval still applies.

Routine proposals recur at their approved interval. Loop and project proposals
receive one bounded run; continuing a larger project needs another explicit
run. Runs save a normal Rein session and a report. Generated sessions and their
forks cannot become fresh evidence of user intent.

Defaults are one history check per hour, six operations per rolling 24 hours,
eight model turns per approved run, and a 180-second cancellation deadline.
A scan uses at most two model generations and counts as one operation. Limits
can be set with `init --interval 60 --daily-budget 6 --turn-budget 8 --timeout 180`.
Scans and runs share a lock and budget; model failures are recorded and scans
wait until their next interval before retrying.

Enrollment is explicit and limited to 32 directories. Use
`rein autonomy init --workspace /absolute/path` for additional workspaces. The
command `rein autonomy unenroll --workspace /absolute/path` removes a workspace
and disables its tasks. The
collector reads only Rein JSONL histories matching those directories, at most
200 sessions with bounded older/recent excerpts. It omits tool bodies, thinking,
and recognizable credentials. Chat histories from other apps are not imported.
The selected evidence and inspected file text are sent to your configured model.
Learning here consists of persisted reports and review decisions, stored in
`$REIN_HOME/autonomy/state.json`. State retains at most 100 proposals and 200 run
reports; full run sessions remain in the normal Rein session archive.

### Autonomous experiment loop

```
your-project/
├── TASK.md      what to improve (agent-readable)
└── METRIC.md    fenced bash block; its output must print METRIC=<number>
rein loop --max-iterations 10
```

Run from a clean Git repository root with an initial commit, including `TASK.md`
and `METRIC.md`. The harness owns commits and discards; if the agent changes
HEAD, the loop stops for review.

Fixed budget per iteration, one metric, keep/discard with git, auto-stops
after three no-change iterations, never otherwise stops until the budget or a
Ctrl-C. This is autoresearch's `program.md` loop with the harness as the
operator.

### Local model fit — `rein hardware`

Stolen concept from [Magnitude](https://github.com/magnitudedev/magnitude)
(Apache-2.0): profile the machine, then tell you what you can actually run —
with a per-domain memory model (system RAM vs VRAM, unified memory handled as
one pool) and reserves before a model may claim memory (`max(pool/10, 2 GiB)`).

```
rein hardware
  Apple M5 Pro · 18 cores
  48 GB unified memory (26 GB available) · ~307 GB/s (est)

  what you can run (7)
  ✓ ~121 tok/s  DeepSeek Coder V2 Lite 16B  16B · 2B active  Q4_K_M  unified
  ✓ ~91 tok/s   GPT-OSS 20B (MoE)           21B · 4B active  MXFP4   unified
  ✓ ~38 tok/s   Qwen2.5-Coder 7B            8B               Q4_K_M  unified
  ...
  tight — fits only if other memory hogs are closed
  △ tight  Qwen3 30B-A3B (MoE)   31B · 3B active  Q4_K_M  unified
  △ tight  Qwen2.5-Coder 32B     33B              Q4_K_M  unified

  out of reach: GPT-OSS 120B (MoE)

  best pick: DeepSeek Coder V2 Lite 16B
    ollama pull deepseek-coder-v2:16b
    weights 9 GB + KV ~3 GB @ 16k ctx, after 5 GB reserve
```

The math is deliberately visible and rough: footprint = weights
(`params × bytesPerWeight`) + KV estimate @ 16k ctx, minus reserves; tok/s ≈
`bandwidth / bytes-per-token` (MoE: active params only) × 0.55 efficiency.
Directional, not a benchmark — the point is to stop guessing between a 7B and
a 32B before you've spent an hour downloading. `rein models` shows a
best-5 fit section, and the `rein setup` wizard marks each detected model
with its verdict. `--json` for machines.

## Architecture notes (what I took from pi, and where I cut)

**Kept — it's load-bearing:**

- The `ai` layer as a *translation* layer: one message model
  (user / assistant[content blocks] / toolResult), one streaming event
  protocol (`start → *_start → *_delta → *_end → done|error`) over an async
  iterable with a final-result promise. Errors are *in* the stream, never
  thrown at the caller. The OpenAI-compatible adapter handles: missing
  `finish_reason`, missing usage (estimated), `stream_options` rejection,
  reasoning/thinking deltas, tool-call argument chunking.
- The agent loop's control points: **steering** (inject after the current
  tool batch), **follow-up** (run when the agent would stop), parallel tool
  execution with per-tool `sequential` override (bash), `before/afterToolCall`
  hooks, `shouldStopAfterTurn`, **truncation safety** (a `length` stop means
  tool args may be cut — those calls are failed with an explanatory result,
  not executed with half-arguments).
- Sessions as append-only JSONL with a header line; branching = copy +
  append. One file, greppable, resumable.
- Short system prompt; minimal toolset: `read write edit bash grep find ls`.

**Cut — deliberate:**

- No image/audio blocks or native provider-specific reasoning APIs.
  OpenAI-compatible HTTP and official CLI adapters share the same message model.
- No framework: no React TUI, no config DSL. A REPL is ~200 lines of
  readline; the print mode is ~80.
- TypeBox → a 60-line hand-rolled schema validator for the subset we use.
- Zero runtime package dependencies; subscription connections use separately installed CLIs.

**Added (requirements):**

- The tool-capability compatibility layer (above) — pi assumes capable
  models; rein assumes you might be running a 3B quantized GGUF on a laptop.
- The human-voice section of the system prompt is *hardcoded*: first person,
  contractions, no "Great question!", no throat-clearing, have a point of
  view, say exactly what failed. The way the agent talks is part of the
  spec, not a prompt suggestion.
- `rein improve` + the `LESSONS.md` convention — the harness eats its own
  dogfood on a schedule.
- TinyFish `web_search`/`web_fetch` — the web layer, one free key.
- `gates` + vendored unlazy — completion discipline with runnable oracles,
  wired in as both a tool and a `rein gates` CLI.

## Layout

```
src/
├── ai/
│   ├── types.ts               message model, event protocol, Tool/Model/Context
│   ├── event-stream.ts        async queue + iterator + final-result promise
│   ├── sse.ts                 SSE line parser
│   ├── openai-completions.ts  the adapter (native + text tool protocols)
│   ├── cli-provider.ts        official Codex/Copilot CLI transports
│   ├── endpoints.ts           URL inference + authenticated model discovery
│   ├── ssh.ts                 request-scoped SSH forwarding for remote APIs
│   ├── compat.ts              capability table + runtime fallback + learned modes
│   └── models.ts              local-server discovery + provider presets + config
├── hardware/                  (stolen from Magnitude, Apache-2.0)
│   ├── profile.ts             sysctl/vm_stat + /proc: cpu, ram, gpus, bandwidth
│   ├── catalog.ts             curated local-model catalog (params, MoE active, quants)
│   ├── fit.ts                 fits/tight/no + tok/s estimate, reserves, unified memory
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
│   └── tools/                 read write edit bash grep find ls web(TinyFish) gates(unlazy)
└── util/                      ansi · json-salvage · schema · truncate
vendor/
└── unlazy/                    Leonxlnx/unlazy (MIT): SKILL.md + gate-check.mjs + templates + references
test/
├── mock-server.ts             deterministic OpenAI-compatible server (4 models)
└── smoke.ts                   28 checks incl. 3 full-pipeline e2e scenarios
```

## Testing

```sh
npm test          # offline smoke + node:test regression suites
npm run bundle    # rebuild the committed Node 18 CLI
npm run check:posthorse  # verify the pinned upstream source/license snapshot
```

Covers: JSON salvage (7), edit semantics (6), capability table (5),
hardware profile + fit assessment (5), the plain-JSON adapter path (issue #1),
doctor + heartbeat parsing + an idle beat end-to-end, and three
the mock server — native tools, text protocol, and broken-native → runtime
fallback (the tool actually executes in each).

## Running under nodeterm

[nodeterm](https://nodeterm.dev) is a canvas that hosts **real tmux sessions** —
each node is a live terminal that survives app restarts and machine reboots —
and its **iOS companion pairs to the same tmux session** (watch an agent work,
type into it, answer prompts; off-network it's E2E-encrypted over a relay).
rein plugs into it as a custom agent:

```
Settings → Custom agents
  Label:          rein
  Launch command: rein --ask bash,write      (or just: rein)
```

What you get:

- **Persistence, twice** — tmux keeps the session alive across app restarts;
  rein's JSONL sessions (`/resume`, `/branch`) keep the conversation across
  machine reboots. Cold-restore replays scrollback; `rein` comes back in the
  same session.
- **Status** — inside a nodeterm node rein detects the injected
  `NODETERM_*` env and reports Claude-style hook events (turn start, tool
  start/end, done) to nodeterm's loopback hook server, plus the terminal
  title (`rein · bash`, `rein · needs you: write`, `rein · idle`) which is
  the status surface for custom-agent nodes.
- **Approvals from the phone** — with `--ask bash,write` (or `/ask` in the
  REPL), gated tools go through nodeterm's pending-files protocol
  (`~/.nodeterm/pending/<id>.json`, the phone writes `<id>.answer`). The
  answer channel is the filesystem, not loopback, so a phone over SSH can
  answer. On timeout, rein asks for local approval when a fallback is
  available; otherwise it denies execution, with a visible note. Outside a
  nodeterm node the same gate falls back to a
  `[y/N]` prompt on stdin.

The integration lives in one file (`src/harness/nodeterm.ts`) and is inert
unless the `NODETERM_*` env is present — running rein in a plain terminal
changes nothing. nodeterm is a surface, not a dependency: BUSL-1.1 license,
no code coupling either way.

## Known limits (honest list)

- Single model per session (no mid-run model switching)
- Subscription login needs a current official CLI and an eligible account. Cloud
  login/paid inference is not exercised by offline tests. Copilot has no read-only
  auth status command, so status reports its authentication as unverified until use.
- No live token counts, no thinking trace (shown as
  "thinking…"), no tool-call diff preview
- Posthorse uses estimated token budgets. Configure the server's actual context
  limit; a prompt or tool schema that cannot fit fresh still needs a larger window.
- `rein loop` and `rein improve` require a clean Git root with an initial commit.
  Commit or stash existing work before allowing automatic keep/discard.
- `rein improve` uses its own test suite as the metric. Tests still need to cover
  the behavior you expect it to preserve.
- Text tool protocol assumes the model can follow one example; 1–3B models
  still need nudging (the fallback nudge is built in)

## Credits

Architecture: [earendil-works/pi](https://github.com/earendil-works/pi)
(especially `packages/ai` — "the hard part is the translation layer" — and
`packages/agent`). Loop philosophy: [karpathy/autoresearch](https://github.com/karpathy/autoresearch).
Simplicity bar: [karpathy/nanoGPT](https://github.com/karpathy/nanoGPT).
Context windows: [fitchmultz/pi-posthorse](https://github.com/fitchmultz/pi-posthorse)
(MIT, pinned source and native Rein adaptation).
Completion discipline: [Leonxlnx/unlazy](https://github.com/Leonxlnx/unlazy)
(MIT, vendored — the gate ledger and runnable oracles).
Web layer: [TinyFish](https://www.tinyfish.ai) Search + Fetch APIs.
Hardware fit: [magnitudedev/magnitude](https://github.com/magnitudedev/magnitude)
(Apache-2.0 — concepts ported: hardware discovery, per-domain memory
reserves, Fits/DoesNotFit assessment, MoE-aware catalog).

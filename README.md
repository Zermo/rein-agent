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

## Install from GitHub

```sh
npm install --global git+https://github.com/Zermo/rein-agent.git
rein-agent
```

The CLI ships prebuilt (`dist/rein.js`, committed), so the install needs no
build step and no devDependencies. To rebuild the bundle after changing
source: `npm install && npm run bundle` (esbuild, dev-only).
The compatibility commands `rein-agent` and `rein` point to the same CLI.

Developing from source: `npm install && npm test` (55 checks, offline).

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
```

REPL commands: `/help /new /model /tools /sessions /resume <id> /branch /quit`.
While the agent is working, just type — it's injected as a steering message
after the current tool batch (pi's steering, not pi's queue).

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
3. run `node --experimental-strip-types test/smoke.ts` — the metric
4. pass → `git commit` + append the lesson · fail → `git checkout .`
5. repeat until `--max-iterations` (default 5) or the agent says no-change

Two things make it a *system* rather than a one-off: the system prompt tells
every agent to append durable learnings to `LESSONS.md` (shared memory across
sessions, loaded on next start), and `rein improve` reads exactly that file.
The agent that bumps into a sharp edge writes it down; the improve loop cuts
the edge.

### Autonomous experiment loop

```
your-project/
├── TASK.md      what to improve (agent-readable)
└── METRIC.md    fenced bash block; its output must print METRIC=<number>
rein loop --max-iterations 10
```

Fixed budget per iteration, one metric, keep/discard with git, auto-stops
after three no-change iterations, never otherwise stops until the budget or a
Ctrl-C. This is autoresearch's `program.md` loop with the harness as the
operator.

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

- No provider registry, no auth flows, no image/audio blocks, no reasoning
  provider-specific APIs. One adapter shape, extended by adding files.
- No framework: no React TUI, no config DSL. A REPL is ~200 lines of
  readline; the print mode is ~80.
- TypeBox → a 60-line hand-rolled schema validator for the subset we use.
- 40+ deps → 0. `package.json` has no `dependencies` key at all.

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
│   ├── compat.ts              capability table + runtime fallback + learned modes
│   └── models.ts              local-server discovery + provider presets + config
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
npm test          # node --experimental-strip-types test/smoke.ts
```

Covers: JSON salvage (7), edit semantics (6), capability table (5), and three
end-to-end pipelines against the mock server — native tools, text protocol,
and broken-native → runtime fallback (the tool actually executes in each).

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
  answer. Timeout fails open with a visible note, matching nodeterm's own
  reference behavior. Outside a nodeterm node the same gate falls back to a
  `[y/N]` prompt on stdin.

The integration lives in one file (`src/harness/nodeterm.ts`) and is inert
unless the `NODETERM_*` env is present — running rein in a plain terminal
changes nothing. nodeterm is a surface, not a dependency: BUSL-1.1 license,
no code coupling either way.

## Known limits (honest list)

- Single model per session (no mid-run model switching)
- No streaming UI niceties: no live token counts, no thinking trace (shown as
  "thinking…"), no tool-call diff preview
- Compaction isn't in yet: long sessions will eventually hit the context
  window (the loop will show the error; `--max-turns` bounds the damage)
- `rein improve` trusts its own smoke test as the metric — add more tests if
  you make it run unattended
- Text tool protocol assumes the model can follow one example; 1–3B models
  still need nudging (the fallback nudge is built in)

## Credits

Architecture: [earendil-works/pi](https://github.com/earendil-works/pi)
(especially `packages/ai` — "the hard part is the translation layer" — and
`packages/agent`). Loop philosophy: [karpathy/autoresearch](https://github.com/karpathy/autoresearch).
Simplicity bar: [karpathy/nanoGPT](https://github.com/karpathy/nanoGPT).
Completion discipline: [Leonxlnx/unlazy](https://github.com/Leonxlnx/unlazy)
(MIT, vendored — the gate ledger and runnable oracles).
Web layer: [TinyFish](https://www.tinyfish.ai) Search + Fetch APIs.

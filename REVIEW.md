# Review brief — rein

A minimal, local-first agent harness in ~4,300 lines of TypeScript (plus 2,500 lines of
vendored unlazy, MIT). Zero runtime dependencies. Built from two references:
pi's architecture (short prompt, small toolset, event-driven loop) and
karpathy/autoresearch (one metric, keep/discard, never stop until the budget runs out).

Pinned at commit `1e5bbfe` (run `git log --oneline` — the history is part of the review surface).

## Run it (no install step)

Requires Node ≥ 23.6 (native TypeScript type stripping; developed on v26.3.0).
There is no `npm install` — `package.json` has no `dependencies` key, by design.

```sh
node --experimental-strip-types test/smoke.ts     # 55 checks, fully offline (mock server)
node --experimental-strip-types test/mock-server.ts   # mock OpenAI server on :8123
REIN_BASE_URL=http://localhost:8123/v1 REIN_MODEL=mock-native node --experimental-strip-types bin/rein.js -p "run a command"
```

The smoke suite is the acceptance gate: it exercises JSON salvage, edit semantics,
the capability table, three end-to-end pipelines (native tools, text protocol,
runtime fallback), nodeterm approvals, TinyFish web tools (against a local mock),
and the unlazy gate checker (lint/status/approve/reverify).

## Read order

1. `src/ai/types.ts` + `src/ai/event-stream.ts` — the protocol. Errors are stream
   events, never exceptions at the caller.
2. `src/ai/openai-completions.ts` — the translation layer (the hard part).
3. `src/ai/compat.ts` — capability table, runtime fallback, learned modes.
4. `src/agent/agent-loop.ts` — steering, parallel/sequential tools, hooks, truncation safety.
5. `src/harness/runner.ts` → `system-prompt.ts` — the product layer.
6. `src/harness/tools/` — one file per tool, each <150 lines.
7. `vendor/unlazy/` — vendored skill; treat as upstream (don't review the vendored
   code line-by-line; review *how* it is wired in).

## Invariants (a change that breaks one is a bug, not a style choice)

- Zero runtime dependencies. If a fix needs a package, it needs a written argument.
- Local AI is the default provider (Ollama → LM Studio → llama.cpp → VLLM).
  Cloud presets exist but are never required.
- Tool capability is guaranteed for every model: native calling, text-protocol
  fallback, JSON salvage. A model that can't call tools must still work.
- Errors cross layer boundaries as events/return values, not thrown exceptions.
- `ctx.systemPrompt` is a live getter — mid-session fallback must be visible next turn.
- Human voice is hardcoded in the system prompt (first person, no "Great question!").
  It is part of the spec, not a prompt suggestion.
- `runner.run()` accepts both `string` and `AgentMessage`.
- Day/session state is append-only (JSONL sessions, LESSONS.md).
- unlazy oracles never execute before approval; approvals bind exact
  command+CWD+PATH and live outside the repo (`~/.unlazy/approved`).
- nodeterm integration is env-gated and inert in a plain terminal; hook POSTs are
  fire-and-forget (a dead hook server must never crash the agent).
- TinyFish failures surface as tool results the model can read, not process crashes.

## Already verified (don't re-litigate, do verify for yourself)

- 55/55 smoke checks passing on this machine at the pinned commit.
- The repo's own `GATES.md` (ledger for the web+gates integration) is ALL MET with
  SHA-256 evidence fingerprints — the unlazy loop eating its own cooking.
- `runner.run()` string normalization, REPL piped-stdin robustness, and the
  mock-broken → text fallback are each covered by tests that would fail without the fix.

## Review focus (ranked — this is where bugs would hide)

1. **Concurrency & lifecycle** — `agent-loop.ts` runs tools in parallel;
   `event-stream.ts` is a hand-rolled async queue. Look for races: steering
   mid-batch, abort/timeout while a tool is in flight, `Promise.all` settlement
   order vs. message order in the transcript.
2. **The translation layer** — `openai-completions.ts` + `json-salvage.ts`.
   Malformed JSON from small models is the whole point; is the salvage parser
   sound (nested braces, escaped quotes inside strings, empty args)?
3. **Compat/fallback state** — `compat.ts` + the runner's flip. Is the learned-mode
   store race-free? Can a model flap native→text→native in a way that confuses the
   transcript?
4. **gates tool** — `tools/gates.ts` shells out to vendored node with user-controlled
   file paths. Path handling, timeout behavior, and the exit-code→isError mapping
   (status-exit-1 is informational; approve-exit-1 is a failure) — deliberate, but
   easy to regress.
5. **TinyFish tools** — `tools/web.ts`. Key handling, per-URL error surfacing
   (`errors[]` comes back alongside HTTP 200), timeout sizes, response truncation.
6. **Session store** — `agent/session.ts`. JSONL append, resume, branch. Partial
   writes? Corrupt line handling?
7. **Prompt size discipline** — `system-prompt.ts`. Every line is sent to 3B local
   models. Flag anything that could be cut without losing meaning.

## Known limits (honest list — from the README)

- No auth on local servers (they're local).
- Compaction is a single summarization pass; long sessions degrade.
- Text-protocol parsing assumes well-formed `<tool>` blocks; salvage covers JSON,
  not broken block tags.
- Mock server models are deterministic scripts, not real model behavior.
- `rein improve`/`loop` discard with git — uncommitted files in a dirty repo get
  eaten (that lesson is in LESSONS.md).

## Report format

Findings ranked by severity (breaks-a-run > wrong-output > sharp-edge > nit), each with
`file:line`, what happens, and the smallest fix that respects the invariants above.
"Looks good" on a file you didn't run is not a finding — run the suite first, then
read. A finding list of zero is acceptable only if you say what you verified.

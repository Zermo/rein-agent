# LESSONS

Shared memory across sessions. One line per lesson, actionable, no preamble.
The `## harness` section is read by `rein improve` as its work queue.

## session

- [setup] uncommitted docs in the working tree get eaten by the loop's `git clean -fd` on discard — commit (or stash) new files before running improve/loop on a dirty repo

## harness

- [setup] improve loop's repo root was resolving to src/ — needs three dirnames from src/harness/
- [setup] `-p "query"` was falling through to the REPL because flags.p was a string, not true — check presence, not truthiness
- [setup] runner.run() must normalize string prompts to user messages; toOpenAIMessage returns undefined for unknown roles, which serializes as null and confuses providers
- [setup] readline rl.question races on piped stdin; use an rl.on("line") queue instead
- [surface] nodeterm hook POSTs are form-urlencoded (nodeId, version, payload); payload carries Claude-style hook_event_name. Approvals: ~/.nodeterm/pending/<id>.json + poll <id>.answer (allow|deny), fail open on timeout. Env-gated on NODETERM_NODE_ID + hook port/sock — inert in a plain terminal
- [setup] beforeToolCall in agent-loop must be awaitable (approval waits on a phone); sync-only hooks can't hold a turn
- [web] TinyFish: X-API-Key header on both; Search=GET api.search.tinyfish.ai?query=…, Fetch=POST api.fetch.tinyfish.ai {urls:[…], format:"markdown"}; per-URL failures come back in errors[] alongside HTTP 200 (read both); free at any wallet balance; 429 = rate limit, retry after a beat
- [gate] unlazy gate-check.mjs is zero-dep and Node-16+; a gate passes only on exit 0 AND EXPECT match; CHECK lines never run until their exact command+CWD+PATH oracle is approved; approvals live in ~/.unlazy/approved OUTSIDE the repo (it refuses to write them inside) — so set HOME outside the ledger dir in tests
- [gate] gate-check exit codes: 0 all met, 1 unmet, 2 usage/parse/infra, 3 lease conflict. --status never executes (exit 1 just means "unmet" — informational, not an error); --approve approves+runs; --reverify re-runs and demotes stale evidence; gate-lint.mjs catches oracles that cannot fail before you work
- [harness] the gates tool maps status-exit-1 to isError=false (a report, not a failure) but approve/reverify-exit-1 to isError=true — same number, different meaning per mode

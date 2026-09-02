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

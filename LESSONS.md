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

# LESSONS

Shared memory across sessions. One line per lesson, actionable, no preamble.
The `## harness` section is read by `rein improve` as its work queue.

## session

- [setup] uncommitted docs in the working tree get eaten by the loop's `git clean -fd` on discard — commit (or stash) new files before running improve/loop on a dirty repo
- [hardware] `sysctl -n k1 k2 …` prints values only, in order, no key names — parse positionally; and one bad oid makes the whole call exit non-zero, so probe optional features (avx oids) in separate caught calls
- [hardware] vm_stat's page size lives in the header line `(page size of N bytes)`, not as a key; reclaimable RAM ≈ (free + inactive + speculative) × page
- [hardware] Magnitude's fit model, ported: reserve max(pool/10, 2GiB) before a model may claim memory; footprint = weights(params×bytesPerWeight) + KV estimate @16k; Apple Silicon = one unified pool; MoE tok/s uses activeParams; tok/s = bandwidth/bytes-per-token × 0.55 — directional, labeled as estimate, never a benchmark
- [install] the global `rein` symlinks to ~/.rein/repo (persistent) — that's the canonical checkout; /tmp/rein-agent was a scratch clone and went stale while the global install pointed at the other one. Work in ~/.rein/repo and `git pull` before building

## harness

- [setup] Node refuses to type-strip .ts under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — a bin that imports src/*.ts installs but crashes on first run. Ship a prebuilt bundle (esbuild → dist/rein.js, committed) as the published bin; keep the .ts dev entry for source runs
- [setup] npm's git fetcher runs an internal `npm install` in the clone whenever package.json has any of postinstall/build/preinstall/install/prepack/prepare — that path left a gutted install (symlink to a skeleton clone) on this machine. Zero lifecycle scripts in package.json; dist is committed, rebuild is `npm run bundle`
- [build] `npm run bundle 2>&1 | tail -1` hid an esbuild syntax crash for an hour: the last line of a Node crash stack is "Node.js v26.3.0", which reads like a success footer. Check $PIPESTATUS (or read the full output) after piping a build, and verify the bundle actually changed (grep it for a fresh string) before trusting it
- [onboard] curl|bash installer + `rein setup` wizard (the openclaw/hermes pattern): detect local servers → pick provider+model → optional masked key → connection test → save ~/.rein/config.json; `--yes` for non-TTY, `--status` to re-check. raw.githubusercontent needs the repo public (it is — flip back with `gh repo edit Zermo/rein-agent --private`)
- [setup] layout-sensitive paths (import.meta.url + ../.. to the repo) break when the same file is bundled elsewhere — resolve by probing for a known file (test/smoke.ts, vendor/unlazy/scripts/gate-check.mjs) instead of counting dirnames
- [setup] a backtick inside a template literal (```` ``` ```` in an error message) is a hard syntax error Node and esbuild both reject — `rein loop` was unparseable until the message dropped the backticks
- [setup] a copy installed under node_modules can't run its own TS smoke test — `rein improve` copies src/test/vendor to a scratch dir outside node_modules and runs the same test there (fresh source, no stale bundle)
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

# Posthorse and harness review

## 0.9.3 Reasoning-model setup and install guide

The reported model-host connection was valid: an eight-token setup probe returned
reasoning with no visible answer. A live probe with 128 tokens reached `ok` in
26 completion tokens through the existing SSH route. Setup now uses that
bounded budget and recognizes the same reasoning aliases as normal inference.
It identifies reasoning-only results explicitly. Empty, malformed, timed-out,
and provider-error responses continue to fail.

An independent runtime review found one P2 issue: partial reasoning could pass
setup when the provider ended with `content_filter` or `aborted`. Both terminal
reasons now fail, including a later SSE chunk after partial text or reasoning.
Twelve real HTTP regression cases cover these combinations. The reviewer
rechecked the change and reported no remaining findings. The full source suite,
Node 18 bundle smoke, native provenance, real browser smoke, and package gates
all pass.

The [installation field guide](docs/install.html) covers fresh installation,
existing configurations, model-host loopback access through SSH, local discovery,
cloud accounts, API keys, first use, and updates. It runs offline and copies
commands without executing them. The guide follows dzhng's `write-docs` and
`screenshot-critique` skills. The [visual review record](docs/install-guide-review.md)
records the screenshot findings, corrections, and functional checks.

## 0.9.2 Installer updates

`rein update` downloads the official installer with curl before invoking Bash
with `--skip-setup`. HTTP errors, partial or empty downloads, missing tools,
and installer failures return a failed command. Cancellation drains the owned
process group and removes the temporary installer.

The installer now honors `--skip-setup` even with an existing configuration.
It preserves dirty checkouts, stops on fetch failures and non-repository
directories, validates the downloaded bundle, and uses `npm ci` to avoid
changing the installed lockfile. Configuration and session files are untouched.

Regression coverage uses isolated fake downloads, real Bash, temporary Git
repositories, an offline model configuration, npm failures, and descendants
that ignore SIGTERM. The packaged smoke test exercises updates without a real
network request or global installation on every supported Node test version.

## 0.9.1 Silent compatibility flags

Expected Node versions in the CI matrix now carry `kind: "compatibility"` and
`silent: true` in doctor results and heartbeat logs. These passing checks never
increase warning/failure counts. `--silent=false` reveals the information;
actual warnings and failures remain visible regardless of the flag.

Regression coverage includes supported and unsupported Node versions, a stale
flag on a failing check, JSON output, CLI flag forwarding, authentication
failure exit status, and heartbeat log isolation under `REIN_HOME`.

## 0.9.0 Obscura web replacement

The contract is [docs/0.9.0-spec.md](docs/0.9.0-spec.md), from baseline
`b660b925ebc10d0ecc471a369e68d2c54957472d`.

An independent integration review found three P2 issues, all corrected:

- Installing the managed runtime did not override an incompatible PATH binary.
  Resolution now prefers explicit config, then the managed runtime, then PATH.
- The standalone web CLI ignored unsupported filters. It now validates flags
  per action before navigation, matching the native tool's explicit errors.
- Cancelling during download-start progress could leave a rejected fetch
  promise unhandled. The abort helper now accepts factories and checks the
  signal before creating each operation.

Regression coverage includes these cases, strict domain filtering, malformed
and blocked search responses, single-line text bounds, private temporary
storage, cancellation of resistant descendants, and process deadlines. The
bundled agent executes a native `web_fetch` round trip on Node 18 with a fixture.
The real Obscura runtime renders a controlled page, follows its redirect, runs
JavaScript fetch, extracts markdown and resolves source links. A live DuckDuckGo
query through the actual packaged command returned source links without a key.

All five local release gates pass: source regressions, Node 18 bundle, native
provenance, real browser extraction, and package assets. CI additionally tests
the actual native browser on Linux, macOS and Windows.

### Standards

The independent final review of `b660b92..c6a0c2f` found no unresolved Standards
findings. TypeScript ESM, no runtime npm dependencies, bounded tool output and
returned errors follow the repository's conventions. The reviewer also passed
38 focused Obscura tests and the native provenance check.

### Spec

The independent final Spec review found no unresolved implementation findings
or extra scope. The source and bundle contain no TinyFish service calls.
Release completion additionally requires the push, CI and installed CLI checks.
The real browser test verifies that private network access can be enabled for
the fixture and that disabling it prevents navigation.

## 0.8.0 Chat Completions, tmux, activity canvas, and Meat

The implementation contract is [docs/0.8.0-spec.md](docs/0.8.0-spec.md).
Three reviewers covered provider setup/distribution, persistent shells, and the
activity interface. Final parallel Standards and Spec reviews compared the
0.7.0 baseline `0cc5d69` to implementation `617c8b5`, then rechecked the fixes.

### Standards

- P2, resolved: Meat reloaded mutable config instead of retaining its active
  runner's connection. The tool now receives the resolved model, key, temperature,
  token budget, and current tool mode. A config-drift regression covers each.
- P2, resolved: single-commit review omitted clean merge changes or supplied
  unsupported combined diffs. First-parent review now covers merge commits;
  a regression also preserves root-commit handling.

Two findings, both resolved. The most consequential was changing the model
connection during an existing session's review.

### Spec

- P2, resolved: Meat could leave the active model connection after a config edit.
  The connection snapshot fix above satisfies the session connection contract.
- P2, resolved: standalone Meat exited on SIGHUP/SIGTERM without stopping its
  subscription CLI. It now cancels and drains the provider. Process-group cleanup
  also survives the provider parent's exit, so a TERM-resistant descendant cannot
  continue after the harness finishes. Four real subprocess regressions cover
  all three signals and resistant providers/descendants.

Two findings, both resolved. The most consequential was an owned provider
process continuing after the harness stopped. No unresolved Spec findings.

### Integration verification

Earlier review fixes cover usage without `total_tokens`, setup/runtime protocol
validation, merge-safe original diffs, line ranges before source truncation,
tmux cancellation cleanup, stale/removed environment variables, literal input,
visual-server isolation, mouse node selection, recovered status, transient
canvas reconnects, and malformed snapshot responses. Foreground shutdown also
cancels pending Nodeterm approvals and removes only its own pending files.

The actual browser canvas was checked for mouse and keyboard selection, zoom,
fit, follow-live, progress updates, and recovery after an unchanged snapshot
became readable again. A real PTY fixture exercised the bundled `--visual`
launcher, split panes, a mock Chat Completions response, activity recording,
separate shell lists, detach, and owned session cleanup on macOS/tmux 3.6a.

Ubuntu CI exposed tmux 3.4's broken `split-window -p` handling. Splits now use
the shared `-l 40%` syntax, and the real-pane regression checks the resulting
widths as well as selection, execution, and cancellation cleanup.

Release gates verify the Node 22.19 source suite, Node 18 bundle including an
actual Meat worker and local mock model, npm package assets, original upstream
tests, pinned licenses/sources, and an identical Go 1.26.5 WASM rebuild. The HTTP
text tool protocol is covered as well as native tool calling. CI runs source on
22.19/24 and bundles on 18/20/22/24, plus the upstream rebuild job. No cloud
subscription sign-in or paid inference was performed in these tests.

## 0.7.0 Fold and native workflow review

The September export diagnosis and integration contract are recorded in
[docs/debug-2026-09-05.md](docs/debug-2026-09-05.md). Fold's pure stop policy
and truncation are pinned alongside Matt Pocock's three selected workflows.
Rein implements skill loading against its own tools; this does not replace the
entire harness with Fold's Effect runtime.

Two parallel reviewers followed Matt Pocock's Standards and Spec review axes
against the exported build, `8b5410a`, through implementation commit `14245e4`.
Their findings below were fixed and retained as regression tests.

### Standards

- P2, resolved: the global 200-session cutoff hid a repository's older history
  behind newer sessions from unrelated projects. Scope filtering now precedes
  the cutoff; a fixture with 200 foreign sessions verifies discovery and search.
- P2, resolved: input entered during `/stop` cleanup was acknowledged as queued
  but discarded. Input after cancellation now enters the next-run queue.

Two findings, both resolved. The most consequential was loss of the user's
next request during cancellation.

### Spec

- P2, resolved: a next request could disappear during cancellation. A real CLI
  fixture now sends `/stop` and the next request in the same input chunk.
- P2, resolved: filesystem errors from offline diagnosis disclosed supplied
  paths. Fixed diagnostics cover failures, with both output streams tested.
- P2, resolved: generated workspace overlays counted as direct user input,
  while synthetic harness stops counted as provider errors. The analyzer now
  identifies both record types and reports harness stops separately.

Three findings, all resolved. The most consequential was loss of the user's
next request during cancellation.

The notes acknowledgment also uses its normalized path. Source regressions,
Node 18 packaged CLI smoke, pinned provenance, and package contents are release
gates. The raw user export is not included in the repository or package.

The integration ports Posthorse 0.4.1 to Rein's own session and tool interfaces.
Upstream source and MIT license are pinned under `vendor/pi-posthorse`.
Three parallel reviewers checked the loop, provider adapter, and CLI, followed
by reviews of the integration and autonomous modes. Findings below were fixed
and covered by offline regressions.

## Context and persistence

- Boundaries commit only after all tools succeed; failed, aborted, and duplicate
  rollover requests leave the current window intact.
- Saved sessions append each completed message before committing the boundary.
  Resume/fork retain full history, stable entry ids, and active-window boundaries.
- Interrupted tool batches replay explicit unknown-outcome errors to the model,
  without rewriting history or retrying tools automatically.
- Automatic recovery preserves pending user input separately, bounds handoffs,
  excludes failed provider responses, and limits overflow retries.
- Notes and history share a per-request page budget. Notes reject traversal,
  symlinks, hardlinks, and nonregular paths; history stays within the repository.
- Reopening a non-empty session creates a separate resume window with current
  Git state, a bounded squashed diff, a newer peer-session handoff, and shared
  `.pi/notes/MEMORY.md`. The full archived transcript remains recoverable but
  does not inflate the next request. Completed tools capture their workspace
  checkpoint immediately, so a concurrently resumed session sees the latest
  durable state.

## Provider and CLI compatibility

- Valid `{}` tool calls no longer trigger native-to-text fallback. Forced native
  mode remains forced, and automatic fallback still works for missing arguments.
- Text-only models receive tool schemas and readable call/result history.
- Parallel calls in plain JSON responses remain separate. SSE handles split
  frames, final unterminated frames, errors, and cancellation.
- Servers explicitly rejecting `stream_options` retry once without that field.
- llama.cpp is detected from its `/models` metadata and receives `cache_prompt`.
  A compatible server that rejects the field is remembered for the live process;
  reported prompt-cache tokens are visible in context status.
- Explicit provider/endpoint/model settings take precedence and do not silently
  substitute a different local server. Effective output budgets fit small windows.
- Approval timeout invokes a local fallback or denies the action; it cannot
  silently run a gated tool.
- REPL streaming, steering, approval input, resume, and usable session ids work.
  Print mode streams JSON events and returns failure/abort exit codes.

- Default file, shell, and gate tools use the runner's configured working
  directory without changing the process directory.

## Loop behavior

- Tool-returned errors propagate through hooks, events, and model results.
- Turn limits and aborts retain a result for every tool call. Followups are kept.
- Experiment metrics parse documented fenced commands and finite numeric values.
- Autonomous keep/discard requires a clean repository and preserves recorded
  lessons across iterations. Self-improvement validates the full test suite.

- Linux hardware profiling no longer references an undeclared bandwidth variable;
  unknown bandwidth remains absent from the report.

## Validation

`npm test` runs the original offline smoke suite and the new node:test regressions.
`npm run bundle` builds the committed CLI. `node test/bundle-smoke.mjs` runs a
saved rollover against a local mock server using only the shipped bundle.
`npm run check:posthorse` checks upstream file hashes. CI tests source on Node
22.19/24 and the shipped bundle on Node 18/20/22/24.

No paid-provider inference or production deployment was performed. Context
budgets remain estimates, and Pi's session/image formats are outside this port.

## 0.4.0 connection and authentication review

Three parallel reviewers covered URL and credential resolution, the setup wizard,
and official CLI transports, then reviewed each other's changes. The review fixed:

- Authenticated APIs were queried before setup collected a key. Discovery now
  follows authentication and uses the selected endpoint's credentials.
- Scheme-less NetBird addresses and pasted request URLs produced invalid paths.
  Normalization and bounded discovery preserve proxy prefixes and root APIs.
- Saved keys and model IDs could follow a different endpoint or SSH host.
  Saved credentials and model selection now remain scoped to their connection.
- CLI/environment/config precedence differed between setup and execution. Both
  honor explicit selection and ignore empty environment overrides.
- Remote loopback APIs could not be reached. Managed SSH forwarding now binds
  only a local ephemeral port and closes on completion, failure, or cancellation.
- Setup could hang on EOF, expose key fragments, retain stale keys, or save a
  failed connection. It now closes input, redacts keys, saves atomically with
  private permissions, and preserves the previous config when validation fails.
- Subscription CLI processes could inherit BYOK settings or custom tools.
  Their configuration and environment are restricted; credentials stay managed
  by the official CLI. Copilot's OS keychain may be shared with its native CLI.
- Current OpenAI models can reject `max_tokens`. Setup and inference share
  bounded retries only for explicitly rejected compatibility fields; auth,
  validation, and server errors are not retried indiscriminately.
- Doctor could assess remote models against local hardware, suggest an unrelated
  Ollama repair, or report a stale API prefix as healthy. Those cases now receive
  endpoint-specific diagnosis.

Validation includes fake CLI processes, mocked authenticated APIs, CLI-to-config
integration, and subprocess forwarding/cleanup tests. Actual current Codex and
Copilot parsers accepted the generated flags with `--help`; no cloud account login
or paid cloud inference was performed. A live model-host loopback server was reached over
SSH: model discovery, saved setup, chat, and a read-only fixture tool round trip
all passed. The server listener was left unchanged.

Local release checks passed on Node 22.19: 73 smoke assertions and 125 regression
tests. The bundled Node 18 smoke test and Posthorse provenance check also passed.

## 0.6.0 proactive service review

Three parallel reviewers implemented and cross-checked user services, history
evidence, and the terminal dashboard. The supervisor uses explicitly enrolled
Rein workspaces and the configured model. No service is installed by npm hooks.

Review fixes cover approval changes during active work, cancellation between
tool calls, shared run budgets and locks, recovery after interrupted lock
publication, source excerpts in proposal reviews, generated-session exclusion
across forks, restricted instruction prompts, and bounded asynchronous inspection
that excludes links, hidden files, and common credential files. Dashboard tests
cover terminal escape removal, exact approval review, stale proposals, and terminal
cleanup. Service tests validate escaping, ownership, idempotence, failure reporting,
and removal without changing unrelated services.

Offline tests use mocked model replies and real temporary sessions/files. They
exercise the actual provider adapter and approved tool loop without cloud inference.
Native macOS validation registered an isolated paused LaunchAgent, confirmed the
daemon was running, then stopped and removed it. No model calls were made.
Per-user service lifetime follows the host's login/session configuration. Normal
write-enabled tools retain the user's account permissions and are not an OS sandbox.

Final review also caught concurrent stale-lock recovery, scan revocation before
the next model request, evidence starvation with 32 enrolled workspaces, and
terminal-only provider settings unavailable to the OS service. Regression tests
cover those cases. Enabling the service requires confirmed startup before work
is unpaused; service definitions never acquire copied API credentials.

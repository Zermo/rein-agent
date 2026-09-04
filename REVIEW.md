# Posthorse and harness review

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

## Provider and CLI compatibility

- Valid `{}` tool calls no longer trigger native-to-text fallback. Forced native
  mode remains forced, and automatic fallback still works for missing arguments.
- Text-only models receive tool schemas and readable call/result history.
- Parallel calls in plain JSON responses remain separate. SSE handles split
  frames, final unterminated frames, errors, and cancellation.
- Servers explicitly rejecting `stream_options` retry once without that field.
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

## Validation

`npm test` runs the original offline smoke suite and the new node:test regressions.
`npm run bundle` builds the committed CLI. `node test/bundle-smoke.mjs` runs a
saved rollover against a local mock server using only the shipped bundle.
`npm run check:posthorse` checks upstream file hashes. CI tests source on Node
22.19/24 and the shipped bundle on Node 18/20/22/24.

No paid-provider inference or production deployment was performed. Context
budgets remain estimates, and Pi's session/image formats are outside this port.

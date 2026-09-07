# Rein development

Rein is a terminal-first, local-first agent harness: provider adapters, an
agentic loop, tools, durable context, and an optional headless autonomy helper.
Keep changes small and preserve compatibility with self-hosted model APIs.

## Setup and commands

- Source development: Node 22.18+ (22 series) or 24+, npm, Git, Bash, tmux,
  Python 3, zstd.
  The installed JavaScript bundle still supports Node 18.
- Cloud setup: `bash scripts/setup-cloud.sh`; see `docs/cloud-development.md`.
- Dependencies: `npm ci --include=dev`.
- Tests: `npm test`. Fixtures run locally; no model server or API key is needed.
- Provenance: `npm run check:posthorse` and `npm run check:natives`.
- Build: `npm run bundle`. Commit updated `dist/rein.js` and
  `dist/meat-worker.js` whenever their source changes.
- Bundle smoke test: `node test/bundle-smoke.mjs`.
- Source CLI: `node bin/rein.js --help`.
- Only when changing the Meat WASM: use Go 1.26.5 for
  `npm run test:meat-upstream` and `npm run check:meat`.

## Conventions

- TypeScript and ESM; runtime dependencies need a concrete justification.
- Run focused tests while editing, then the suite for runtime changes. Check
  that rebuilding leaves committed bundles unchanged before publishing.
- Keep tool output small. Search before reading large files.
- Preserve user configuration and sessions. Onboarding and background services
  are user features; development setup should not start them.
- Work style preferences are an operator profile, not a clinical assessment.
- Use existing approval and budget controls for autonomous actions.
- For UI/UX work, read `design.md` and its Beautiful UI, beUI, Rare UI,
  Transitions, and shadcn references. Preserve Rein's vintage theme and sounds;
  animated activity must follow real runtime state and respect reduced motion.

## Development branches

- `codex/rein-cloud-reskin`: Rein Cloud app presentation, interaction, and the
  backend controls needed by those views.
- `codex/rein-os`: rein-dərāchō OS overlays, platform planning, and managed model-hosting
  development. Keep these commands, assets, tests, and generated bundles off the
  reskin branch. Build each branch's bundle from its own source tree.

## Public examples and private installations

Keep personal model-server addresses, SSH aliases, model selections, credentials,
and local filesystem paths in the user's Rein configuration or private notes.
Use synthetic hosts and model IDs in tests and documentation. Do not copy a
user's connection details or raw session exports into public examples, review
evidence, screenshots, or generated bundles. Describe self-hosted setup in terms
of the server's listening address, API protocol, and network route.

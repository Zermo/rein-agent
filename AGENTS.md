# AGENTS.md — example project instructions

rein loads this file (or CLAUDE.md) from the working directory into its
system prompt. Keep it short — small models tax on long prompts.

Copy this file into a project and fill it in:

## What this project is
One or two sentences. What it does, who it's for.

## Commands
- Build: `npm run build`
- Test: `npm test`
- Run: `node src/index.ts`

## Conventions
- TypeScript, ESM, no dependencies without a reason
- Errors are returned to the model, not thrown at the user
- Keep tool output small: pipe to head, grep before read

## Gotchas
- (record them as you find them — this file is the agent's second brain)

## Public examples and private installations

Keep personal model-server addresses, SSH aliases, model selections, credentials,
and local filesystem paths in the user's Rein configuration or private notes.
Use synthetic hosts and model IDs in tests and documentation. Do not copy a
user's connection details or raw session exports into public examples, review
evidence, screenshots, or generated bundles. Describe self-hosted setup in terms
of the server's listening address, API protocol, and network route.

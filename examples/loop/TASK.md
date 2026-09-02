# TASK.md — what to improve

Write this for the project you want `rein loop` to work on.
The agent reads it every iteration and makes ONE concrete change per pass.

## Goal
Reduce p95 latency of the /search endpoint below 120ms.

## Constraints
- Do not change the API contract.
- Do not add dependencies.
- Cache only within a single request; no global state.

## Hints (optional)
- The N+1 query in src/search/fanout.ts is the prime suspect.
- Profile with `node --prof` before guessing.

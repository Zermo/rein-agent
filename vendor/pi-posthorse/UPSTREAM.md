# Posthorse source

- Repository: https://github.com/fitchmultz/pi-posthorse
- Revision: 6f97656910f32040bbb274187d973f3b90de0c43
- Package version: 0.4.1
- License: MIT, copyright 2026 Mitch Fultz

`index.ts`, `LICENSE`, and `README.md` are unmodified upstream files.
Rein's adaptation lives in `src/harness/posthorse.ts`,
`src/harness/tools/context.ts`, and `src/agent/session.ts`.
The upstream extension needs the fitchmultz/pi fork and TypeBox. Rein ports
its window policy and recovery tools to its own loop and JSONL sessions;
it does not load the Pi extension or add Pi as a runtime dependency.

The adaptation preserves the four tool names and `.pi/notes` location.
Rein stores its own session format under `~/.rein/sessions`. It does not
read Pi sessions or support Pi image/custom-message entries. Rein accepts
smaller context windows when prompt, tools, and the reserve leave room;
its estimates and safe recovery limits are checked before rollover.

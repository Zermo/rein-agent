# Your operator profile

Rein asks six practical questions so its instructions fit the tasks you want
help with and the way you prefer to work. Review the result, change or skip the
suggested workflow pack, and save when it looks right. No model connection is
needed for this step.

```sh
rein setup                 # complete first-run walkthrough
rein setup profile         # preferences only
rein profile setup         # same preferences wizard
rein profile               # view the saved result
rein profile --json        # structured output
```

## Six choices you can revise

| Question | Available choices |
| --- | --- |
| How should Rein explain an answer? | Concise bullets; conversational paragraphs; walkthrough with why; one next action first; answer first with supporting explanation |
| What would you like help with most often? | Code; machines/services; learning/writing/research; creative work; everyday plans/tasks/routines; one small life improvement at a time |
| Within a task already authorized, how should Rein work? | Ask before consequential changes; explain the plan and why, then do it; do routine reversible work and report back |
| What pacing helps on a multi-step task? | Adapt to the task; one small next step; short work blocks with checkpoints; visible checklist |
| What helps unfamiliar information make sense? | Direct explanation; example or analogy; why this option fits and alternatives; a small example to try |
| How should Rein check that it understood? | Respond directly; reflect the goal before substantial work; recap decisions and the next step; ask one focused question if unclear |

These are explicit support preferences, not a personality test, health
assessment, attention score, or fixed learning type. For example, choosing small
steps asks Rein to make the next action manageable; it does not assign a reason
why you want that support. Your current request can override a saved preference.

Enter a letter or number. Type `back` to revisit a question, or `skip` to keep
your current setup. The current conversation surface is the terminal; the
wizard does not offer unimplemented chat or voice channels.

The scorer is deterministic and local. Task focus, response detail, and
initiative use fixed axis weights. Pacing, understanding, and listening are
saved preferences, without ability scores. Task focus selects the suggested
pack; a different explanation style does not switch you into an unrelated pack.

## Choose a pack, or skip it

| Pack | Helps with | Exact workflows |
| --- | --- | --- |
| `everyday` | A manageable next step, a simple routine, or practical choices | `task-breakdown`, `routine-planning`, `decision-support` |
| `ship` | Focused code changes and verification | `code-change`, `tdd`, `execution-discipline` |
| `ops` | Service diagnosis, recoverable changes, and useful notes | `service-care`, `durable-notes`, `execution-discipline` |
| `study` | Grounded research and a learning goal | `grounded-research`, `learning-plan` |
| `studio` | A creative brief and review of a visual result | `creative-brief`, `visual-review` |

These are workflow instructions Rein can load when useful. The `tdd` workflow
comes from Rein's existing pinned Matt Pocock skills; the others are written
for Rein. Selecting a pack does not install an application, model, or connector.
You can choose any pack or none and inspect its exact skills before saving.

```sh
rein profile pack everyday
rein profile pack ship
rein profile pack ops
rein profile pack study
rein profile pack studio
rein profile pack none
```

Selecting `none` keeps your preferences and disables the optional pack. Rein's
standard tools and existing built-in workflows remain available. A routine plan
is only a plan until you explicitly enable a supported reminder or service.

## Initiative and approval

With `plan`, Rein explains a short plan and why it fits, compares meaningful
alternatives when useful, then continues already authorized work. It does not
ask again at every ordinary step. `ask` requests approval before consequential
changes; `yolo` describes initiative for routine reversible work within scope.

New scope and required approval gates still need approval. If you decline a
proposal, Rein should offer the next useful option or alternatives, not carry
out the rejected plan. These preferences do not change `--ask`, host
permissions, tool availability, or background task approvals.

[Background coordination](https://github.com/Zermo/rein-agent/wiki/Background-coordination)
is a separate optional setup choice. Default history checks use deterministic
rules without a model. An optional local helper filters candidates. For richer
follow-ups that use your preferences and history, explicitly choose
`rein autonomy planner main`; this uses the main model and its normal account
allowance. Approved tasks use the main model separately.

## Private files and older profiles

The wizard writes four files under `~/.rein`, or your custom `REIN_HOME`:

| File | Contents |
| --- | --- |
| `SOUL.md` | Agent voice and explanation preferences |
| `USER.md` | Explicit support and task preferences |
| `AGENTS.md` | Operating brief and approval boundaries |
| `profile.yaml` | Versioned `operator_profile`, support preferences, answers, and enabled pack |

Setup updates only Rein's marked sections in the Markdown files and preserves
unmanaged notes. Changed originals are backed up under
`.operator-profile-backups`. It checks that files have not changed since your
preview before saving. Project instructions and the model connection in
`config.json` remain separate. Keep credentials out of these profile files.

Version 1 profiles are validated against their original contract before being
adapted in memory to the current native workflows. Reading an old profile never
rewrites it. An old chat or voice preference remains reference information;
terminal is the current supported surface. The next explicit save writes
version 2 and backs up changed originals.

Use the profile commands to change scored answers or enabled skills. Rein
validates `profile.yaml` before loading it. No model or poll service scores the
operator. During normal sessions, the saved instructions become part of the
prompt sent to your selected model provider.

`rein setup --yes` only runs unattended connection setup. It does not invent
preferences or enable a pack for you. There is no crowd-poll ingestion; future
wording updates must preserve question IDs and weights rather than introducing
assessment items.

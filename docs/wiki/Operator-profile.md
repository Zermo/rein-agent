# Your operator profile

Rein's setup asks four questions so its instructions fit the work you want to
do. It recommends a skill pack, previews the result, and lets you change or skip
the pack. You can revise the profile without a model connection.

```sh
rein setup                 # full first-run walkthrough
rein setup profile         # only the work-style wizard
rein profile setup         # same profile-only wizard
rein profile               # view the saved result
rein profile --json        # structured output
```

## Four choices about work

| Question | Choices | Saved axis |
| --- | --- | --- |
| When the agent talks, I want... | Bullets, then stop; short paragraphs; step-by-step with why | `density`: terse, normal, walkthrough |
| Most days I will use this for... | Shipping code; keeping machines/services alive; reading/writing/research; images/video/design | `focus`: coding, ops, research, creative |
| When a change is risky, the agent should... | Ask first; show a plan, then do it; do it, tell me after | `autonomy`: ask, plan, yolo |
| I will mostly talk to it from... | Terminal; Slack/chat; voice/phone | `surface`: cli, chat, voice |

Answer for the way you want to work today. There is no clinical test, personality
ranking, or attention-span measurement. The profile stores preferences you
choose; it does not infer them from transcripts.

Each answer adds a fixed weight to its axis. Rein takes the highest score on
each axis and checks the pack rules in the order shown below. A tie or no matching
rule suggests `ops`. You can override that recommendation. The preferred
conversation interface does not affect which pack is suggested.

## Choose a pack, or skip it

| Pack | Matching profile | Skills |
| --- | --- | --- |
| `ship` | coding + terse + yolo | `github-pr-workflow`, `tdd`, `caveman` |
| `ops` | ops + terse + plan | `hermes-agent`, `fleet-command-ops`, `execution-discipline` |
| `study` | research + walkthrough + ask | `grounded-citations`, `plan` |
| `studio` | creative + normal + ask | `claude-design`, `comfyui` |

The pack adds workflow instructions Rein can load when useful. These workflows
ship with Rein. Names such as `hermes-agent`, `claude-design`, and `comfyui` do
not install or authenticate those applications. The `tdd` workflow comes from
Rein's existing pinned Matt Pocock skills; the other pack workflows are written
for Rein.

Enter a letter or number at each question. Type `back` to revisit a question
or `skip` to keep your current setup. At the preview, change your answers, accept
the suggested pack, choose a different one, or continue with no pack. You can
read the full file preview before saving. To change only the enabled pack later:

```sh
rein profile pack ship
rein profile pack ops
rein profile pack study
rein profile pack studio
rein profile pack none
```

Selecting `none` keeps your work preferences and disables the profile pack.
It does not remove Rein's standard tools or existing bundled workflows.

## What the profile changes

Rein uses the saved instructions in future sessions to choose response detail,
explain plans, and work with your stated preferences. `ask`, `plan`, and `yolo`
describe the operating brief. They do not change `--ask`, host permissions,
tool availability, or approvals for background tasks.

Choosing `chat` or `voice` records the interface you prefer. It does not install
a Slack connection, phone service, or speech engine. Start with NodeTerm or the
terminal using the model connection you configured during setup.

Proactive suggestions are a separate setup choice. Choose manual scans for a
folder, enroll it and start a background service, or skip proactive work. Rein presents suggested
tasks for approval, with scope and budgets, before they run. Use
`rein autonomy tui` to review them and `rein autonomy pause` to pause work.

## Your files stay in your Rein home

The wizard writes these files under `~/.rein`, or your custom `REIN_HOME`:

| File | Contents |
| --- | --- |
| `SOUL.md` | Agent voice and response style |
| `USER.md` | How you prefer to work |
| `AGENTS.md` | Operating brief derived from your choices |
| `profile.yaml` | Machine-readable `operator_profile`, scores, and enabled pack |

These files are private local configuration. Setup updates only Rein's marked
sections in the Markdown files and preserves text outside those sections.
Changed originals are backed up under `.operator-profile-backups` in your Rein
home. Project `AGENTS.md` files and the model connection in `config.json` stay
in place. API keys do not belong in any of these four profile files.

Use the profile commands to change the scored answers or enabled pack. Rein
validates `profile.yaml` against the fixed scoring rules before loading it.

The quiz and scoring run locally without a model or poll service. Rein does not
upload your answers as telemetry. In a model session, the saved work-style
instructions become part of the prompt sent to the provider you selected.

## Unattended installs and future polls

`rein setup --yes` runs the unattended connection setup. It does not fill out
work-style answers or enable a pack on your behalf. Run `rein setup profile`
in an interactive terminal when you are ready. To change only a model
connection, run `rein setup --connection-only`.

Question IDs, axes, and weights are fixed. There is no crowd-poll ingestion in
this release. Any later wording update must preserve those IDs and weights;
poll results may replace choice text, not add assessment items or rewrite the
scoring rules.

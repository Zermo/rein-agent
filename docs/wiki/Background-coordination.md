# Background coordination

Rein can wait for new work and prepare follow-up suggestions without keeping a
model busy. Its own user service handles timers. By default, deterministic
rules inspect enrolled Rein history and current workspace changes without any
inference call or cloud allowance.

The setup wizard lets you choose manual scans, start the background service for
a folder, or skip this entirely. Package installation alone does not start a
background model. Ordinary interactive chat works independently.

## Start with rules-only checks

From a folder whose Rein history you want to use:

```sh
rein autonomy init
rein autonomy scan
rein autonomy tui
```

`init` enrolls that folder and leaves the supervisor paused. A manual `scan`
checks its evidence. Rules look for explicit follow-up intent in user messages;
a model's own suggestions do not become authorization for more work. Candidate
tasks stay pending until you approve them.

To let Rein check in the background:

```sh
rein autonomy enable
rein autonomy status
rein autonomy pause
rein autonomy resume
rein autonomy disable
```

`enable` registers Rein's own user service with launchd on macOS or systemd on
Linux. It does not attach to another application's process. User services
follow the host's login/session behavior and do not prevent system sleep.
`disable` stops and removes the supervisor service, retaining reports and
review decisions.

Review a proposal directly in your existing Rein chat terminal:

```text
/autonomy
/autonomy show <id>
/autonomy approve <id>
/autonomy dismiss <id>
/autonomy pause
/autonomy resume
```

`show` displays the task, workspace, evidence, cadence, and budgets. `approve`
enables read-only checks. For a proposal that needs editing or commands,
`/autonomy approve <id> --allow-writes` explicitly grants normal Rein tools,
including shell commands and file writes. `dismiss` rejects or disables a
proposal. Pausing cancels active background work; resuming permits scheduled
work when the supervisor is running.

These controls remain in the same terminal. They do not start a nested dashboard
or immediately run a scan/task. The standalone `rein autonomy tui` dashboard is
also available if you prefer it. See the
[full approval controls](https://github.com/Zermo/rein-agent#proactive-work-from-task-history).

## Ask the main model for personalized follow-ups

For suggestions that need more than explicit task matching, opt into the main
planner:

```sh
rein autonomy planner main
rein autonomy scan
```

This mode uses your selected main model to propose and review follow-ups from
changed task history, validated operator preferences, and prior decisions and
results. It can suggest a practical improvement or routine for your situation;
a workflow pack is a starting approach, not a fixed list of routines. Every
suggestion still waits for your approval before execution.

The main planner makes at most two tool-free model calls per changed scan,
within the existing daily operation budget. A cloud connection can use API
credits or subscription allowance. A self-hosted main model uses its server's
compute instead. Unchanged history and operator preferences make no calls. Editing saved preferences causes the main planner to reconsider the same history on its next scan. This mode skips the tiny
helper, which is only a filter for rule-generated candidates.

```sh
rein autonomy planner rules
```

Switching back restores deterministic candidate generation. Changing planner
mode causes the next scan to reconsider the evidence without discarding prior
proposals or decisions. Pausing the supervisor stops automatic checks in either
mode; manual scans are deliberate actions.

## Add the headless helper, if useful

The optional guardian is a background worker for the harness. It receives only
bounded candidate-triage requests and returns which candidates to keep. It has
no user chat, separate persona, tools, task approval, or task-execution
interface. It cannot invent a task or change your primary model. Waiting and
scanning still use the rules coordinator; inference does not run continuously.

```sh
rein autonomy guardian status
rein autonomy guardian plan
```

`plan` assesses the machine running the coordinator, including memory headroom,
archive sizes, and extraction prerequisites. It does not assume a remote model
server has the same hardware. The verified model recipe is
[Qwen3 0.6B Q4_K_M](https://ollama.com/library/qwen3:0.6b), about 523 MB to
download. Running memory also includes context and runtime overhead. If Rein
cannot confirm a suitable fit or supported runtime, rules-only coordination
remains available.

To start the dedicated Rein worker and download its pinned model:

```sh
rein autonomy guardian install
```

Rein reuses an existing Ollama executable when suitable, then runs it as its own
named user service with a dedicated loopback endpoint and private model store.
It does not reuse your main model server, its model store, or its settings.

If the executable is missing, explicitly permit the private standalone runtime
download:

```sh
rein autonomy guardian install --install-runtime
```

This downloads and verifies a pinned official archive, extracts it into Rein's
private home, then starts the headless worker. It does not install or open a
desktop app or install Ollama's system service. The runtime download is separate
from the 523 MB model; review the platform size printed by `plan`. Unsupported
platforms or missing decompression tools fall back to rules-only coordination.
The standalone package supports macOS 14 or newer and Linux x64/arm64; the
Linux archive needs `tar` and `zstd` for extraction.

The pinned standalone runtime is [Ollama v0.33.3](https://github.com/ollama/ollama/releases/tag/v0.33.3).
These archive sizes are additional to the model download and temporary disk
space needed for extraction:

| Platform archive | Download |
| --- | --- |
| macOS | About 159 MB |
| Linux x64 | About 1.43 GB |
| Linux arm64 | About 1.55 GB |

The old `--start-runtime` flag remains accepted for compatibility. Starting the
Rein-owned worker is already part of `guardian install`. To verify and enable a
previously installed, running Rein worker without downloading anything:

```sh
rein autonomy guardian setup
```

The worker defaults to `http://127.0.0.1:11435`. To choose another unused
loopback port, pass `--base-url` to installation. Rein refuses to adopt an
unrelated process on that port, even if it serves a compatible Ollama API.

The helper is restricted to Rein's dedicated loopback worker. It does not use
your network model host, mesh connection, cloud account, or primary-model
credentials. This is a separate service and storage boundary, not OS isolation
against other processes running as the same user.

## What uses resources

| Activity | Model use |
| --- | --- |
| Service waiting and default rules scan | No inference or cloud model calls |
| Optional local guardian with rules planner | At most one bounded local call for new candidate work |
| Explicit main planner | At most two main-model calls when scan evidence changes |
| Approved task execution | Your selected main model, with its normal resource use and account limits |

The local helper reviews at most three candidates, with a 2,048-token context,
192-token output limit, two CPU threads, and a 20-second request deadline. It
requests a short model keep-alive rather than keeping weights resident forever.
These are operating limits, not a benchmark or guarantee of latency. Local
inference still generates tokens and consumes memory, CPU/GPU time, and power.

With the rules planner, if the helper is unavailable or its output is invalid,
Rein uses rules-only review. It never falls back to your cloud account for that
check. The main planner uses your main model only after the explicit selection
described above. Approved task
runs are separate and may consume API credits or subscription allowance.

## Stop or change the helper

```sh
rein autonomy guardian disable
rein autonomy guardian status
```

`guardian disable` turns off the local helper and stops a helper runtime
service owned by Rein. It does not change an explicitly selected main planner;
use `rein autonomy planner rules` to disable that model-based planning. It
retains the downloaded runtime and model files, and does not uninstall a
user-managed Ollama installation. It also does not stop the supervisor; use
`rein autonomy pause` or `rein autonomy disable` for that.

Hardware selection currently has one verified small-model recipe. It does not
promise a best model for every device, a phone runtime, self-training, or
human-like continuous thought. The useful persistent state is explicit:
workspace history, proposals, approvals, reports, and durable notes.

# Task limits

Rein defaults to 300 model turns per prompt and 25 iterations for `rein loop`
and `rein improve`. A turn is one model call, including retries. An iteration
is one loop round and can use several turns. Ordinary terminal chat uses only
the turn limit, with no fixed overall time cutoff.

## Choose limits during setup

The first-run wizard asks about limits after your work preferences. Revisit
that step without connecting to a model:

```sh
rein setup budgets
```

| Choice | Model turns per prompt | Loop/improve iterations |
| --- | --- | --- |
| Standard, or keep your existing settings | 300 by default | 25 by default |
| Extended task | 1000 | 100 |
| Short task | 100 | 10 |
| Exact limits | 1 to 10,000 | 1 to 1,000 |
| Skip | Unchanged | Unchanged |

Rein stops earlier when the task finishes. These numbers are ceilings, not a
target to fill. A loop can use up to turns multiplied by iterations, so choose
larger values with your model's cost and speed in mind.

## Inspect or save exact defaults

```sh
rein setup budgets --status
rein setup budgets --json
rein setup budgets --yes --max-turns 750 --max-iterations 40
```

The status commands are read-only. They show the actual config path and whether
each value is saved or comes from the default. The save command changes only
the limits, retaining your other configuration.

Values are top-level fields in `~/.rein/config.json`, or your custom
`$REIN_HOME/config.json`:

```json
{
  "maxTurns": 750,
  "maxIterations": 40
}
```

Keep your other config fields if editing this file yourself. Invalid JSON or
invalid limits produce a diagnostic so you can repair them before running.

For one launch, flags override saved values. Saved values override defaults.

```sh
rein --max-turns 1000
rein loop --max-turns 750 --max-iterations 40
```

New sessions read the updated defaults. Restart a running Rein session when you
want it to use newly saved limits.

## Continue paused work

Reaching the turn limit produces a `PAUSED` label, not a completed-task claim.
Completed tool results remain available. Review the progress and reply
`continue` to grant the next prompt a fresh turn budget.

One-shot `rein -p` mode automatically saves a session at this pause, including
when you did not supply `--save`. It prints the exact resume command and exits
with code 3 so shell scripts can distinguish a budget pause from success.

```sh
rein --resume <session-id>
```

After reopening, ask Rein to review current state and continue. Do not retry
completed commands blindly. `loop` and `improve` have their own round controls;
an incomplete turn is not proof that an experiment passed verification.

## Turns, context, and output are separate

| Setting | What it limits |
| --- | --- |
| `maxTurns` | Model calls per prompt, including retries |
| `maxIterations` | Rounds of `loop` or `improve` |
| `contextWindow` | The model/server's actual input and output capacity |
| `maxTokens` | Generated tokens allowed for one response |
| `posthorse.reserveTokens` | Space kept for output and rollover recovery |

Increasing task limits does not enlarge the context window or output budget.
Set `contextWindow` to what your server actually supports. Rein estimates
tokens and refines those estimates when the provider reports usage. A single
prompt or tool schema that cannot fit still needs a larger window or less input.

With default tools, Posthorse can open fresh windows during a long task without
a summarization call. It keeps the complete transcript in history and carries
a bounded recovery record. Durable `.pi/notes` files supply current checkpoints.
Use `/context` to inspect context use, or `/new-context` to request a fresh window.

Reopening an archived session adds bounded current workspace evidence and the
latest durable memory over the saved history. Old entries remain recoverable
by ID through the history tool. Provider KV-cache persistence is not guaranteed.
The agent must check live state and verify results across every window.

Repeated-tool detection and verification remain active with larger limits.
More turns permit more work, but do not guarantee a correct answer.
[Background coordination](https://github.com/Zermo/rein-agent/wiki/Background-coordination)
has separate turn, time, and daily limits; foreground settings do not change them.

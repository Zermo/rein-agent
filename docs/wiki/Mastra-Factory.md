# Mastra Factory · A software factory on your machine

Mastra Factory is the open-source agent-building machine from the [Mastra](https://mastra.ai) team. Rein installs it as itself — same name, same UI, same icon — as a native app that sits alongside Dareecho. Open the app and look at your machine's factory running live. It is wrapped, not rebranded: the Mastra attribution and Apache-2.0 license stay exactly as they are.

It needs its own Node.js 22.19 or newer. The terminal CLI keeps working on Node 18; only the factory service raises the floor.

## 01 Install once

Setup provisions the generated project, writes its config and credential key, installs dependencies, and builds. It runs once and never overwrites an existing project, so your factory's state is yours.

SETUP (IDEMPOTENT)
Copy
rein os factory setup

The generated project lives in `~/.local/share/rein-factory`. It is a pure copy of Mastra's factory template plus the single-operator defaults Rein writes — local sandbox, auth disabled, telemetry off, and libSQL storage unless you point it at a database.

## 02 Drive it from the terminal

The app and the terminal talk to the same server, so you can start it in the app and check it from a shell, or the other way around.

START (SINGLE-MACHINE PROFILE)
Copy
rein os factory dev

STATUS
Copy
rein os factory status

STOP
Copy
rein os factory stop

OPEN THE UI
Copy
rein os factory open

Server state — the process id, the log, and the port — lives under `~/.local/state/rein-factory`. That shared state is what keeps the app and the terminal on the same server.

## 03 Two profiles

The factory's built server is a production bundle, and it expects a real database. The dev server does not. Rein exposes both, and the app chooses one for you.

| Profile | Command | Server | Storage |
| --- | --- | --- | --- |
| Production | `rein os factory start` | Built server | `DATABASE_URL` required (Postgres) |
| Single-machine | `rein os factory dev` | Dev server | libSQL, no database, no Docker |

The app picks by configuration: a `DATABASE_URL` in the project environment selects production; otherwise it runs the single-machine profile. On a single machine with no database, use `dev`.

## 04 Wire your model

Model wiring happens in Factory's own Settings › Models, not in Rein. A local server, a network model, or a cloud key all connect the same way any OpenAI-compatible provider does.

## 05 What is inside

The generated project depends only on published npm packages. The one thing worth knowing before you run it in production: `@mastra/core` ships dormant Kepler enterprise code that is guarded off by default and only activates behind a provider you configure. The full reading — including which parts are dormant and what the license means for production use — is in the [integration study](https://github.com/Zermo/rein-agent/blob/main/docs/mastra-factory-integration.md).

License: Apache-2.0, credited where it belongs in the app's `NOTICE`.

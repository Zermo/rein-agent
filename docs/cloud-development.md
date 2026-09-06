# Develop Rein in Codex cloud

Connect the `Zermo/rein-agent` repository to a Codex cloud environment in
ChatGPT. Select the repository and branch for each task. The environment is a
development checkout, with tests and a build tool; it needs no GPU, running
model, or model API key.

## Environment setup

Choose Node 22 in the environment's package settings, with version 22.18 or
newer. Node 24 or newer also works when available. The script checks actual
TypeScript support before installing dependencies. The installed bundle supports
Node 18, but that is insufficient for the source test suite.

Set the setup script to run from the repository root:

```sh
bash scripts/setup-cloud.sh
```

The script checks native TypeScript execution, Git, npm, and tar. It installs
missing tmux, Python 3, and zstd on Linux through apt-get when running as root or
with noninteractive sudo. It tries the existing signed package indexes first,
refreshing them only if installation fails. It keeps apt signature checks and
package sources unchanged. If installation is unavailable, it explains what to
add to the image. These tools enable persistent-shell, installer PTY, and
archive integration tests. It then runs `npm ci --include=dev` using the lockfile.
Rerunning setup refreshes dependencies and keeps existing system tools.

Use this maintenance script when resuming a cached environment:

```sh
npm ci --include=dev --no-audit --no-fund
```

Codex runs maintenance after checking out the task's branch, so this refreshes
dependencies when its lockfile differs from the cached checkout. Setup has
internet access; the agent phase can keep external internet access off for the
mocked test suite. See the official
[cloud environment instructions](https://developers.openai.com/codex/cloud/environments)
for package settings, setup scripts, and caching. Tests still need local sockets,
subprocesses, temporary files, and PTYs inside the container.

This bootstrap does not run the end-user installer, install model servers or
the guardian, start background services, or copy local Rein configuration.
Keep API keys, SSH credentials, private notes, and local model-server details
on the machine where you use them. They are unnecessary for development tests.

## Validate a change

```sh
npm test
npm run check:posthorse
npm run check:natives
npm run bundle
node test/bundle-smoke.mjs
git diff --check
```

Run source commands through `node bin/rein.js`. The installed commands use
`dist/rein.js`. Source changes that affect the CLI must include regenerated
`dist/rein.js` and `dist/meat-worker.js` in the same review. A second bundle
build should leave those files unchanged.

Go is optional. Only changes to the embedded Meat engine need Go **1.26.5** for
`npm run test:meat-upstream`, `npm run build:meat`, or `npm run check:meat`.
The bootstrap does not download Go. The shipped WASM and normal Node test suite
run without it.

## Continue from another Codex client

Use the same Git repository and push reviewed commits or branches between
clients. The cloud environment provides its dependencies for cloud tasks;
local terminals and other machines use their own checkouts and can run this
script when its prerequisites are available.

Git transfers the code, documentation, and project instructions. It does not
transfer this conversation, a running agent process, local credentials,
private `~/.rein` sessions, or provider KV caches. Put the task goal and any
non-sensitive handoff in the cloud task prompt or repository documentation.
Select the intended branch before asking the next agent to continue.

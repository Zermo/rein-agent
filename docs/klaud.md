# klaʊdbot desktop

The optional desktop uses the same Rein runner, model configuration, budgets,
tools, and Posthorse sessions as the terminal. Each named bot keeps its own
conversation. Reopening one shows its saved transcript while the runner loads
current workspace context before acting.

The desktop uses the same retro field guide design as Rein's setup guide. Its
cream paper, charcoal ink, rust, green, mustard, and R-horse mark carry into
both Light and Night modes. Small vintage-computer interface sounds are on by
default, unlock after the first interaction, and can be disabled in Settings.
The preference stays on that device, and the renderer synthesizes the tones
without audio assets or an added dependency.

Install the native Mac app from the latest published release:

```sh
curl -fsSL https://github.com/Zermo/rein-agent/releases/latest/download/install-macos-app.sh | bash
```

The app includes its own runtime and goes into `~/Applications`. Choose
**Bring my Rein with me** to copy existing settings, notes, and conversations,
or **Start fresh** for a separate bot space. Apple Silicon and Intel builds
are selected automatically. Quit before updating and rerun the command; the
previous app is preserved. Development releases are ad hoc signed and are not
notarized, so normal macOS approval checks apply. See the
[Mac release notes](macos-development-release.md).

From a checkout, install the desktop dependencies once:

```sh
npm --prefix apps/klaud ci
rein klaud
```

For source development, use `node bin/rein.js klaud`. The launcher rebuilds the
renderer from the current checkout. Assisted setup starts a private loopback
server after you choose the bot space. Closing the window
hides it; Quit stops the owned server. Terminal sessions remain available with
`rein --terminal`. `rein desktop use klaud|nodeterm|terminal` changes the optional
desktop preference and preserves the other launch paths.

For a separately managed server, run `rein serve --port 4317`, then start the app
from `apps/klaud` with `npm run dev`. After initial local setup, use the attach environment variables to select
that server. It prints its loopback URL and the location of its private runtime token.
See [the desktop README](../apps/klaud/README.md) for environment variables.

For the native iOS client, use the separately enabled, resumable mobile gateway
described in [Rein Klaud mobile gateway](klaud-mobile.md). The normal desktop
bridge remains loopback-only.

The server binds only to `127.0.0.1`. The app keeps its bearer token in Electron's
main process. Model connections still use Rein's existing provider setup; the
desktop does not connect to a model directly. Shell preferences apply live.
Existing tool approvals remain in force. Bash follows the saved Auto or
Ask every time setting for authorized runs.
Hidden model reasoning is excluded from the displayed transcript.

The desktop adds no runtime dependencies to the CLI. Development dependencies
are installed only inside `apps/klaud`. The packaged Mac app keeps its embedded
code immutable and starts its local server in `~/.klaudbot/workspace`. The original `~/.rein` remains unchanged.

## First meeting

The four-step walkthrough brings over an existing Rein installation or creates a
fresh space, connects a self-hosted API or supported cloud account, asks about
working preferences and task limits, then names and dresses your first bot.
Model discovery is an explicit action; subscription sign-in uses the official
CLI on the host. You can defer the model connection and return through Settings.
Setup does not enable background autonomy or send the suggested first message.

Each bot has one of six rust-colored hats with floating eyewear and expressive
eyebrows: Aviator, Rider, Builder, Slugger, Medic, or Explorer. The eyebrows follow
reported activity and approval requests. Old bots receive a stable default hat;
changing headwear preserves their conversations. Active portraits have continuous
procedural drift, tilt, and moving eyewear and brows. They settle when idle,
pause when hidden or offscreen, and stay still with reduced motion.

The displayed name is **klaʊdbot**. The existing bundle identifier and
`rein-klaud.app` filename stay stable for installation and updates. Read the
[desktop README](../apps/klaud/README.md) for migration safeguards and storage.

## Optional training

`rein train recipe.yaml` invokes the separately installed Automodel training
environment with `uv`. In a Git checkout, initialize the pinned submodule:

```sh
git submodule update --init vendor/automodel
rein train /absolute/path/to/recipe.yaml
```

Install `uv` using its official instructions. Training dependencies and compatible
hardware are requirements of the selected recipe. Rein does not install Python
or download models during its tests. An npm installation can point
`REIN_AUTOMODEL_ROOT` at a separate Automodel checkout instead; the optional
Python source is excluded from the CLI package.

The bundled `ponytail`, `ponytail-review`, `ponytail-audit`, and `ponytail-debt`
skills load as text through Rein's existing skill tool. Loading a skill never
executes a hook or grants permission for an action.

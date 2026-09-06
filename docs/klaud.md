# rein-klaʊd desktop

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

From a checkout, install the desktop dependencies once:

```sh
npm --prefix apps/klaud ci
rein klaud
```

For source development, use `node bin/rein.js klaud`. The launcher rebuilds the
renderer from the current checkout and starts a private loopback server. Closing the window
hides it; Quit stops the owned server. Terminal sessions remain available with
`rein --terminal`. `rein desktop use klaud|nodeterm|terminal` changes the optional
desktop preference and preserves the other launch paths.

For a separately managed server, run `rein serve --port 4317`, then start the app
from `apps/klaud` with `npm run dev`. Choose URL + token in its first window. The
server prints its loopback URL and the location of its private runtime token.
See [the desktop README](../apps/klaud/README.md) for environment variables.

The server binds only to `127.0.0.1`. The app keeps its bearer token in Electron's
main process. Model connections still use Rein's existing provider setup; the
desktop does not connect to a model directly. Shell preferences apply live.
File writes, edits, and command execution ask for a decision in the desktop.
Hidden model reasoning is excluded from the displayed transcript.

The desktop adds no runtime dependencies to the CLI. Its Electron and React
dependencies are installed only inside `apps/klaud`. The first version runs from
source; a signed desktop installer is not included.

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

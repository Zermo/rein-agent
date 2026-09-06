# Cloud connections

Rein supports account sign-in through the official Codex and Copilot CLIs, or direct HTTP connections with a provider API key. Pick the route your account supports.

## ChatGPT through Codex

```sh
npm install -g @openai/codex
rein setup --provider codex
```

Follow the browser or device-code sign-in shown in the terminal. Use an account eligible for Codex. Rein uses a dedicated CLI profile, so an existing login elsewhere may not carry over.

To sign in again:

```sh
rein login codex
```

## GitHub Copilot

```sh
npm install -g @github/copilot
rein setup --provider copilot
```

Follow the sign-in flow with an account eligible for Copilot. To sign in again:

```sh
rein login copilot
```

The official CLIs manage their credentials and transport. These routes reject HTTP connection flags such as `--api`, `--base-url`, and `--ssh`.

## Provider API key

For OpenAI's Chat Completions API:

```sh
rein setup --provider openai --api chat-completions
```

Enter the key at the hidden terminal prompt and choose a model available to your account. API billing is separate from a chat subscription. For another provider or a custom endpoint, run `rein setup` and choose it in the wizard.

## Check the saved connection

```sh
rein setup --status &&
rein --no-tools -p "Reply with the single word: ok"
```

For HTTP, the status command checks the model connection. For subscription CLIs, it checks CLI availability and the authentication status the CLI exposes. The short model request verifies a response.

If sign-in fails, update the official CLI and run `rein login codex` or `rein login copilot` again. For HTTP 401, 403, or an unknown model, rerun setup and check the selected provider, key, and model ID.

[Open the connection walkthrough](https://zermo.github.io/rein-agent/#connect) or return to [Install](https://github.com/Zermo/rein-agent/wiki/Install).

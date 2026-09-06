# Grok in Rein

Rein offers two Grok connections: **Grok Build subscription** (`grok`) and the **xAI API** (`xai`).

## SuperGrok or X Premium+

Install the official Grok Build CLI, then select it in Rein:

```sh
npm install -g @xai-official/grok
rein setup --provider grok
```

Grok Build supports eligible **SuperGrok and X Premium+** accounts. Ordinary X Premium is not the same tier. The official service determines access and limits. [Grok Build announcement](https://x.ai/news/grok-build-cli), [official installation options](https://docs.x.ai/build/enterprise).

For X Premium+, sign into [Grok](https://grok.com), open **Settings → Account → Connect your X Account**, and link the account holding your subscription before signing into the CLI. [xAI account-linking instructions](https://docs.x.ai/grok/faq#how-can-i-link-my-x-account-sign-insubscription-to-my-xai-account).

Rein delegates sign-in to `grok login --device-auth`. The official CLI prints a verification URL and short code; complete them in your browser. Rein opens a printed `auth.x.ai` verification link when available. For SSH or a machine without a browser:

```sh
rein login grok --device-auth --no-browser
rein setup --provider grok --yes
```

Open the printed link on another device. `--no-browser` keeps Grok on device authentication, including when a browser-login preference was also supplied. [Official authentication reference](https://docs.x.ai/build/enterprise#authentication).

Rein uses its own `GROK_HOME` under `~/.rein/cli-auth/grok`. Grok manages the credentials there; Rein does not read or copy tokens from your existing Grok installation. An existing native Grok login therefore does not automatically sign Rein in. [Grok configuration paths](https://docs.x.ai/build/settings/reference).

## xAI API key

Choose **xai — cloud API key** in the setup menu, or run:

```sh
rein setup --provider xai
```

Setup opens the [xAI API key page](https://console.x.ai/team/default/api-keys), collects the key through a hidden prompt, and finds chat-capable models. `XAI_API_KEY` is also supported. Rein infers `https://api.x.ai/v1` and uses OpenAI-compatible Chat Completions. xAI still supports that endpoint as a legacy API; its newer capabilities may require the Responses API. [Chat Completions documentation](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions).

Discovery uses `/v1/language-models` and filters for text input and output, so image-only and video models do not appear as chat choices. Model access follows the selected key and account. [Model discovery reference](https://docs.x.ai/developers/rest-api-reference/inference/models).

Do not paste an X password, browser cookie, or device code into the API-key field. The subscription connection uses the official CLI login; the API connection uses an API key. Check the account's own usage and billing page for its allowance. xAI's current weekly usage display includes an API category, so Rein does not assume every plan has identical API billing. [Usage and limits](https://docs.x.ai/grok/faq#usage--limits).

## What the subscription bridge does

Rein sends the current conversation through a temporary private prompt file and reads Grok's structured output. Rein handles its own tools and approvals. Native Grok tools receive a catch-all deny rule, with a read-only sandbox as an additional boundary. Hooks from other agents, web search, subagents, and native memory are disabled for the bridge. Customized Rein Grok profiles and system-managed Grok configuration are preserved and rejected when they prevent isolation.

Grok Build 1.0.13 still advertises three shell-control tools after its tool-filter flags. Rein cancels any attempted native tool call and refuses an unexpected tool inventory. A completed reply must include the CLI's successful end event before Rein accepts text-tool calls. Reasoning-token counts are shown when reported; private thinking text is not surfaced.

This bridge was checked with the official 1.0.13 binary and a local mock server: completed text-tool requests, token usage, native execution denial, and cancellation. Subscription entitlement and live inference were not tested with an account. Grok may make its own session-metadata requests; its allowance and context accounting can differ from direct API use. [Headless CLI contract](https://docs.x.ai/build/cli/headless-scripting), [permissions](https://docs.x.ai/build/features/permissions).

`rein doctor` checks whether the Grok CLI is installed. Grok has no supported read-only login-status command, so installation is not reported as confirmed authentication. If access fails, run `rein login grok` and confirm your linked subscription, or select the `xai` API connection.

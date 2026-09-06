# Host models on your own hardware

Run Rein in your project directory and run a model server on any machine with enough memory for the model you choose. They can share a computer, connect across a LAN or mesh VPN, or use an SSH tunnel. Rein needs the server's OpenAI-compatible Chat Completions API and an available model ID.

## Install a model server

### LM Studio

1. Install [LM Studio](https://lmstudio.ai/download) on the machine that will run the model.
2. Download a model that fits that machine, then load it.
3. Open the Developer tab and start the API server. Keep the URL shown there.

If the `lms` CLI is available, you can also start the server with:

```sh
lms server start --port 1234
```

On the same computer, connect Rein with:

```sh
rein setup --provider lmstudio --api chat-completions
```

The preset uses `http://localhost:1234/v1`. If you chose a different port, pass the server's URL with `--base-url`. Use the OpenAI-compatible `/v1` API for Rein. See [LM Studio's server guide](https://lmstudio.ai/docs/developer/core/server) and [OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat).

### Ollama

Install [Ollama](https://ollama.com/download), then start its app or run `ollama serve`. In another terminal, download a model you choose from the [model catalog](https://ollama.com/search). Replace `MODEL_ID` with that model's name:

```sh
ollama pull MODEL_ID
rein setup --provider ollama --api chat-completions
```

Keep the server running. Rein uses `http://localhost:11434/v1`; choose an installed model when asked. A standard local Ollama server does not require an API key. See the [Ollama quickstart](https://docs.ollama.com/quickstart) and [Chat Completions compatibility](https://docs.ollama.com/api/openai-compatibility).

Other OpenAI-compatible servers, including llama.cpp and vLLM, work through their API URL. Rein has local discovery presets for ports 8080 and 8000 respectively. Choose a model with tool-use support for coding tasks.

## What Rein detects

`rein setup` checks these localhost ports for model lists:

| Server preset | Port |
| --- | --- |
| Ollama | 11434 |
| LM Studio | 1234 |
| llama.cpp | 8080 |
| vLLM | 8000 |

Discovery lists servers with available model IDs. If a server needs credentials, choose it explicitly and enter the key. An empty model list means you need to load or download a model, or enter its exact ID manually if the server supports that model but does not list it.

For a remote machine, supply its hostname or IP and port. Rein checks API path variants on that same origin, including `/v1/models`, and can recognize server types from common ports or model-list metadata. It does not enumerate network devices, mesh peers, or ports. A successful discovery is followed by a short Chat Completions check; a web dashboard URL alone is not enough.

## Connect over a LAN or mesh VPN

For direct HTTP access, configure the server to listen on an interface your Rein computer can reach. In LM Studio, enable **Serve on Local Network** or run:

```sh
lms server start --port 1234 --bind 0.0.0.0
```

Enable authentication when sharing the server. See [LM Studio network setup](https://lmstudio.ai/docs/developer/core/server/serve-on-network).

For Ollama, set `OLLAMA_HOST=0.0.0.0:11434` in the environment of the running app or service, then restart it. If starting a standalone server in a Unix shell, stop any existing instance first and use:

```sh
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

The [Ollama FAQ](https://docs.ollama.com/faq#how-can-i-expose-ollama-on-my-network) covers macOS application, Windows, and Linux service settings. Restrict model-server access through firewall or mesh access rules.

Connect both machines to your LAN or mesh, such as NetBird or Tailscale. Allow the API port through the host firewall and any mesh policy. Replace `model-host` with the reachable hostname or IP and use the actual server port:

```sh
rein setup --base-url http://model-host:1234 --api chat-completions
```

Use port 11434 for an Ollama server unless you changed it. `0.0.0.0` is a bind setting, not a client address. `localhost` and `127.0.0.1` refer to the machine running Rein unless you use the SSH option below. Joining a mesh does not make a loopback-only listener reachable from another device.

## Connect to a loopback-only server through SSH

Create an alias in your local `~/.ssh/config`, replacing both placeholders:

```sshconfig
Host model-host
    HostName YOUR_SERVER_HOSTNAME_OR_IP
    User YOUR_SSH_USER
```

Verify the connection and noninteractive authentication:

```sh
ssh model-host true
ssh -o BatchMode=yes model-host true
```

Then configure Rein using the server's loopback API address:

```sh
rein setup --ssh model-host --base-url 127.0.0.1:1234 \
  --api chat-completions
```

With `--ssh model-host`, `127.0.0.1` refers to that remote machine. The model server can stay bound to loopback. Rein opens an HTTP tunnel on an ephemeral local port and closes it after the request. Your network must permit SSH; this route does not require exposing the model API port.

## Verify the connection

```sh
rein setup --status &&
rein --no-tools -p "Reply with the single word: ok"
```

Choose a model returned by the server. Leave the API-key prompt blank only if your endpoint accepts unauthenticated requests; `API key: not saved` is then expected. A successful check reports `connection: passed`.

- Name resolution errors: check the hostname and your LAN or mesh DNS.
- Connection refused or timeout: check the running server, listening port, bind address, network route, and firewall.
- HTTP 401 or 403: enter the server's required API key.
- Missing API path or non-JSON response: use the API URL, including any reverse-proxy prefix, rather than a web dashboard.
- No models or an unknown model: load or download a model and rerun setup.
- SSH failures: verify the alias, username, host key, and `BatchMode=yes` command above.

[Open the field guide](https://zermo.github.io/rein-agent/#connect) or return to [Install](https://github.com/Zermo/rein-agent/wiki/Install).

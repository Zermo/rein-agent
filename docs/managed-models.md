# Managed local models

Rein can download a selected single-file GGUF from Hugging Face, verify it, serve it through an installed `llama-server`, and connect the harness to that server. The server runs headlessly and listens on loopback. `rein model service install` adds a separate user service on macOS or Linux. Use WSL2 for the complete terminal workflow on Windows.

This is separate from `rein models`, which still discovers existing Ollama, LM Studio, llama.cpp and other compatible API servers. Those connections continue to work through `rein setup`.

## Choose an artifact

Run `rein hardware` for the current machine's model recommendations and memory assumptions. Then select a GGUF repository and exact filename from Hugging Face:

```sh
rein model account
rein model plan publisher/model-GGUF --file model-Q4_K_M.gguf
```

The repository and filename above are placeholders. Plan resolves the requested branch, tag or commit to an immutable commit and shows the exact download size and SHA256. A model that matches Rein's curated catalog also gets a memory estimate using its KV geometry. An unknown model stays unverified; fitting its weights into RAM is not enough to establish a usable context or speed.

Public repositories need no account. For gated or private repositories, use an existing `hf auth login` or `HF_TOKEN`. Rein also respects `HF_HOME`, `HF_TOKEN_PATH` and `XDG_CACHE_HOME` when locating the standard cached token. `rein model account` checks credential availability without contacting Hugging Face or printing the token. Model access agreements remain on Hugging Face. [Hugging Face downloads](https://huggingface.co/docs/huggingface_hub/guides/download)

## Download and verify

Copy the install command printed by plan. It contains the resolved commit, so the selected artifact cannot change between planning and installation:

```sh
rein model install publisher/model-GGUF --revision FULL_COMMIT --file model-Q4_K_M.gguf
rein model list
rein model verify ARTIFACT_ID
```

Installation resumes a partial download using verified byte ranges, checks its complete size, SHA256 and GGUF header, then publishes the manifest. A changed revision gets a different artifact ID, preserving previous versions. Credentials never enter the manifest or cross-origin redirect headers.

Models live under `$REIN_HOME/models/artifacts`, defaulting to `~/.rein/models/artifacts`. No model or runtime starts during installation. Gracefully interrupted downloads release their lock and can resume. After a forcibly killed installer, inspect the indicated per-model `.lock` file and confirm no install is running before removing that lock and retrying. Model-file deletion is not exposed as a CLI action in this phase.

Split GGUF shards and repositories without a consistent LFS SHA256/size are not supported by this manager yet. Use a single-file artifact or connect an existing server.

## Serve and connect

Install llama.cpp from its official distribution so `llama-server` is on PATH, or pass an absolute executable path with `--runtime`. Rein validates the selected model file before launching it. [llama.cpp server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)

For a background service on macOS or Linux:

```sh
rein model service install ARTIFACT_ID --context 4096
rein model service status ARTIFACT_ID
rein model use ARTIFACT_ID
rein --terminal
```

Wait for the model to finish loading before `use`; it reports when the model is not ready. The service captures the resolved executable path for restarts. It does not depend on a later shell's PATH. These are user services, so their availability follows the platform's user-session service rules; Rein does not enable system-wide login persistence or Linux lingering.

To inspect startup directly, run the server in the foreground instead:

```sh
rein model serve ARTIFACT_ID --context 4096
```

That command stays open until stopped with Ctrl-C. Use another terminal pane for `rein model use ARTIFACT_ID`. Stop an installed service before starting the same model in the foreground. An occupied port or another serving owner causes an error; Rein never attaches to or kills the existing listener.

The default endpoint is `http://127.0.0.1:11436/v1`, with one sequence and a private per-model API key. Use `--port` for a different unprivileged port, `--threads` for CPU threads and `--gpu-layers` for explicit GPU offload. CPU serving is the default. Dedicated VRAM can satisfy preflight only when the selected offload covers all catalog layers plus the output layer, with one GPU and no device-visibility masks. Other layouts must fit the RAM estimate; memory is never summed across devices or the mesh. Context and memory checks are estimates; verify actual latency, tool use and memory pressure before autonomous work.

Startup checks health, the advertised model ID and a short JSON Chat Completion. `use` performs another connection test before saving the endpoint, key and serving context to private config. It preserves budgets, custom settings and fallback accounts, and clears obsolete SSH/CLI authentication fields. The environment and explicit command-line flags still take precedence over saved settings.

Service process status is different from model readiness. If a service fails to load the model, remove the service and run `serve` to inspect its startup diagnostics. This phase does not claim streaming/tool quality benchmarks for the selected model.

```sh
rein model service remove ARTIFACT_ID
```

Removal stops only that scoped service and removes its unchanged Rein-generated service file. Models, keys, sessions and config remain. Edited or unrelated service files are preserved. A later `rein model use` can switch back to a previously installed and running artifact.

The dedicated autonomy guardian remains separate from these task models. This manager does not change its model, budgets or enrollment.

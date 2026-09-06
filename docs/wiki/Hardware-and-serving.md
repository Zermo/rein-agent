# Hardware and serving

Run `rein hardware` on the machine that will host the model. Rein measures available system memory, CPU features and available GPU memory, then suggests a model and serving recipes. `rein hardware --json` returns the same plan for another tool. `rein hardware --context 8192 --focus coding` plans a smaller context explicitly.

If Rein connects to a different machine, the gateway's memory says nothing about the remote model's capacity. Run the hardware command on the serving machine too. An SSH tunnel or mesh route changes how requests travel; it does not move the model onto your laptop.

## What a fit means

The memory plan includes estimated weights, an f16 key/value cache at the selected context, a runtime allowance, and an OS/device reserve. Architecture-specific cache geometry replaces parameter-count guesses where publisher configuration is available. The plan assumes one active request. More requests, vision input and longer context need extra memory.

Each discrete GPU is checked independently. Rein does not add a small card's VRAM to a large card's VRAM and assume a model can use the result. Shared physical memory is counted once. Missing free VRAM yields “verify memory,” not an invented successful fit. Linux container ceilings are honored when exposed through the standard cgroup memory files.

The table describes a memory estimate. It does not establish measured throughput, model quality, a working driver, an installed runtime, downloaded weights or free disk space. A limited Apple bandwidth estimate is labeled with its source and uncertainty; it is not used as a model-quality ranking. MoE models need all their weights in memory even when a smaller subset is active per token.

The suggested starting model favors tool support and the selected work focus, with a model that stays in a single GPU or shared pool ahead of CPU placement. CPU-only machines start with a smaller tool model. Qwen3-Coder 30B-A3B is the coding specialist in the current catalog when it fits; Qwen3 8B and 4B cover smaller pools. These are curated starting points, not a claim that one model wins every task. [Qwen3-Coder model and artifact](https://ollama.com/library/qwen3-coder:30b), [Qwen3 4B](https://ollama.com/library/qwen3:4b).

## Choose one serving recipe

The report lists commands and prerequisites for compatible options. Nothing is installed, downloaded or started by the hardware check. If you already have a working server, connect to it in `rein setup`.

| Server | Use it for | Verify before launch |
| --- | --- | --- |
| LM Studio | A supported native app with model search and a local API | Supported OS/CPU, downloaded model key, selected quantization and its memory estimate |
| Ollama | Managed model downloads and a local model server | Installed version, exact model tag, context setting and actual GPU placement |
| llama.cpp | Explicit GGUF files and a chosen CPU/GPU backend | Backend build, local weights, architecture/template support and device selection |
| vLLM | A supported Linux CUDA host serving publisher weights | Python, driver/CUDA compatibility, supported GPU and a fresh FP16/BF16 memory assessment |

For LM Studio, `lms ls` lists downloaded model keys. Replace the recipe's `MODEL_KEY_FROM_LMS_LS` placeholder with that key. Run `lms load <key> --estimate-only --context-length 16384` before loading. Then use the report's load and `lms server start` commands. Do not type the placeholder literally. [LM Studio load options](https://lmstudio.ai/docs/cli/local-models/load), [server options](https://lmstudio.ai/docs/cli/serve/server-start), [system requirements](https://lmstudio.ai/docs/app/system-requirements).

For Ollama, apply the report's context and one-request settings to the process that actually serves requests. If its app or service is already running, configure that service instead of launching another copy. `ollama show <tag>` checks the artifact, and `ollama ps` shows whether a loaded model uses CPU, GPU or both. Mutable tags should be checked again after an update. [Ollama serving settings and placement](https://docs.ollama.com/faq).

For llama.cpp, replace `MODEL_FILE.gguf` with a compatible downloaded file. The recipe sets one sequence and explicit CPU or single-GPU placement. Check `llama-server --list-devices` against the selected device; ordering can vary by backend. [Build options](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md), [server options](https://github.com/ggml-org/llama.cpp/tree/master/tools/server).

A Q4 GGUF that fits does not mean the publisher's BF16 weights fit in vLLM. Rein evaluates those weights separately, enforces the recipe's 80% allocation budget and may suggest a smaller model for that engine. It only emits this CUDA recipe when the reported device capability qualifies; AMD and other backends require an independently verified upstream recipe. [vLLM installation requirements](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/), [tool parsing](https://docs.vllm.ai/en/stable/features/tool_calling/).

## Make the server reachable

Start locally first. The recipes bind to `127.0.0.1`. On the same machine, use the printed `/v1` base URL with the Chat Completions protocol in Rein setup.

For a second machine on your network or mesh, configure the server to listen on its chosen network interface, restrict access to the intended clients and enable authentication where supported. Alternatively, keep the server on loopback and use Rein's SSH-tunnel setup. Enter the address clients can actually reach. A server listening only on its own `127.0.0.1` cannot be discovered by another machine through its LAN address. [LM Studio network binding](https://lmstudio.ai/docs/cli/serve/server-start), [Ollama host configuration](https://docs.ollama.com/faq).

Verify `/v1/models`, then select the returned model ID in `rein setup`. Test a short chat and a harmless tool call before enabling autonomous jobs. A successful model listing establishes API discovery; it does not prove a model can load or execute tools correctly. Use `rein doctor` for the configured connection check.

The implementation is Magnitude-inspired memory planning implemented in Rein with no runtime dependencies. It is not a claim that Magnitude benchmarks or native scheduling are running inside Rein.

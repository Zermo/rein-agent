/** Explicit local model actions. Listing servers remains `rein models`. */
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readConfig, saveConfig, configPath } from "../ai/config.ts";
import { testConnection } from "../harness/setup.ts";
import { profileHardware } from "../hardware/profile.ts";
import { modelAccount } from "./account.ts";
import { planModelArtifact, formatArtifactPlan } from "./planning.ts";
import { resolveModelArtifact, installModelArtifact, listInstalledModels, verifyInstalledModel } from "./artifacts.ts";
import { runModelServer, readModelConnection } from "./runtime.ts";
import { installModelService, modelServiceStatus, removeModelService } from "./runtime-service.ts";

type Flags = Record<string, string | boolean>;
export const MODEL_HELP = `Managed local models

  rein model account                         inspect Hugging Face credential availability
  rein model plan <owner/repo> --file <gguf>   resolve a pinned artifact and estimate memory
  rein model install <owner/repo> --file <gguf> [--revision <commit>]
                                             download, resume and verify the selected artifact
  rein model list                            list installed artifacts (no network scan)
  rein model verify <artifact-id>             check the complete installed file against SHA256
  rein model serve <artifact-id>              run a headless loopback llama-server until stopped
  rein model use <artifact-id>                test the running model and save its local connection
  rein model service install <artifact-id>    register a headless user service (macOS/Linux)
  rein model service status <artifact-id>     inspect the scoped user service
  rein model service remove <artifact-id>     stop/remove the service, preserving model files

  --revision <branch|tag|commit>               plan/install: resolve to a full immutable commit
  --context <tokens>                          plan/serve/service install (default 4096)
  --runtime <executable>                      serve/service install: installed llama-server path
  --port <n>                                  serve/service install/use (default serving port 11436)
  --gpu-layers <n>                            serve/service install: explicit GPU offload (default 0)
  --threads <n>                               serve/service install: CPU thread count
  --json                                      structured output; serve emits lifecycle events

Single-file GGUF artifacts are supported first. HF_TOKEN or an existing hf auth
login supplies gated/private repository access; credentials are never copied
into artifact manifests. No model or service starts during plan or install.
Run rein hardware for catalog recommendations and rein models for API discovery.`;

export interface ModelCommandDependencies {
	log?: (message: string) => void;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	account?: typeof modelAccount;
	hardware?: typeof profileHardware;
	resolveArtifact?: typeof resolveModelArtifact;
	installArtifact?: typeof installModelArtifact;
	list?: typeof listInstalledModels;
	verify?: typeof verifyInstalledModel;
	serve?: typeof runModelServer;
	connection?: typeof readModelConnection;
	test?: typeof testConnection;
	readConfig?: typeof readConfig;
	saveConfig?: typeof saveConfig;
}
function validate(flags: Flags, allowed: string[]): void {
	for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new Error(`Unsupported option --${key}. Run rein model help.`);
	if (flags.json !== undefined && typeof flags.json !== "boolean") throw new Error("--json expects true or false.");
}
function stringFlag(flags: Flags, name: string, required = false): string | undefined {
	const value = flags[name];
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`--${name} requires a value without control characters.`);
	return value.trim();
}
function integerFlag(flags: Flags, name: string, min: number, max: number): number | undefined {
	const raw = stringFlag(flags, name);
	if (raw === undefined) return undefined;
	const number = Number(raw);
	if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
	return number;
}
function artifactId(value: string | undefined): string {
	if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Provide the full artifact ID from rein model list.");
	return value;
}
function servingOptions(flags: Flags) {
	return { runtime: stringFlag(flags, "runtime"), port: integerFlag(flags, "port", 1024, 65535), context: integerFlag(flags, "context", 256, 131072), gpuLayers: integerFlag(flags, "gpu-layers", 0, 999), threads: integerFlag(flags, "threads", 1, 1024) };
}
const SERVE_FLAGS = ["runtime", "port", "context", "gpu-layers", "threads", "json"];

export async function runModelCommand(args: string[], flags: Flags = {}, deps: ModelCommandDependencies = {}): Promise<void> {
	const log = deps.log ?? console.log, env = deps.env ?? process.env;
	const json = flags.json === true;
	const home = resolve(env.REIN_HOME || resolve(homedir(), ".rein"));
	const action = args[0] ?? "help";
	if (action === "help") { if (args.length > 1 || Object.keys(flags).length) throw new Error("Usage: rein model help"); log(MODEL_HELP); return; }
	const count = action === "service" ? 3 : ["plan", "install", "verify", "serve", "use"].includes(action) ? 2 : 1;
	if (args.length !== count) throw new Error("Incorrect model arguments. Run rein model help.");
	const allowed = action === "plan" ? ["file", "revision", "context", "json"] : action === "install" ? ["file", "revision", "json"] : action === "serve" ? SERVE_FLAGS : action === "service" ? (args[1] === "install" ? SERVE_FLAGS : ["json"]) : action === "use" ? ["port", "json"] : ["json"];
	validate(flags, allowed);
	if (!["account", "plan", "install", "list", "verify", "serve", "service", "use"].includes(action)) throw new Error("Unknown model action. Run rein model help.");
	const controller = new AbortController();
	const signal = deps.signal ?? controller.signal;
	const interrupt = () => controller.abort();
	if (!deps.signal) { process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt); }
	let token: string | undefined;
	try {
		signal.throwIfAborted();
		if (action === "account") {
			const account = await (deps.account ?? modelAccount)(env);
			const status = { authenticated: Boolean(account.token), source: account.source, verified: false };
			log(json ? JSON.stringify(status, null, 2) : account.token ? `Hugging Face credential available (${account.source}). This checks availability, not account access.` : "Public model downloads are available. For gated/private models, run hf auth login or set HF_TOKEN.");
			return;
		}
		if (action === "plan" || action === "install") {
			const file = stringFlag(flags, "file", true)!;
			const revision = stringFlag(flags, "revision");
			const context = integerFlag(flags, "context", 256, 131072);
			token = (await (deps.account ?? modelAccount)(env)).token;
			const artifact = await (deps.resolveArtifact ?? resolveModelArtifact)(args[1], file, { revision, token, signal });
			if (action === "plan") {
				const plan = planModelArtifact(artifact, await (deps.hardware ?? profileHardware)(), context);
				log(json ? JSON.stringify(plan, null, 2) : formatArtifactPlan(plan)); return;
			}
			let lastProgress = -1;
			const model = await (deps.installArtifact ?? installModelArtifact)(artifact, { home, token, signal, onProgress(received, total) {
				const percent = Math.floor(received / total * 100);
				if (!json && percent >= lastProgress + 10) { lastProgress = percent; log(`Downloading ${Math.min(100, percent)}%`); }
			} });
			log(json ? JSON.stringify(model, null, 2) : `Installed and verified ${model.artifact.file}\nArtifact ID: ${model.artifact.id}\nServe: rein model serve ${model.artifact.id}\nAn installed llama-server executable is required. Run rein model help for runtime options.`);
			return;
		}
		if (action === "list") {
			const models = await (deps.list ?? listInstalledModels)({ home });
			log(json ? JSON.stringify(models, null, 2) : models.length ? models.map(m => `${m.artifact.repo} / ${m.artifact.file}\n  ID: ${m.artifact.id}\n  revision: ${m.artifact.revision}`).join("\n") : "No managed models installed. Run rein model plan <owner/repo> --file <model.gguf>."); return;
		}
		if (action === "verify") {
			const model = await (deps.verify ?? verifyInstalledModel)(artifactId(args[1]), { home, signal });
			log(json ? JSON.stringify({ verified: true, ...model }, null, 2) : `SHA256 verified: ${model.artifact.id}`); return;
		}
		if (action === "serve") {
			await (deps.serve ?? runModelServer)(artifactId(args[1]), { ...servingOptions(flags), home, signal,
				log: message => log(json ? JSON.stringify({ type: "runtime", message }) : message),
				onReady(plan) { log(json ? JSON.stringify({ type: "ready", plan }) : `Model ready at ${plan.baseUrl}\nConnect Rein: rein model use ${plan.modelId} --port ${plan.port}\nStop this process with Ctrl-C, or use rein model service install for headless background hosting.`); },
			}); return;
		}
		if (action === "use") {
			const id = artifactId(args[1]);
			const connection = await (deps.connection ?? readModelConnection)(id, { home, port: integerFlag(flags, "port", 1024, 65535) });
			token = connection.apiKey;
			const result = await (deps.test ?? testConnection)(connection.baseUrl, connection.model, connection.apiKey);
			if (!result.ok) throw new Error(`Local model connection failed. Configuration was preserved. ${result.detail}`);
			signal.throwIfAborted();
			// Re-read after the asynchronous probe so unrelated settings changed
			// during model loading are not replaced by an earlier snapshot.
			const previous = (deps.readConfig ?? readConfig)();
			const next = { ...previous, provider: "custom", api: "chat-completions", auth: { type: "api-key" }, baseUrl: connection.baseUrl, model: connection.model, apiKey: connection.apiKey, contextWindow: connection.context ?? 4096 };
			delete (next as Record<string, unknown>).sshHost;
			(deps.saveConfig ?? saveConfig)(next);
			const output = { saved: true, baseUrl: connection.baseUrl, model: connection.model, contextWindow: next.contextWindow };
			log(json ? JSON.stringify(output, null, 2) : `Chat Completions test passed. Saved local model connection to ${configPath()}.\nStart Rein in your terminal with rein --terminal.`); return;
		}
		if (action === "service") {
			const id = artifactId(args[2]);
			if (!["install", "status", "remove"].includes(args[1])) throw new Error("Usage: rein model service install|status|remove <artifact-id>");
			const options = { id, home, cliPath: resolve(process.argv[1]), nodePath: process.execPath, signal, ...(args[1] === "install" ? servingOptions(flags) : {}) };
			const result = args[1] === "install" ? await installModelService(options) : args[1] === "remove" ? await removeModelService(options) : await modelServiceStatus(options);
			log(json ? JSON.stringify(result, null, 2) : result.message);
		}
	} catch (error) {
		if (signal.aborted) throw new Error("Model operation cancelled. Interrupted downloads can be resumed by running install again.");
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(token ? message.split(token).join("[redacted]") : message);
	} finally {
		if (!deps.signal) { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
	}
}

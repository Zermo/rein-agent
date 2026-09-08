/**
 * rein doctor — Magnitude-style environment doctor, with self-healing.
 *
 * Auto-detects the whole stack: runtime → bin → repo → bundle → config →
 * model server → model → hardware fit → perms → disk. Each check reports
 * status + a fix hint; `--fix` runs the auto-repairs (git pull, bundle
 * rebuild, ollama pull, chmod) and re-checks. Exit 0 = healthy, 1 = not.
 *
 * This is the "verify the packaged runtime works" idea from Magnitude's
 * `acn doctor` (checks embedded ripgrep), extended to the rein stack and
 * made self-healing — it feeds `rein heartbeat`, the self-sustaining loop.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dim, green, red, yellow } from "../util/ansi.ts";
import { loadConfig, apiKeyFor, detectEndpoint, guessProvider, normalizeBaseUrl } from "../ai/models.ts";
import { configPath } from "../ai/config.ts";
import { resolveRunBudgets } from "./run-budgets.ts";
import type { ReinConfig } from "../ai/models.ts";
import { checkCliAuth } from "./auth.ts";
import { matchCatalog } from "../hardware/catalog.ts";
import { bestAssessment } from "../hardware/fit.ts";
import { servingRecommendations } from "../hardware/recipes.ts";
import { profileHardware } from "../hardware/profile.ts";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorFlag {
	name: string;
	kind: "compatibility";
	silent: true;
	detail: string;
}

export interface DoctorCheck {
	name: string;
	status: DoctorStatus;
	detail: string;
	/** Expected compatibility information, never a warning or a repair request. */
	flag?: DoctorFlag;
	fix?: string; // human hint
	autoFix?: () => Promise<string>; // returns what it did; run under --fix
}

export interface DoctorResult {
	healthy: number;
	total: number;
	fixed: string[];
	warnings: number;
	failures: number;
	flags: DoctorFlag[];
	checks: DoctorCheck[];
}

/** These majors remain in our explicit CI compatibility matrix. */
const NODE_COMPATIBILITY_MAJORS = new Set([18, 20, 22, 24]);

export function checkNodeRuntime(version = process.versions.node): DoctorCheck {
	const major = Number(version.split(".")[0]);
	const supported = Number.isSafeInteger(major) && major >= 18;
	return {
		name: "node", status: supported ? "ok" : "fail", detail: `v${version}`,
		fix: supported ? undefined : "node ≥18 required (brew install node)",
		flag: supported && NODE_COMPATIBILITY_MAJORS.has(major) ? {
			name: "node-runtime", kind: "compatibility", silent: true,
			detail: `Node.js ${version} is in Rein's compatibility matrix; CI also tests the newest Node.js release.`,
		} : undefined,
	};
}

export function summarizeDoctor(checks: DoctorCheck[], fixed: string[] = []): DoctorResult {
	return {
		healthy: checks.filter(c => c.status === "ok").length,
		total: checks.length, fixed, checks,
		warnings: checks.filter(c => c.status === "warn").length,
		failures: checks.filter(c => c.status === "fail").length,
		// Only a passing check can carry an expected compatibility flag.
		flags: checks.flatMap(c => c.status === "ok" && c.flag ? [c.flag] : []),
	};
}

export function formatDoctorCheck(check: DoctorCheck, silent = true): string | undefined {
	if (silent && check.status === "ok" && check.flag?.silent) return undefined;
	const mark = check.status === "ok" ? green("✓") : check.status === "warn" ? yellow("△") : red("✗");
	const fix = check.fix && check.status !== "ok" ? dim(`  → ${check.fix}`) : "";
	const compatibility = check.status === "ok" && check.flag ? dim(`  (${check.flag.detail})`) : "";
	return `  ${mark} ${check.name.padEnd(10)} ${check.detail}${fix}${compatibility}`;
}

function run(command: string, args: string[], opts: { timeout?: number } = {}): { out: string; err: string } {
	try {
		const out = execFileSync(command, args, {
			encoding: "utf8",
			timeout: opts.timeout ?? 15_000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { out, err: "" };
	} catch (e: any) {
		return { out: e.stdout?.toString() ?? "", err: (e.stderr?.toString() || e.message).slice(0, 200) };
	}
}

/** Walk up from a file to the nearest ancestor that is a git worktree. */
function gitRootOf(file: string, maxDepth = 4): string | undefined {
	let dir = existsSync(file) && statSync(file).isFile() ? dirname(file) : file;
	for (let i = 0; i < maxDepth; i++) {
		if (existsSync(join(dir, ".git"))) return dir;
		const up = dirname(dir);
		if (up === dir) return undefined;
		dir = up;
	}
	return undefined;
}

function newestMtime(dir: string): number {
	let newest = 0;
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			const p = join(d, entry.name);
			if (entry.isDirectory()) walk(p);
			else newest = Math.max(newest, statSync(p).mtimeMs);
		}
	};
	walk(dir);
	return newest;
}

export function usesLocalHardware(config: ReinConfig): boolean {
	if (!config.baseUrl || config.sshHost) return false;
	try {
		const host = new URL(normalizeBaseUrl(config.baseUrl)).hostname;
		return host === "localhost" || host === "[::1]" || /^127\./.test(host);
	} catch { return false; }
}

/** Provider diagnosis never launches login or repairs an unrelated local server. */
export async function checkConfiguredProvider(config: ReinConfig): Promise<DoctorCheck> {
	const cli = config.auth?.type === "cli" ? config.auth.provider ?? config.provider : config.provider;
	if (cli === "codex" || cli === "copilot" || cli === "grok") {
		const status = await checkCliAuth(cli);
		return { name: "server", status: !status.available || status.authenticated === false ? "fail" : status.authenticated === null ? "warn" : "ok",
			detail: status.detail, fix: status.authenticated === true ? undefined : `rein login ${cli}` };
	}
	try {
		const baseUrl = normalizeBaseUrl(config.baseUrl!);
		const provider = config.provider ?? guessProvider(baseUrl);
		const detected = await detectEndpoint(baseUrl, { provider, apiKey: apiKeyFor(provider, baseUrl, config.sshHost), sshHost: config.sshHost, timeoutMs: 5000 });
		if (detected.error) return { name: "server", status: "fail", detail: detected.error, fix: "rein setup --status; check the server listener and VPN/SSH connection" };
		if (detected.baseUrl.replace(/\/$/, "") !== baseUrl.replace(/\/$/, "")) return {
			name: "server", status: "fail", detail: `API responds at ${detected.baseUrl}, but the saved endpoint is ${baseUrl}`,
			fix: "rein setup --yes to save the detected API prefix",
		};
		const listed = detected.models.includes(config.model!) || provider === "ollama" && detected.models.includes(`${config.model}:latest`);
		const localOllama = provider === "ollama" && usesLocalHardware(config);
		return {
			name: "server", status: listed ? "ok" : "warn",
			detail: `${detected.models.length} model(s) listed${listed ? ", configured model present" : `; ${config.model} is not listed`}${config.sshHost ? ` via SSH ${config.sshHost}` : ""}`,
			fix: listed ? undefined : localOllama ? `ollama pull ${config.model}` : "rein setup to select a model served by this endpoint",
		};
	} catch (error) { return { name: "server", status: "fail", detail: (error as Error).message, fix: "rein setup" }; }
}

export async function runDoctor(opts: { fix?: boolean; quiet?: boolean; silent?: boolean } = {}): Promise<DoctorResult> {
	const checks: DoctorCheck[] = [];
	const say = (s: string) => { if (!opts.quiet) console.log(s); };
	let config: ReinConfig = {};
	let configError: string | undefined;
	try { config = loadConfig(); } catch (error) { configError = (error as Error).message; }

	// 1. node runtime
	checks.push(checkNodeRuntime());

	// 2. rein on PATH → real install
	let binPath: string | undefined;
	let repo: string | undefined;
	{
		const { out } = run("sh", ["-c", "command -v rein"]);
		binPath = out.trim() || undefined;
		if (!binPath) {
			checks.push({ name: "bin", status: "fail", detail: "rein not on PATH", fix: "curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh | bash" });
		} else {
			let real = binPath;
			try { real = realpathSync(binPath); } catch { /* not a symlink */ }
			repo = gitRootOf(real);
			let installedPackage = false;
			try {
				const packageRoot = dirname(dirname(real));
				installedPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name === "rein-agent"
					&& real === join(packageRoot, "dist", "rein.js");
			} catch { /* A source checkout or an incomplete install. */ }
			const distOk = installedPackage || repo && existsSync(join(repo, "dist", "rein.js"));
			checks.push({
				name: "bin",
				status: distOk ? "ok" : "fail",
				detail: binPath + (repo ? ` → ${repo}` : ""),
				fix: distOk ? undefined : "install is missing dist/rein.js — reinstall (curl one-liner above)",
			});
		}
	}

	// 3. repo fresh vs origin
	if (repo) {
		const local = run("git", ["-C", repo, "rev-parse", "HEAD"]).out.trim();
		const remote = run("git", ["-C", repo, "ls-remote", "origin", "main"], { timeout: 10_000 });
		if (remote.err) {
			checks.push({ name: "repo", status: "warn", detail: `@ ${local.slice(0, 7)} (offline — could not compare to origin)` });
		} else {
			const remoteSha = remote.out.trim().split(/\s+/)[0];
			checks.push({
				name: "repo",
				status: remoteSha && remoteSha === local ? "ok" : "fail",
				detail: `local ${local.slice(0, 7)} / origin ${remoteSha?.slice(0, 7) ?? "?"}`,
				fix: remoteSha && remoteSha !== local ? "git -C " + repo + " pull --ff-only" : undefined,
				autoFix: async () => {
					const r = run("git", ["-C", repo!, "pull", "--ff-only"], { timeout: 30_000 });
					if (r.err) throw new Error(r.err);
					return "git pull --ff-only";
				},
			});
		}
	}

	// 4. bundle fresh vs src
	if (repo) {
		const bundle = join(repo, "dist", "rein.js");
		if (!existsSync(bundle)) {
			checks.push({ name: "bundle", status: "fail", detail: "dist/rein.js missing", fix: "npm run bundle", autoFix: async () => { const r = run("npm", ["run", "bundle", "--prefix", repo!], { timeout: 60_000 }); if (r.err) throw new Error(r.err); return "npm run bundle"; } });
		} else {
			const bundleMtime = statSync(bundle).mtimeMs;
			const srcMtime = newestMtime(join(repo, "src"));
			const fresh = bundleMtime >= srcMtime;
			checks.push({
				name: "bundle",
				status: fresh ? "ok" : "fail",
				detail: fresh ? "dist is current" : "dist is older than src",
				fix: fresh ? undefined : "npm run bundle",
				autoFix: fresh ? undefined : async () => { const r = run("npm", ["run", "bundle", "--prefix", repo!], { timeout: 60_000 }); if (r.err) throw new Error(r.err); return "npm run bundle"; },
			});
		}
	}

	// 5. config
	const hasConfig = Boolean(config.model && config.baseUrl);
	checks.push({
		name: "config",
		status: hasConfig ? "ok" : "fail",
		detail: configError ?? (hasConfig ? `model=${config.model} base=${config.baseUrl}` : `${configPath()} missing or incomplete`),
		fix: hasConfig ? undefined : configError ? "Repair the config file shown above; it has not been overwritten" : "rein setup",
	});
	if (!configError) {
		try {
			const budgets = resolveRunBudgets(config);
			checks.push({ name: "task budgets", status: "ok", detail: `${budgets.maxTurns} model turns per prompt; ${budgets.maxIterations} loop/improve iterations. Settings: ${configPath()}` });
		} catch (error) { checks.push({ name: "task budgets", status: "fail", detail: (error as Error).message, fix: "rein setup budgets --yes --max-turns 300 --max-iterations 25" }); }
	}

	// 6. Probe the selected endpoint, including protected APIs and SSH tunnels.
	if (hasConfig) checks.push(await checkConfiguredProvider(config));

	// 7. hardware fit (local servers only — a remote model lives on other metal)
	const localish = usesLocalHardware(config);
	if (hasConfig && localish) {
		try {
			const profile = await profileHardware();
			const entry = matchCatalog(config.model!);
			if (!entry) {
				checks.push({ name: "hardware", status: "ok", detail: `machine: ${profile.cpu.name} · ${Math.round(profile.ram.totalBytes / 2 ** 30)} GB (model not in catalog — fit unchecked)` });
			} else {
				const fit = bestAssessment(profile, entry);
				let bestPick = "";
				if (fit.verdict === "no") {
					bestPick = servingRecommendations(profile).best?.model.name ?? "none fits on this machine";
				}
				checks.push({
					name: "hardware",
					status: fit.verdict === "no" ? "warn" : "ok",
					detail: `${entry.name} → ${fit.verdict} (${(fit.totalBytes / 2 ** 30).toFixed(1)} GiB footprint, est. ${fit.estTokS?.toFixed(0) ?? "?"} tok/s)`,
					fix: fit.verdict === "no" ? `best pick here: ${bestPick} (see rein hardware)` : undefined,
				});
			}
		} catch {
			checks.push({ name: "hardware", status: "warn", detail: "hardware profile failed (continuing)" });
		}
	}

	// 8. config perms
	const cfgPath = configPath();
	if (!configError && existsSync(cfgPath) && (config.apiKey || apiKeyFor(config.provider, config.baseUrl, config.sshHost))) {
		const mode = lstatSync(cfgPath).mode & 0o777;
		checks.push({
			name: "perms",
			status: (mode & 0o077) === 0 ? "ok" : "warn",
			detail: `config mode ${mode.toString(8)} (apiKey present)`,
			fix: (mode & 0o077) === 0 ? undefined : "chmod 600 " + cfgPath,
			autoFix: (mode & 0o077) === 0 ? undefined : async () => { chmodSync(cfgPath, 0o600); return "chmod 600 " + cfgPath; },
		});
	}

	// 9. disk space
	try {
		const { statfsSync } = await import("node:fs");
		const free = statfsSync(homedir()).bavail * statfsSync(homedir()).bsize;
		const GiB = free / 2 ** 30;
		checks.push({ name: "disk", status: GiB >= 1 ? "ok" : "warn", detail: `${GiB.toFixed(1)} GiB free in $HOME` });
	} catch {
		checks.push({ name: "disk", status: "warn", detail: "could not statfs $HOME" });
	}

	// --- self-healing pass
	const fixed: string[] = [];
	if (opts.fix) {
		for (const c of checks) {
			if (c.status === "fail" && c.autoFix) {
				say(dim(`fixing ${c.name}: ${c.fix ?? ""} …`));
				try {
					const what = await c.autoFix();
					c.status = "ok";
					c.detail += ` (fixed: ${what})`;
					fixed.push(c.name);
					say(green(`  ✓ ${c.name} repaired`));
				} catch (e: any) {
					c.detail += ` (fix failed: ${e.message?.slice(0, 80)})`;
					say(red(`  ✗ ${c.name}: ${e.message?.slice(0, 80)}`));
				}
			}
		}
	}

	const result = summarizeDoctor(checks, fixed);
	const { healthy } = result;

	// --- render
	if (!opts.quiet) {
		for (const c of checks) {
			const line = formatDoctorCheck(c, opts.silent ?? true);
			if (line !== undefined) console.log(line);
		}
		const bad = checks.length - healthy;
		const line = bad === 0
			? green(`${healthy}/${checks.length} healthy`) + (fixed.length ? dim(` (${fixed.length} self-healed)`) : "")
			: red(`${healthy}/${checks.length} healthy, ${bad} problem${bad > 1 ? "s" : ""}`) + yellow(bad > 0 ? " — run `rein doctor --fix` to auto-repair" : "");
		console.log(line);
	}

	return result;
}

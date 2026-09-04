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
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dim, green, red, yellow } from "../util/ansi.ts";
import { loadConfig, apiKeyFor } from "../ai/models.ts";
import { matchCatalog, CATALOG } from "../hardware/catalog.ts";
import { bestAssessment } from "../hardware/fit.ts";
import { profileHardware } from "../hardware/profile.ts";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
	name: string;
	status: DoctorStatus;
	detail: string;
	fix?: string; // human hint
	autoFix?: () => Promise<string>; // returns what it did; run under --fix
}

export interface DoctorResult {
	healthy: number;
	total: number;
	fixed: string[];
	checks: DoctorCheck[];
}

function sh(cmd: string, opts: { input?: string; timeout?: number } = {}): { out: string; err: string } {
	try {
		const out = execFileSync("sh", ["-c", cmd], {
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

async function checkServerModels(baseUrl: string, model: string): Promise<{ reachable: boolean; models: string[] }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5_000);
	try {
		const res = await fetch(baseUrl.replace(/\/$/, "") + "/models", { signal: controller.signal });
		if (!res.ok) return { reachable: false, models: [] };
		const json = (await res.json().catch(() => ({}))) as any;
		const models: string[] = (json?.data ?? []).map((m: any) => m?.id).filter(Boolean);
		return { reachable: true, models };
	} catch {
		return { reachable: false, models: [] };
	} finally {
		clearTimeout(timer);
	}
}

export async function runDoctor(opts: { fix?: boolean; quiet?: boolean } = {}): Promise<DoctorResult> {
	const checks: DoctorCheck[] = [];
	const say = (s: string) => { if (!opts.quiet) console.log(s); };
	const config = loadConfig();

	// 1. node runtime
	{
		const major = parseInt(process.versions.node.split(".")[0], 10);
		checks.push({
			name: "node",
			status: major >= 18 ? "ok" : "fail",
			detail: `v${process.versions.node}`,
			fix: major >= 18 ? undefined : "node ≥18 required (brew install node)",
		});
	}

	// 2. rein on PATH → real install
	let binPath: string | undefined;
	let repo: string | undefined;
	{
		const { out } = sh("command -v rein");
		binPath = out.trim() || undefined;
		if (!binPath) {
			checks.push({ name: "bin", status: "fail", detail: "rein not on PATH", fix: "curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh | bash" });
		} else {
			let real = binPath;
			try { real = realpathSync(binPath); } catch { /* not a symlink */ }
			repo = gitRootOf(real);
			const distOk = repo && existsSync(join(repo, "dist", "rein.js"));
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
		const local = sh("git -C " + JSON.stringify(repo) + " rev-parse HEAD").out.trim();
		const remote = sh("git -C " + JSON.stringify(repo) + " ls-remote origin main", { timeout: 10_000 });
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
					const r = sh("git -C " + JSON.stringify(repo) + " pull --ff-only", { timeout: 30_000 });
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
			checks.push({ name: "bundle", status: "fail", detail: "dist/rein.js missing", fix: "npm run bundle", autoFix: async () => { const r = sh("npm run bundle --prefix " + JSON.stringify(repo), { timeout: 60_000 }); if (r.err) throw new Error(r.err); return "npm run bundle"; } });
		} else {
			const bundleMtime = statSync(bundle).mtimeMs;
			const srcMtime = newestMtime(join(repo, "src"));
			const fresh = bundleMtime >= srcMtime;
			checks.push({
				name: "bundle",
				status: fresh ? "ok" : "fail",
				detail: fresh ? "dist is current" : "dist is older than src",
				fix: fresh ? undefined : "npm run bundle",
				autoFix: fresh ? undefined : async () => { const r = sh("npm run bundle --prefix " + JSON.stringify(repo), { timeout: 60_000 }); if (r.err) throw new Error(r.err); return "npm run bundle"; },
			});
		}
	}

	// 5. config
	const hasConfig = Boolean(config.model && config.baseUrl);
	checks.push({
		name: "config",
		status: hasConfig ? "ok" : "fail",
		detail: hasConfig ? `model=${config.model} base=${config.baseUrl}` : "~/.rein/config.json missing or incomplete",
		fix: hasConfig ? undefined : "rein setup",
	});

	// 6. server reachable + model listed (only when we have a local-ish config)
	let models: string[] = [];
	let reachable = false;
	if (hasConfig) {
		({ reachable, models } = await checkServerModels(config.baseUrl!, config.model!));
		if (!reachable) {
			checks.push({ name: "server", status: "fail", detail: `${config.baseUrl} not answering /models (5s)`, fix: "start the model server (ollama serve) or fix baseUrl" });
		} else {
			const listed = models.some((m) => m === config.model || m.startsWith(config.model!));
			checks.push({
				name: "server",
				status: listed ? "ok" : "fail",
				detail: `${models.length} model(s) listed` + (listed ? ", configured model present" : `, "${config.model}" NOT listed`),
				fix: listed ? undefined : `ollama pull ${config.model}`,
				autoFix: listed ? undefined : async () => {
					const r = sh(`ollama pull ${JSON.stringify(config.model!)}`, { timeout: 300_000 });
					if (r.err) throw new Error(r.err);
					return `ollama pull ${config.model}`;
				},
			});
		}
	}

	// 7. hardware fit (local servers only — a remote model lives on other metal)
	const localish = /localhost|127\.0\.0\.1|192\.168\.|10\./.test(config.baseUrl ?? "");
	if (hasConfig && localish) {
		try {
			const profile = await profileHardware();
			const entry = matchCatalog(config.model!);
			if (!entry) {
				checks.push({ name: "hardware", status: "ok", detail: `machine: ${profile.cpu} · ${Math.round(profile.totalMemoryBytes / 2 ** 30)} GB (model not in catalog — fit unchecked)` });
			} else {
				const fit = bestAssessment(profile, entry);
				let bestPick = "";
				if (fit.verdict === "no") {
					const fitting = CATALOG
						.map((m) => ({ m, a: bestAssessment(profile, m) }))
						.filter(({ a }) => a.verdict === "fits")
						.sort((x, y) => (y.a.estTokS ?? 0) - (x.a.estTokS ?? 0));
					bestPick = fitting.length ? fitting[0].m.name : "none fits on this machine";
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
	const cfgPath = join(homedir(), ".rein", "config.json");
	if (existsSync(cfgPath) && (config.apiKey || apiKeyFor(config.provider))) {
		const mode = lstatSync(cfgPath).mode & 0o777;
		checks.push({
			name: "perms",
			status: (mode & 0o077) === 0 ? "ok" : "warn",
			detail: `config mode ${mode.toString(8)} (apiKey present)`,
			fix: (mode & 0o077) === 0 ? undefined : "chmod 600 " + cfgPath,
			autoFix: (mode & 0o077) === 0 ? undefined : async () => { const r = sh(`chmod 600 ${JSON.stringify(cfgPath)}`); if (r.err) throw new Error(r.err); return "chmod 600 " + cfgPath; },
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

	const healthy = checks.filter((c) => c.status === "ok").length;
	const result: DoctorResult = { healthy, total: checks.length, fixed, checks };

	// --- render
	if (!opts.quiet) {
		for (const c of checks) {
			const mark = c.status === "ok" ? green("✓") : c.status === "warn" ? yellow("△") : red("✗");
			const fix = c.fix && c.status !== "ok" ? dim(`  → ${c.fix}`) : "";
			console.log(`  ${mark} ${c.name.padEnd(10)} ${c.detail}${fix}`);
		}
		const bad = checks.length - healthy;
		const line = bad === 0
			? green(`${healthy}/${checks.length} healthy`) + (fixed.length ? dim(` (${fixed.length} self-healed)`) : "")
			: red(`${healthy}/${checks.length} healthy, ${bad} problem${bad > 1 ? "s" : ""}`) + yellow(bad > 0 ? " — run `rein doctor --fix` to auto-repair" : "");
		console.log(line);
	}

	return result;
}

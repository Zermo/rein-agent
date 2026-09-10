/** Operator-invoked setup; no discovery or model calls happen just by reading it. */
import { resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig, saveConfig } from "../../ai/config.ts";
import { apiKeyFor, discoverServers } from "../../ai/models.ts";
import { detectEndpoint, PROVIDER_PRESETS } from "../../ai/endpoints.ts";
import { ITEMS, PACKS, createOperatorProfile, readOperatorProfile, operatorFilesFingerprint, saveOperatorProfile } from "../operator-profile.ts";
import type { PackId } from "../operator-profile.ts";
import { resolveRunBudgets } from "../run-budgets.ts";

function checkHome(home: string) {
  if (resolve(home) !== resolve(process.env.REIN_HOME || join(homedir(), ".rein"))) throw new Error("Setup must use the connected gateway's configuration directory.");
}
export function readKlaudSetup(home: string) {
  checkHome(home);
  const config = readConfig(), saved = readOperatorProfile(home);
  let budgets, budgetsNeedReview = false;
  try { budgets = resolveRunBudgets(config); } catch { budgets = resolveRunBudgets(); budgetsNeedReview = true; }
  return { budgets, budgetsNeedReview, items: ITEMS, packs: PACKS,
    profile: saved.profile ?? null, profileNeedsReview: !!saved.diagnostic,
    fingerprint: operatorFilesFingerprint(home),
    providers: Object.entries(PROVIDER_PRESETS).map(([id, preset]) => ({ id, baseUrl: preset.baseUrl })) };
}
export function saveKlaudSetup(input: Record<string, unknown>, home: string) {
  checkHome(home);
  if (Object.keys(input).some(key => !["budgets", "answers", "enabledPack", "fingerprint"].includes(key))) throw new Error("Unknown setup field.");
  const config = readConfig();
  const budgets = input.budgets;
  if (budgets !== undefined && (!budgets || typeof budgets !== "object" || Array.isArray(budgets) || Object.keys(budgets).some(key => !["maxTurns", "maxIterations"].includes(key)))) throw new Error("Use maxTurns and maxIterations for task limits.");
  const nextBudgets = resolveRunBudgets(config, budgets as { maxTurns?: unknown; maxIterations?: unknown } | undefined);
  if (input.answers !== undefined) {
    if (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers) || typeof input.fingerprint !== "string") throw new Error("Review the work-style choices before saving.");
    const profile = createOperatorProfile(input.answers as Record<string, string>, (input.enabledPack ?? null) as PackId | null);
    saveOperatorProfile(profile, { home, expectedFingerprint: input.fingerprint });
  }
  if (budgets !== undefined) saveConfig({ ...config, ...nextBudgets });
  return readKlaudSetup(home);
}
export async function probeKlaudModel(home: string) {
  checkHome(home);
  const config = readConfig(), auth = config.auth as { type?: string } | undefined;
  if (auth?.type === "cli") return { status: "cli", models: [], message: "Subscription access is managed by the official CLI. Check its sign-in status below." };
  const provider = typeof config.provider === "string" ? config.provider : "custom";
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : PROVIDER_PRESETS[provider]?.baseUrl;
  if (!baseUrl) throw new Error("Save a model connection before checking it.");
  const result = await detectEndpoint(baseUrl, { provider, apiKey: apiKeyFor(provider, baseUrl, config.sshHost as string | undefined), sshHost: config.sshHost as string | undefined, timeoutMs: 8000 });
  return { status: result.status, models: result.models, baseUrl: result.baseUrl,
    selectedModelAvailable: typeof config.model === "string" && result.models.includes(config.model),
    message: result.status === "ready" ? "The server returned a model list. Your first message will check generation." : result.error ?? "The server did not return a usable model list." };
}
export async function discoverKlaudModels(input: Record<string, unknown>) {
  if (Object.keys(input).some(key => key !== "network") || input.network !== undefined && typeof input.network !== "boolean") throw new Error("Choose whether to include known network peers.");
  const report = await discoverServers({ network: input.network === true, budgetMs: 8000, timeoutMs: 1500, maxCandidates: 40 });
  return { servers: report.servers.map(({ sshHost, ...server }) => ({ ...server, savedConnection: !!sshHost && server.source === "configured" })), scanned: report.scanned, timedOut: report.timedOut, truncated: report.truncated, sources: report.sources };
}

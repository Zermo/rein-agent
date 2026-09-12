// Mastra Factory provisioning. The generated project is user state: it is
// created once from the bundled template, never overwritten, and only the
// missing .env is filled in afterwards. Keep this module Electron-free so the
// test suite runs under plain Node.
import { cpSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const PROJECT_DIR_NAME = "rein-factory";
export const TEMPLATE_REQUIRED_FILES = ["package.json", "src/mastra/index.ts", ".env.schema", "pnpm-workspace.yaml"];

export function resolveProjectDir({ env = process.env, userHome = "" } = {}) {
  const explicit = env.FACTORY_PROJECT?.trim();
  if (explicit) return explicit;
  if (!userHome) throw new Error("Missing user home for the Mastra Factory project directory.");
  return join(userHome, ".local", "share", PROJECT_DIR_NAME);
}

export function resolveTemplateDir({ appDirectory, packaged = false, resourcesPath = "" } = {}) {
  if (packaged) {
    if (!resourcesPath) throw new Error("Missing packaged resources path for the Mastra Factory template.");
    return join(resourcesPath, "factory-template");
  }
  return join(appDirectory, "..", "..", "vendor", "mastra-factory");
}

export function newCredentialKey() {
  return randomBytes(32).toString("base64");
}

export function validateCredentialKey(encoded) {
  const key = Buffer.from(String(encoded).trim(), "base64");
  if (key.byteLength !== 32) throw new Error("FACTORY_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

export function defaultEnvFile(options = {}) {
  const key = options.credentialKey ?? newCredentialKey();
  validateCredentialKey(key);
  const lines = [
    "# Mastra Factory environment for this Dareecho machine.",
    "# Written once by the Mastra Factory app; user state, never rewritten.",
    "# Feature settings and their defaults: .env.schema.",
    "",
    "# Local sandbox: the agents' git and build tools run on this machine.",
    "FACTORY_SANDBOX_PROVIDER=local",
    "# Single-operator machine: no external sign-in provider.",
    "MASTRACODE_AUTH_DISABLED=1",
    "# No platform telemetry from a self-hosted machine.",
    "MASTRACODE_TELEMETRY_DISABLED=1",
    "",
    "# Stored-credential encryption (model-provider keys, integration secrets).",
    `FACTORY_CREDENTIAL_ENCRYPTION_KEY=${key}`,
  ];
  if (options.databaseUrl?.trim()) {
    lines.push("", "# Postgres + pgvector (Dareecho-managed).", `DATABASE_URL=${options.databaseUrl.trim()}`);
  } else {
    lines.push("", "# No DATABASE_URL: single-machine libSQL storage, full app surface.");
  }
  return lines.join("\n") + "\n";
}

export function templateComplete(templateDir) {
  if (!templateDir || !existsSync(templateDir)) return false;
  return TEMPLATE_REQUIRED_FILES.every(file => existsSync(join(templateDir, file)));
}

export function inspectProject({ projectDir, templateDir }) {
  if (!existsSync(projectDir) || !lstatSync(projectDir).isDirectory()) {
    return { exists: false, complete: false, installed: false, ready: false, templateOk: templateComplete(templateDir) };
  }
  const complete = TEMPLATE_REQUIRED_FILES.every(file => existsSync(join(projectDir, file)));
  return {
    exists: true,
    complete,
    installed: existsSync(join(projectDir, "node_modules")),
    ready: complete && existsSync(join(projectDir, "node_modules")) && existsSync(join(projectDir, ".env")),
    templateOk: templateComplete(templateDir),
  };
}

export function provisionProject({ projectDir, templateDir, credentialKey, databaseUrl, log = () => {} }) {
  if (existsSync(projectDir)) {
    if (!lstatSync(projectDir).isDirectory()) throw new Error("The Mastra Factory project path already exists and is not a directory. Refusing to overwrite.");
    if (!existsSync(join(projectDir, ".env"))) {
      writeFileSync(join(projectDir, ".env"), defaultEnvFile({ credentialKey: credentialKey ?? newCredentialKey(), databaseUrl }), { mode: 0o600 });
      log("Wrote the missing .env for the existing Mastra Factory project.");
    }
    return { created: false };
  }
  if (!templateComplete(templateDir)) throw new Error("The bundled Mastra Factory template is missing files. Reinstall the app.");
  mkdirSync(projectDir, { recursive: true });
  cpSync(templateDir, projectDir, { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(projectDir, ".env"), defaultEnvFile({ credentialKey: credentialKey ?? newCredentialKey(), databaseUrl }), { mode: 0o600 });
  log(`Installed Mastra Factory to ${projectDir}.`);
  return { created: true };
}

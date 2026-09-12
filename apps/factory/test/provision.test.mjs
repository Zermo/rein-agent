import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySecurityOverrides, defaultEnvFile, inspectProject, newCredentialKey, provisionProject, resolveProjectDir, resolveTemplateDir, SECURITY_OVERRIDES, templateComplete, validateCredentialKey } from "../provision.mjs";

const root = mkdtempSync(join(tmpdir(), "factory-provision-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

function fixtureTemplate(name = "template") {
  const dir = join(root, name);
  mkdirSync(join(dir, "src", "mastra"), { recursive: true });
  for (const [file, content] of [
    ["package.json", "{\"name\":\"mastra-factory\"}"],
    ["src/mastra/index.ts", "export const factory = {};\n"],
    [".env.schema", "FACTORY_SANDBOX_PROVIDER=\n"],
    ["pnpm-workspace.yaml", "minimumReleaseAgeExclude: []\n"],
  ]) writeFileSync(join(dir, file), content);
  return dir;
}

test("credential key is 32 random base64 bytes", () => {
  const key = newCredentialKey();
  assert.equal(validateCredentialKey(key).byteLength, 32);
  assert.notEqual(key, newCredentialKey());
  assert.throws(() => validateCredentialKey("aGVsbG8="), /32-byte/);
});

test("default env file wires the single-operator Dareecho machine", () => {
  const key = newCredentialKey();
  const text = defaultEnvFile({ credentialKey: key, databaseUrl: "" });
  assert.match(text, /FACTORY_SANDBOX_PROVIDER=local/);
  assert.match(text, /MASTRACODE_AUTH_DISABLED=1/);
  assert.match(text, /MASTRACODE_TELEMETRY_DISABLED=1/);
  assert.ok(text.includes(`FACTORY_CREDENTIAL_ENCRYPTION_KEY=${key}\n`), "the generated key must be written verbatim");
  assert.doesNotMatch(text, /DATABASE_URL=/);
  const withDb = defaultEnvFile({ credentialKey: key, databaseUrl: "postgres://user:pass@127.0.0.1:5432/factory" });
  assert.match(withDb, /DATABASE_URL=postgres:\/\/user:pass@127\.0\.0\.1:5432\/factory/m);
});

test("project dir resolution honors FACTORY_PROJECT, then the user share dir", () => {
  assert.equal(resolveProjectDir({ env: { FACTORY_PROJECT: "/tmp/x" }, userHome: "/home/u" }), "/tmp/x");
  assert.equal(resolveProjectDir({ env: {}, userHome: "/home/u" }), "/home/u/.local/share/rein-factory");
  assert.throws(() => resolveProjectDir({ env: {}, userHome: "" }), /user home/);
});

test("template dir resolution: dev uses the vendored copy, packaged uses resources", () => {
  assert.equal(resolveTemplateDir({ appDirectory: "/app/factory", packaged: false }), "/vendor/mastra-factory");
  assert.equal(resolveTemplateDir({ appDirectory: "/app/factory", packaged: true, resourcesPath: "/app/resources" }), "/app/resources/factory-template");
  assert.throws(() => resolveTemplateDir({ appDirectory: "/app/factory", packaged: true, resourcesPath: "" }), /resources/);
});

test("provisioning installs the template once with a private .env", () => {
  const template = fixtureTemplate();
  const project = join(root, "project-1");
  assert.equal(templateComplete(template), true);
  const result = provisionProject({ projectDir: project, templateDir: template });
  assert.equal(result.created, true);
  assert.equal(existsSync(join(project, "src/mastra/index.ts")), true);
  const envStat = statSync(join(project, ".env"));
  assert.equal(envStat.mode & 0o777, 0o600);
  assert.match(readFileSync(join(project, ".env"), "utf8"), /FACTORY_CREDENTIAL_ENCRYPTION_KEY=/);
  // Re-running against an existing project never overwrites it.
  writeFileSync(join(project, "marker.txt"), "user state");
  const again = provisionProject({ projectDir: project, templateDir: template });
  assert.equal(again.created, false);
  assert.equal(readFileSync(join(project, "marker.txt"), "utf8"), "user state");
});

test("provisioning refuses to replace a non-directory at the project path", () => {
  const template = fixtureTemplate("template-2");
  const project = join(root, "project-file");
  writeFileSync(project, "not a directory");
  assert.throws(() => provisionProject({ projectDir: project, templateDir: template }), /not a directory/);
});

test("inspection reports readiness for install and start decisions", () => {
  const template = fixtureTemplate("template-3");
  const project = join(root, "project-3");
  assert.deepEqual(inspectProject({ projectDir: project, templateDir: template }).ready, false);
  provisionProject({ projectDir: project, templateDir: template });
  const before = inspectProject({ projectDir: project, templateDir: template });
  assert.equal(before.installed, false);
  mkdirSync(join(project, "node_modules"), { recursive: true });
  const after = inspectProject({ projectDir: project, templateDir: template });
  assert.equal(after.ready, true);
});

test("the vendored template in the Dareecho tree is complete", () => {
  assert.equal(templateComplete(new URL("../../../vendor/mastra-factory", import.meta.url).pathname), true);
});

test("security overrides pin the vulnerable roots to their first patched release", () => {
  assert.deepEqual(SECURITY_OVERRIDES, { undici: "6.28.1", lodash: "4.18.1", "adm-zip": "0.6.1", "smol-toml": "1.8.0" });
});

test("applySecurityOverrides writes the pins and is idempotent", () => {
  const project = join(root, "override-1");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "mastra-factory" }, null, 2) + "\n");
  applySecurityOverrides(project);
  const once = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  assert.deepEqual(once.overrides, SECURITY_OVERRIDES);
  const before = readFileSync(join(project, "package.json"), "utf8");
  applySecurityOverrides(project);
  assert.equal(readFileSync(join(project, "package.json"), "utf8"), before, "a second run must not rewrite the file");
});

test("applySecurityOverrides preserves a project's own override for the same package", () => {
  const project = join(root, "override-2");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "mastra-factory", overrides: { lodash: "4.19.9" } }, null, 2) + "\n");
  applySecurityOverrides(project);
  const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  assert.equal(manifest.overrides.lodash, "4.19.9", "the project's own choice wins");
  assert.equal(manifest.overrides.undici, "6.28.1", "the other pins are still applied");
});

test("provisioning applies the security overrides on both fresh and existing projects", () => {
  const template = fixtureTemplate("template-ov");
  const fresh = join(root, "project-fresh-ov");
  provisionProject({ projectDir: fresh, templateDir: template });
  const freshManifest = JSON.parse(readFileSync(join(fresh, "package.json"), "utf8"));
  assert.deepEqual(freshManifest.overrides, SECURITY_OVERRIDES);
  const existing = join(root, "project-existing-ov");
  provisionProject({ projectDir: existing, templateDir: template });
  writeFileSync(join(existing, "package.json"), JSON.stringify({ name: "mastra-factory" }, null, 2) + "\n");
  const again = provisionProject({ projectDir: existing, templateDir: template });
  assert.equal(again.created, false);
  const existingManifest = JSON.parse(readFileSync(join(existing, "package.json"), "utf8"));
  assert.deepEqual(existingManifest.overrides, SECURITY_OVERRIDES);
});

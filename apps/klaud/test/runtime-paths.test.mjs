import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localRuntimeEnvironment, prepareLocalRuntime } from "../runtime-paths.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rein-app-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resourcesPath = join(root, "rein-klaud.app/Contents/Resources");
  mkdirSync(join(resourcesPath, "rein/dist"), { recursive: true });
  writeFileSync(join(resourcesPath, "rein/dist/rein.js"), "// bundle fixture\n");
  const userHome = join(root, "user");
  mkdirSync(userHome);
  return { root, packaged: true, resourcesPath, appDirectory: join(resourcesPath, "app"), userHome };
}

test("packaged runtime uses embedded code with a writable user workspace", t => {
  const options = fixture(t);
  const paths = prepareLocalRuntime(options);
  assert.equal(paths.entry, join(options.resourcesPath, "rein/dist/rein.js"));
  assert.equal(paths.home, join(options.userHome, ".rein"));
  assert.equal(paths.cwd, join(paths.home, "workspace"));
  assert.ok(existsSync(paths.cwd));
  assert.ok(!existsSync(join(options.resourcesPath, "rein/workspace")));
});

test("packaged runtime preserves a custom Rein home and its existing files", t => {
  const options = fixture(t), reinHome = join(options.userHome, "custom");
  mkdirSync(reinHome);
  writeFileSync(join(reinHome, "config.json"), '{"keep":true}');
  const paths = prepareLocalRuntime({ ...options, reinHome });
  assert.equal(paths.cwd, join(reinHome, "workspace"));
  assert.ok(existsSync(join(reinHome, "config.json")));
});

test("packaged runtime refuses writable directories inside an app, including symlinks", t => {
  const options = fixture(t);
  assert.throws(() => prepareLocalRuntime({ ...options, reinHome: join(options.resourcesPath, "state") }), /outside an app bundle/);
  const linked = join(options.userHome, "linked");
  symlinkSync(options.resourcesPath, linked);
  assert.throws(() => prepareLocalRuntime({ ...options, reinHome: join(linked, "new-state") }), /outside an app bundle/);
  assert.ok(!existsSync(join(options.resourcesPath, "new-state")));
  const spacedBundle = join(options.root, "My Rein.app/Contents/Resources");
  mkdirSync(spacedBundle, { recursive: true });
  assert.throws(() => prepareLocalRuntime({ ...options, reinHome: join(spacedBundle, "state") }), /outside an app bundle/);
  const spacedLink = join(options.userHome, "linked-spaced");
  symlinkSync(spacedBundle, spacedLink);
  assert.throws(() => prepareLocalRuntime({ ...options, reinHome: join(spacedLink, "new-state") }), /outside an app bundle/);
  assert.ok(!existsSync(join(spacedBundle, "new-state")));
});

test("packaged runtime cannot silently fall back to a checkout when its bundle is missing", t => {
  const options = fixture(t);
  rmSync(join(options.resourcesPath, "rein/dist/rein.js"));
  assert.throws(() => prepareLocalRuntime(options), /missing its Rein runtime/);
});

test("source development keeps its repository cwd and supports bundle or source entry", t => {
  const options = fixture(t), sourceRoot = join(options.root, "checkout");
  const appDirectory = join(sourceRoot, "apps/klaud");
  mkdirSync(join(sourceRoot, "bin"), { recursive: true });
  writeFileSync(join(sourceRoot, "bin/rein.js"), "// source fixture\n");
  const source = prepareLocalRuntime({ ...options, packaged: false, appDirectory });
  assert.equal(source.cwd, sourceRoot);
  assert.equal(source.entry, join(sourceRoot, "bin/rein.js"));
  mkdirSync(join(sourceRoot, "dist"));
  writeFileSync(join(sourceRoot, "dist/rein.js"), "// bundle fixture\n");
  assert.equal(prepareLocalRuntime({ ...options, packaged: false, appDirectory }).entry, join(sourceRoot, "dist/rein.js"));
  assert.ok(!existsSync(source.home));
});

test("Finder launch finds normal CLI installs while preserving configured PATH precedence", () => {
  const environment = { PATH: "/custom/bin:/usr/bin:/custom/bin:.:", KEEP: "preserved" };
  const env = localRuntimeEnvironment({ packaged: true, environment, home: "/home/operator/.rein", userHome: "/home/operator" });
  assert.equal(env.KEEP, "preserved");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.REIN_HOME, "/home/operator/.rein");
  assert.ok(env.PATH.startsWith("/custom/bin:/usr/bin:"));
  assert.ok(env.PATH.split(":").includes("/home/operator/.local/bin"));
  assert.ok(env.PATH.split(":").includes("/opt/homebrew/bin"));
  assert.ok(env.PATH.split(":").every(path => path.startsWith("/")));
  assert.equal(environment.PATH, "/custom/bin:/usr/bin:/custom/bin:.:");
  assert.equal(localRuntimeEnvironment({ packaged: false, environment, home: "/home/operator/.rein" }).PATH, environment.PATH);
});

test("an assisted development launch uses its new home workspace without writing into the checkout", t => {
  const options = fixture(t), sourceRoot = join(options.root, "checkout"), appDirectory = join(sourceRoot, "apps/klaud");
  mkdirSync(join(sourceRoot, "dist"), { recursive: true });
  writeFileSync(join(sourceRoot, "dist/rein.js"), "// bundle fixture\n");
  const reinHome = join(options.userHome, ".klaudbot");
  const runtime = prepareLocalRuntime({ ...options, packaged: false, isolated: true, appDirectory, reinHome });
  assert.equal(runtime.entry, join(sourceRoot, "dist/rein.js"));
  assert.equal(runtime.cwd, join(reinHome, "workspace"));
  assert.ok(existsSync(runtime.cwd));
  assert.ok(!existsSync(join(sourceRoot, "workspace")));
});

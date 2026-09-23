import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

function outsideAppBundle(path) {
  if (/(?:^|\/)[^/]*\.app(?:\/|$)/i.test(path)) throw new Error("Rein's writable workspace must be outside an app bundle.");
  let ancestor = path;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  if (/(?:^|\/)[^/]*\.app(?:\/|$)/i.test(realpathSync(ancestor))) throw new Error("Rein's writable workspace must be outside an app bundle.");
}

/** The installed app contains immutable code; all server writes belong to the user. */
export function prepareLocalRuntime({ packaged, appDirectory, resourcesPath, userHome, reinHome, isolated = false }) {
  const root = packaged ? join(resourcesPath, "rein") : resolve(appDirectory, "../..");
  const bundled = join(root, "dist/rein.js");
  const entry = !packaged && !existsSync(bundled) ? join(root, "bin/rein.js") : bundled;
  if (!existsSync(entry)) throw new Error(packaged ? "The app is missing its Rein runtime. Reinstall klaʊdbot." : "I couldn't find Rein. Run this app from the Rein checkout.");
  const home = resolve(reinHome || join(userHome, ".rein"));
  const cwd = packaged || isolated ? join(home, "workspace") : root;
  if (packaged || isolated) {
    outsideAppBundle(home);
    outsideAppBundle(cwd);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    outsideAppBundle(cwd);
  }
  return { root, entry, home, cwd };
}

export function localRuntimeEnvironment({ packaged, environment, home, userHome }) {
  const env = { ...environment, REIN_HOME: home, ELECTRON_RUN_AS_NODE: "1" };
  if (packaged) {
    // Finder doesn't source shell profiles. Preserve configured precedence, then
    // make normal user/Homebrew CLI installs available without running a shell.
    const paths = [...(env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin").split(":"), join(userHome, ".local/bin"), join(userHome, ".npm-global/bin"), join(userHome, ".bun/bin"), join(userHome, ".volta/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
    env.PATH = [...new Set(paths.filter(path => isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path)))].join(":");
  }
  return env;
}

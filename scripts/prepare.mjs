// npm lifecycle hook: runs on git install, npm publish, and local npm install.
// Rebuilds dist/rein.js when esbuild is available; otherwise keeps the
// committed build, so the package installs even without devDependencies.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const committed = existsSync(join(root, "dist", "rein.js"));
try {
	await import("./build.mjs");
} catch (err) {
	if (committed) console.warn(`[rein-agent] using committed dist/rein.js (${err.message})`);
	else throw err;
}

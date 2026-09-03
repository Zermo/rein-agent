// Rebuilds dist/rein.js (the committed build is the fallback for installs
// where esbuild can't run). Run manually: node scripts/build.mjs
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

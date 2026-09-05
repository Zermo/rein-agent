// Bundle the CLI and its isolated Meat worker into dependency-free ESM files.
// Node refuses to type-strip .ts files under node_modules, so the installed
// package ships plain JS. Run with `npm run bundle` after source changes;
// the built file is committed so installs never need to rebuild.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await build({
	entryPoints: { rein: join(root, "bin", "rein.js"), "meat-worker": join(root, "src/harness/meat/worker.ts") },
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node18",
	outdir: join(root, "dist"),
	logLevel: "warning",
});
console.log("built dist/rein.js and dist/meat-worker.js");

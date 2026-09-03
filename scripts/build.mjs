// Bundle the CLI into a single dependency-free ESM file: dist/rein.js.
// Node refuses to type-strip .ts files under node_modules, so the installed
// package ships plain JS. Run with `npm run bundle` after source changes;
// the built file is committed so installs never need to rebuild.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const result = await build({
	entryPoints: [join(root, "bin", "rein.js")],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node18",
	outfile: join(root, "dist", "rein.js"),
	logLevel: "warning",
});
if (result.errors > 0) process.exit(1);
console.log("built dist/rein.js");

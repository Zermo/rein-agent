import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL(".", import.meta.url)));
await mkdir("dist", { recursive: true });
await build({ entryPoints: ["renderer.jsx"], bundle: true, outfile: "dist/renderer.js", platform: "browser", format: "esm", target: "chrome144", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
await Promise.all(["index.html", "styles.css", "icon.svg"].map(file => copyFile(file, `dist/${file}`)));

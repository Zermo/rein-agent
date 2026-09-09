import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL(".", import.meta.url)));
await mkdir("dist", { recursive: true });
await build({ entryPoints: ["renderer.jsx"], bundle: true, outfile: "dist/renderer.js", platform: "browser", format: "esm", target: "chrome144", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
const staticFiles = [
  ["index.html", "index.html"],
  ["styles.css", "styles.css"],
  ["avatars.css", "avatars.css"],
  ["setup.css", "setup.css"],
  ["../../tokens.css", "tokens.css"],
  ["icon.svg", "icon.svg"],
  ["icon.png", "icon.png"],
  ["tray-ready.png", "tray-ready.png"],
  ["tray-ready@2x.png", "tray-ready@2x.png"],
  ["tray-working.png", "tray-working.png"],
  ["tray-working@2x.png", "tray-working@2x.png"],
  ["tray-readyTemplate.png", "tray-readyTemplate.png"],
  ["tray-readyTemplate@2x.png", "tray-readyTemplate@2x.png"],
  ["tray-workingTemplate.png", "tray-workingTemplate.png"],
  ["tray-workingTemplate@2x.png", "tray-workingTemplate@2x.png"],
  ["../../docs/assets/rein-logo.svg", "rein-logo.svg"],
  ["../../docs/assets/rein-field-guide-card.jpg", "rein-field-guide-card.jpg"],
];
await Promise.all(staticFiles.map(([source, target]) => copyFile(source, `dist/${target}`)));

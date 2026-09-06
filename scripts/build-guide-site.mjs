// Stage the public field guide without publishing the rest of docs/.
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const docs = fileURLToPath(new URL("../docs/", import.meta.url));
const required = [
	"install.html",
	"assets/rein-logo.png",
	"assets/rein-repo-card.png",
	"assets/rein-field-guide-card.png",
	"assets/rein-repo-card.jpg",
	"assets/rein-field-guide-card.jpg",
	"assets/rein-logo.svg",
	"assets/rein-icon.svg",
];

try {
	if (process.argv.length > 3) {
		throw new Error("Usage: node scripts/build-guide-site.mjs [empty-output-directory]");
	}
	for (const file of required) {
		const info = await lstat(join(docs, file)).catch(() => null);
		if (!info?.isFile() || info.size === 0) {
			throw new Error(`Required guide file is missing or empty: docs/${file}`);
		}
	}

	const output = process.argv[2]
		? resolve(process.argv[2])
		: await mkdtemp(join(tmpdir(), "rein-guide-site-"));
	if (output === resolve(docs) || output.startsWith(resolve(docs) + sep)) {
		throw new Error("Choose an output directory outside docs/.");
	}
	await mkdir(output, { recursive: true });
	if ((await readdir(output)).length !== 0) {
		throw new Error(`Output directory must be empty: ${output}`);
	}

	await copyFile(join(docs, "install.html"), join(output, "index.html"));
	await copyFile(join(docs, "install.html"), join(output, "install.html"));
	await cp(join(docs, "assets"), join(output, "assets"), {
		recursive: true,
		filter: async (source) => {
			if ((await lstat(source)).isSymbolicLink()) {
				throw new Error(`Guide assets must be regular files, found symlink: ${source}`);
			}
			return true;
		},
	});
	await writeFile(join(output, ".nojekyll"), "");
	console.log(`Built public guide at ${output}`);
} catch (error) {
	console.error(`Guide build failed: ${error.message}`);
	process.exitCode = 1;
}

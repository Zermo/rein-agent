/** Product selection shares one harness and private home; it never replaces the host OS. */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSetupPrompt, type SetupPrompt } from "./setup.ts";
import { preferSurface } from "./desktop/surface.ts";
import { runDesktopChild } from "./desktop/cli.ts";

export type InstallEdition = "gateway" | "cloud" | "os";
export const EDITIONS: Record<InstallEdition, { name: string; description: string }> = {
	gateway: { name: "Rein Agent", description: "Terminal harness / gateway. Keep your current OS and desktop. Start the local API when needed with rein serve." },
	cloud: { name: "Rein Cloud", description: "Install the bot app alongside Rein Agent. Use its local gateway for bots and chat. Background follow-ups use the separate autonomy service you choose during setup." },
	os: { name: "Dareecho — OS development", description: "Assess this machine and model fit, then prepare an Omarchy VM overlay. A bootable OS and physical-machine migration are not available yet." },
};
interface Installation { schemaVersion: 1; edition: InstallEdition }
const privateHome = () => resolve(process.env.REIN_HOME || join(homedir(), ".rein"));
export function parseEdition(value: unknown): InstallEdition {
	if (value !== "gateway" && value !== "cloud" && value !== "os") throw new Error("--edition must be gateway, cloud, or os.");
	return value;
}
export function readInstallation(home = privateHome()): Installation | undefined {
	const file = join(home, "installation.json"), stat = lstatSync(file, { throwIfNoEntry: false });
	if (!stat) return;
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new Error("Installation preferences must be a small ordinary file. Existing data was preserved.");
	try {
		const value = JSON.parse(readFileSync(file, "utf8"));
		if (value?.schemaVersion === 1 && Object.keys(value).length === 2) return { schemaVersion: 1, edition: parseEdition(value.edition) };
	} catch { /* Do not print content from private files. */ }
	throw new Error("Invalid installation preferences. Repair installation.json before changing editions; existing data was preserved.");
}
function saveInstallation(edition: InstallEdition, home: string): void {
	readInstallation(home);
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const file = join(home, "installation.json"), temporary = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, edition }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		renameSync(temporary, file);
	} finally { try { unlinkSync(temporary); } catch {} }
}
function bundleRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const roots = [resolve(here, "../.."), resolve(here, "..")];
	const root = roots.find(root => existsSync(join(root, "scripts/install-macos-app.sh")) && existsSync(join(root, "apps/klaud/package.json")));
	if (!root) throw new Error("This installation is missing its app payload. Update Rein and retry: rein setup edition --edition cloud --yes");
	return root;
}
async function run(command: string, args: string[], cwd: string): Promise<void> {
	const code = await runDesktopChild(command, args, cwd, { ...process.env }, { ignoreInput: true, timeoutMs: 15 * 60_000 });
	if (code !== 0) throw new Error(`App installation ${code === 124 ? "timed out" : [129, 130, 143].includes(code) ? "was cancelled" : `exited ${code}`}. Retry: rein setup edition --edition cloud --yes`);
}
export async function installCloudApp(): Promise<void> {
	const root = bundleRoot();
	if (process.platform === "darwin") {
		await run("bash", [join(root, "scripts/install-macos-app.sh"), "--no-launch"], root);
	} else if (process.platform === "linux") {
		const app = join(root, "apps/klaud");
		await run("npm", ["ci", "--no-audit", "--no-fund"], app);
		await run(process.execPath, [join(app, "build.mjs")], app);
	} else throw new Error("The bot app installer currently supports macOS and Linux desktops. On Windows use the terminal harness inside WSL; desktop integration is not yet packaged for Windows.");
}
async function assessOS(log: (text: string) => void): Promise<void> {
	const { profileHardware } = await import("../hardware/profile.ts");
	const { servingRecommendations, probeServingTools } = await import("../hardware/recipes.ts");
	const { hardwareReportLines } = await import("../hardware/report.ts");
	const { planReinOS, formatReinOSPlan } = await import("../os/plan.ts");
	const hardware = await profileHardware();
	log(hardwareReportLines(hardware, servingRecommendations(hardware), await probeServingTools()).join("\n"));
	log(formatReinOSPlan(planReinOS(hardware, { mode: "image" })));
	log("Assessment complete. Your installed OS is unchanged. To stage the development kit in a new directory: rein os prepare --output ./dareecho-kit");
}
interface EditionDependencies {
	prompt?: SetupPrompt;
	log?: (text: string) => void;
	home?: string;
	installCloud?: () => Promise<void>;
	assessOS?: (log: (text: string) => void) => Promise<void>;
}
export async function runEditionSetup(options: { edition?: InstallEdition; yes?: boolean } = {}, deps: EditionDependencies = {}): Promise<InstallEdition> {
	const home = deps.home ?? privateHome(), current = readInstallation(home), log = deps.log ?? console.log;
	let edition = options.edition === undefined ? undefined : parseEdition(options.edition);
	if (!edition && options.yes) edition = current?.edition ?? "gateway";
	if (!edition) {
		if (!deps.prompt && !process.stdin.isTTY) throw new Error("Choose in a terminal with rein setup edition, or pass --edition gateway|cloud|os --yes.");
		const prompt = deps.prompt ?? createSetupPrompt();
		try {
			log("\nChoose how Rein lives on this machine. All three paths use Rein Agent and the same private profile, accounts, and sessions.");
			const editions = Object.keys(EDITIONS) as InstallEdition[];
			editions.forEach((id, index) => log(`  ${index + 1}. ${EDITIONS[id].name}\n     ${EDITIONS[id].description}`));
			const fallback = String(editions.indexOf(current?.edition ?? "gateway") + 1);
			for (;;) {
				const choice = Number(await prompt.ask(`Installation [${fallback}]: `, fallback));
				if (Number.isInteger(choice) && choice >= 1 && choice <= editions.length) { edition = editions[choice - 1]; break; }
				log("Enter 1, 2, or 3.");
			}
		} finally { if (!deps.prompt) prompt.close(); }
	}
	log(`\n${EDITIONS[edition].name}: ${EDITIONS[edition].description}`);
	// Persist only a completed selection. A failed app install keeps the prior choice.
	if (edition === "cloud") {
		log("Installing the app now. This does not start a gateway, enroll folders, download models, or enable a background service.");
		await (deps.installCloud ?? installCloudApp)();
	} else if (edition === "os") await (deps.assessOS ?? assessOS)(log);
	saveInstallation(edition, home);
	preferSurface(edition === "cloud" ? "klaud" : "terminal", home);
	log(edition === "cloud" ? "App installed. Run rein desktop open to start bots and chat with this harness. The interactive gateway runs while that app session is open; separately enabled autonomy continues on its own." : edition === "gateway" ? "Rein is ready in your terminal. Run rein serve for a loopback gateway. Background follow-ups remain controlled by rein autonomy." : "Dareecho development selected. Model downloads, services, and VM installation each remain separate explicit steps.");
	return edition;
}
export async function editionCommand(flags: Record<string, string | boolean>): Promise<void> {
	if (Object.keys(flags).some(key => !["edition", "yes", "status", "id"].includes(key))) throw new Error("Usage: rein setup edition [--edition gateway|cloud|os --yes] | --status [--id]");
	for (const key of ["yes", "status", "id"]) if (flags[key] !== undefined && typeof flags[key] !== "boolean") throw new Error(`--${key} expects a boolean.`);
	if (flags.status || flags.id) {
		if (flags.edition !== undefined || flags.yes) throw new Error("Status cannot be combined with edition changes.");
		const current = readInstallation();
		console.log(flags.id ? current?.edition ?? "gateway" : current ? `Selected: ${EDITIONS[current.edition].name}\n${EDITIONS[current.edition].description}\nChange: rein setup edition` : "Rein Agent is installed. No edition has been selected yet. Run rein setup edition.");
		return;
	}
	await runEditionSetup({ edition: flags.edition === undefined ? undefined : parseEdition(flags.edition), yes: flags.yes === true });
}

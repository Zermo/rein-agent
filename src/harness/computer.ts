/** A bot computer is a private directory. It is not the operator's machine. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const BOT_ID = /^klaud-bot-[0-9a-f]{8}$/;

export function computerHome(home?: string): string {
	return join(resolve(home ?? process.env.REIN_HOME ?? join(homedir(), ".rein")), "computers");
}

export function botComputer(id: string, home?: string): string {
	if (!BOT_ID.test(id)) throw new Error("Invalid bot id.");
	const root = join(computerHome(home), id);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const desk = join(root, "DESKTOP.md");
	if (!existsSync(desk)) {
		writeFileSync(desk, "This computer belongs to this unit only.\nIt is not the operator's machine.\nOther units do not share it.\n", { mode: 0o600 });
	}
	return root;
}

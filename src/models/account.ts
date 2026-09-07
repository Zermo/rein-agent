/** Reuse Hugging Face credentials without copying them into Rein settings. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ModelAccount { source: "environment" | "hf-cache" | "none"; token?: string }
function tokenValue(value: string): string {
	const token = value.trim();
	if (!token || token.length > 4096 || /\s|[\x00-\x1f\x7f]/.test(token)) throw new Error("Invalid Hugging Face token. Replace the credential through hf auth login or HF_TOKEN.");
	return token;
}

export async function modelAccount(env: NodeJS.ProcessEnv = process.env): Promise<ModelAccount> {
	if (env.HF_TOKEN?.trim()) return { source: "environment", token: tokenValue(env.HF_TOKEN) };
	const home = env.HF_HOME || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "huggingface");
	const path = resolve(env.HF_TOKEN_PATH || join(home, "token"));
	let file;
	try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { source: "none" };
		throw new Error("Cannot read the Hugging Face credential file. Check HF_TOKEN_PATH or use HF_TOKEN.");
	}
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > 4096) throw new Error("Hugging Face credential file must be a small regular file.");
		const buffer = Buffer.alloc(4097);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead > 4096) throw new Error("Hugging Face credential file exceeds its size limit.");
		return { source: "hf-cache", token: tokenValue(buffer.toString("utf8", 0, bytesRead)) };
	} finally { await file.close(); }
}

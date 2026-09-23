/** Digital account labels. Secrets stay out of this index. */
import type { AgentTool } from "../../agent/agent-loop.ts";
import { allowedHttpUrl } from "../net-guard.ts";
import { addAccount, listAccounts } from "../stack.ts";

const BANNED = new Set(["token", "secret", "password", "key", "authorization", "apikey", "api_key", "bearer"]);

const accountsTool: AgentTool = {
	name: "accounts",
	description: "Digital account labels for the person stack: name, kind, host, note. No secrets. Use curl or mcp to call a host. Do not require a client package and do not invent accounts that are not listed.",
	parameters: { type: "object", properties: {
		op: { type: "string", enum: ["list", "add"] },
		name: { type: "string" },
		kind: { type: "string" },
		host: { type: "string" },
		note: { type: "string" },
	}, required: ["op"] },
	executionMode: "sequential",
	async execute(_id, args) {
		try {
			if (Object.keys(args).some(key => BANNED.has(key.toLowerCase()))) {
				return { content: "accounts: secrets are not stored. Pass a token to curl or mcp for one call.", isError: true };
			}
			if (args.op === "list") {
				const rows = listAccounts();
				return { content: rows.length ? JSON.stringify(rows) : "No digital accounts saved. Do not invent one. Add a label with accounts op=add after the person names it." };
			}
			if (args.op !== "add") return { content: "accounts: op must be list or add.", isError: true };
			if (typeof args.name !== "string" || typeof args.kind !== "string" || typeof args.host !== "string") {
				return { content: "accounts: add requires name, kind, and host.", isError: true };
			}
			const host = allowedHttpUrl(args.host, "account host").href;
			const rows = addAccount({ name: args.name, kind: args.kind, host, ...(typeof args.note === "string" ? { note: args.note } : {}) });
			return { content: JSON.stringify(rows) };
		} catch (error) {
			return { content: error instanceof Error ? error.message : String(error), isError: true };
		}
	},
};

export default accountsTool;

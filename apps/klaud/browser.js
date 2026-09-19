/* Browser transport. Electron preload already defines window.klaud; this is a no-op there. */
(() => {
	if (globalThis.klaud) return;
	const TOKEN_KEY = "rein-klaud-bearer";
	const tools = [
		{ name: "patchShell", description: "Change the visible shell and persist it through rein serve.", parameters: { type: "object", properties: { patch: { type: "array" } }, required: ["patch"] } },
		{ name: "setPref", description: "Choose the last opened bot.", parameters: { type: "object", properties: { key: { const: "lastBotId" }, value: { type: "string" } }, required: ["key", "value"] } },
		{ name: "navigateTo", description: "Open bots, chat, or settings.", parameters: { type: "object", properties: { dest: { enum: ["bots", "chat", "settings"] } }, required: ["dest"] } },
		{ name: "confirmAction", description: "Ask the user to explicitly confirm an action.", parameters: { type: "object", properties: { action: { type: "string" }, importance: { enum: ["low", "medium", "high", "critical"] } }, required: ["action"] } },
	];
	const listeners = new Set();
	let sequence = 0, connection, state, activeRun;
	const emit = event => { event.sequence = ++sequence; for (const cb of listeners) cb(event); };
	const originUrl = () => location.origin;
	function currentToken() {
		const hash = location.hash.replace(/^#/, "");
		if (/^[\x21-\x7e]{1,512}$/.test(hash)) {
			sessionStorage.setItem(TOKEN_KEY, hash);
			history.replaceState(null, "", location.pathname + location.search);
			return hash;
		}
		return sessionStorage.getItem(TOKEN_KEY) || "";
	}
	async function http(method, path, body, signal) {
		const token = connection?.token || currentToken();
		if (!token) throw new Error("Enter the bearer token.");
		const response = await fetch(originUrl() + path, {
			method, signal, redirect: "error",
			headers: { Authorization: `Bearer ${token}`, Origin: originUrl(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) {
			await response.body?.cancel?.();
			throw new Error(`rein serve returned HTTP ${response.status}. ${response.status === 401 ? "Check the bearer token." : "The request was rejected."}`);
		}
		return response;
	}
	async function json(method, path, body) {
		return (await http(method, path, body)).json();
	}
	function route(operation, input = {}) {
		if (operation === "state") return { method: "GET", path: "/state" };
		if (operation === "bots") return { method: "GET", path: "/bots" };
		if (operation === "messages") return { method: "GET", path: `/bots/${encodeURIComponent(input.id)}/messages${input.before === undefined ? "" : `?before=${input.before}`}` };
		if (operation === "createBot") return { method: "POST", path: "/bots", body: { name: input.name.trim() } };
		if (operation === "patchShell") return { method: "POST", path: "/state", body: { patch: input.patch } };
		if (operation === "setPref") return { method: "POST", path: "/prefs", body: { key: "lastBotId", value: input.value } };
		throw new Error("Unsupported backend operation.");
	}
	async function connect(options) {
		if (activeRun) throw new Error("Stop the current run before reconnecting.");
		const token = options?.token || currentToken();
		if (typeof token !== "string" || !/^[\x21-\x7e]{1,512}$/.test(token)) throw new Error("Enter a valid bearer token.");
		sessionStorage.setItem(TOKEN_KEY, token);
		connection = { url: originUrl(), token };
		state = await json("GET", "/state");
		return { connected: true, url: connection.url, state, run: null };
	}
	async function status() {
		if (!connection && currentToken()) {
			try { return { ...(await connect({ token: currentToken() })), sequence }; }
			catch (error) { return { connected: false, error: String(error.message || error), sequence }; }
		}
		return { connected: !!connection, url: connection?.url, state, sequence, run: null };
	}
	async function startRun(input) {
		if (activeRun) throw new Error("A run is already active.");
		const run = { id: undefined, botId: input.botId, controller: new AbortController(), pending: new Map() };
		activeRun = run;
		void (async () => {
			try {
				const response = await http("POST", "/run", { threadId: input.threadId, botId: input.botId, message: input.message, tools }, run.controller.signal);
				const reader = response.body.getReader(), decoder = new TextDecoder();
				let buffer = "";
				while (true) {
					const { value, done } = await reader.read();
					buffer = (buffer + decoder.decode(value || new Uint8Array(), { stream: !done })).replace(/\r\n/g, "\n");
					let boundary;
					while ((boundary = buffer.indexOf("\n\n")) >= 0) {
						const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
						const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
						if (data === "[DONE]") { if (done) return; continue; }
						if (!data) continue;
						const event = JSON.parse(data);
						if (event.type === "RUN_STARTED") run.id = event.runId;
						if (event.type === "CUSTOM" && ["klaud.frontend_tool", "klaud.approval"].includes(event.name)) {
							const id = event.value?.toolCallId ?? event.value?.id;
							run.pending.set(id, { ...event.value, kind: event.name, event });
						}
						if (event.type === "TOOL_CALL_RESULT") run.pending.delete(event.toolCallId);
						emit(event);
					}
					if (done) break;
				}
			} catch (error) { emit({ type: "RUN_ERROR", runId: run.id, message: run.controller.signal.aborted ? "Run cancelled." : String(error.message || error) }); }
			finally { if (activeRun === run) activeRun = undefined; emit({ type: "RUN_SETTLED", botId: run.botId }); }
		})();
		return { started: true };
	}
	globalThis.klaud = Object.freeze({
		canStartLocal: false,
		status, connect,
		request: async (operation, input) => {
			const next = route(operation, input);
			const result = await json(next.method, next.path, next.body);
			if (["state", "patchShell", "setPref"].includes(operation)) state = result;
			return result;
		},
		run: startRun,
		cancel: async () => {
			const run = activeRun;
			if (!run) return { cancelled: false };
			try { if (run.id) await json("POST", `/runs/${run.id}/cancel`, {}); }
			finally { run.controller.abort(); }
			return { cancelled: true };
		},
		toolResult: async input => {
			const run = activeRun, pending = run?.pending.get(input?.toolCallId);
			if (!run?.id || input.runId !== run.id || pending?.kind !== "klaud.frontend_tool") throw new Error("No matching pending frontend tool.");
			const result = await json("POST", `/runs/${run.id}/tools/${encodeURIComponent(input.toolCallId)}`, { result: input.result, isError: input.isError === true });
			run.pending.delete(input.toolCallId);
			return result;
		},
		confirm: async id => {
			const run = activeRun, pending = run?.pending.get(id);
			if (!run?.id || !pending) throw new Error("No matching pending confirmation.");
			const allow = window.confirm(pending.kind === "klaud.approval" ? `Allow ${String(pending.tool || "this action").slice(0, 100)}?\n\n${pending.summary || ""}` : String(pending.args?.action || pending.summary || "Confirm this action?"));
			if (pending.kind === "klaud.approval") await json("POST", `/runs/${run.id}/approvals/${encodeURIComponent(id)}`, { allow });
			else await json("POST", `/runs/${run.id}/tools/${encodeURIComponent(id)}`, { result: JSON.stringify({ confirmed: allow }) });
			run.pending.delete(id);
			return { confirmed: allow };
		},
		onEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
	});
})();

/* Browser transport. Electron preload already defines window.klaud; this is a no-op there. */
(() => {
	if (typeof globalThis.klaud?.onboardingInspect === "function" && typeof globalThis.klaud?.status === "function") return;
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
		const response = await fetch(originUrl() + path, {
			method, signal, redirect: "error", credentials: "same-origin",
			headers: { Origin: originUrl(), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) {
			const raw = await response.text();
			let detail = raw;
			try { detail = JSON.parse(raw).error || raw; } catch { /* keep text */ }
			throw new Error(detail || `rein serve returned HTTP ${response.status}${response.status === 404 ? " (missing file)" : ""}.`);
		}
		return response;
	}
	async function json(method, path, body) {
		return (await http(method, path, body)).json();
	}
	const POLICY = "rein.klaud.approve";
	function readPolicy() {
		try { return { all: false, remember: false, commands: [], ...JSON.parse(localStorage.getItem(POLICY) || "{}") }; }
		catch { return { all: false, remember: false, commands: [] }; }
	}
	function writePolicy(next) { try { localStorage.setItem(POLICY, JSON.stringify(next)); } catch { /* private mode */ } }
	function fingerprint(pending) {
		const tool = String(pending.tool || pending.toolName || "action");
		const raw = pending.summary || JSON.stringify(pending.args || {});
		try { const parsed = JSON.parse(raw); return `${tool}:${parsed.command || parsed.action || raw}`; }
		catch { return `${tool}:${raw}`; }
	}
	function decideApproval(pending) {
		const mark = fingerprint(pending).slice(0, 500);
		const policy = readPolicy();
		if (policy.all || policy.commands.includes(mark)) return Promise.resolve({ allow: true });
		if (policy.remember) {
			if (!policy.commands.includes(mark)) writePolicy({ ...policy, commands: [...policy.commands.slice(-99), mark] });
			return Promise.resolve({ allow: true });
		}
		const title = pending.kind === "klaud.approval" ? `Allow ${String(pending.tool || "this action").slice(0, 80)}?` : "Confirm this action?";
		const body = String(pending.summary || pending.args?.action || "");
		if (typeof document === "undefined") return Promise.resolve({ allow: true });
		return new Promise(resolve => {
			const root = document.createElement("div");
			root.className = "klaud-approve";
			root.innerHTML = `<div class="klaud-approve-card"><p class="klaud-approve-title"></p><pre class="klaud-approve-body"></pre><div class="klaud-approve-actions"><button type="button" data-act="deny">Deny</button><button type="button" data-act="once">Allow</button><button type="button" data-act="remember">Whitelist</button><button type="button" class="primary" data-act="always">Always allow</button></div></div>`;
			root.querySelector(".klaud-approve-title").textContent = title;
			root.querySelector(".klaud-approve-body").textContent = body.slice(0, 1200);
			const finish = act => {
				root.remove();
				const next = readPolicy();
				if (act === "always") { next.all = true; writePolicy(next); void json("POST", "/settings", { bashApproval: "always" }).catch(() => {}); }
				if (act === "remember") { next.remember = true; if (!next.commands.includes(mark)) next.commands = [...next.commands.slice(-99), mark]; writePolicy(next); void json("POST", "/settings", { bashApproval: "whitelist" }).catch(() => {}); }
				if (act === "once" && next.remember) { if (!next.commands.includes(mark)) next.commands = [...next.commands.slice(-99), mark]; writePolicy(next); }
				resolve({ allow: act !== "deny" });
			};
			root.addEventListener("click", event => {
				const act = event.target?.dataset?.act;
				if (act) finish(act);
			});
			document.body.append(root);
		});
	}
	function route(operation, input = {}) {
		if (operation === "state") return { method: "GET", path: "/state" };
		if (operation === "getRunSettings") return { method: "GET", path: "/settings" };
		if (operation === "getActivity") return { method: "GET", path: "/activity" };
		if (operation === "saveRunSettings") return { method: "POST", path: "/settings", body: input };
		if (operation === "bots") return { method: "GET", path: "/bots" };
		if (operation === "messages") return { method: "GET", path: `/bots/${encodeURIComponent(input.id)}/messages${input.before === undefined ? "" : `?before=${input.before}`}` };
		if (operation === "createBot") return { method: "POST", path: "/bots", body: { name: input.name.trim() } };
		if (operation === "setBotAvatar") return { method: "PATCH", path: `/bots/${encodeURIComponent(input.id)}`, body: { avatar: input.avatar } };
		if (operation === "patchShell") return { method: "POST", path: "/state", body: { patch: input.patch } };
		if (operation === "setPref") return { method: "POST", path: "/prefs", body: { key: "lastBotId", value: input.value } };
		throw new Error("Unsupported backend operation.");
	}
	async function connect(options) {
		if (activeRun) throw new Error("Stop the current run before reconnecting.");
		const token = options?.token || currentToken() || "";
		if (token && (typeof token !== "string" || !/^[\x21-\x7e]{1,512}$/.test(token))) throw new Error("Enter a valid bearer token.");
		if (token) sessionStorage.setItem(TOKEN_KEY, token);
		connection = { url: originUrl(), token };
		state = await json("GET", "/state");
		return { connected: true, url: connection.url, state, run: null };
	}
	async function status() {
		if (!connection) {
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
	const skippedOnboarding = { version: 1, completed: true, prepared: true, existing: { found: false, configured: false, sessionCount: 0, botCount: 0, profileFound: false } };
	globalThis.klaud = Object.freeze({
		canStartLocal: false,
		onboardingInspect: async () => skippedOnboarding,
		onboardingPrepare: async () => { throw new Error("Browser origin attaches to rein serve; it does not own a local home."); },
		onboardingComplete: async () => skippedOnboarding,
		openAccountAuth: async () => ({ opened: false }),
		status, connect,
		inspect: async (botId, rel) => {
			const safe = String(rel || "").replace(/^\/+/, "");
			const encoded = safe.split("/").map(encodeURIComponent).join("/");
			let response;
			try {
				response = await http("GET", `/bots/${encodeURIComponent(botId)}/inspect?path=${encodeURIComponent(safe)}`);
			} catch (first) {
				response = await http("GET", `/bots/${encodeURIComponent(botId)}/inspect/${encoded}`);
			}
			const blob = await response.blob();
			const kind = response.headers.get("x-inspect-kind") || (blob.type.includes("html") ? "html" : blob.type.startsWith("image/") || blob.type.includes("svg") ? "image" : "text");
			const text = kind === "text" ? await blob.text() : "";
			return { url: URL.createObjectURL(blob), type: blob.type, kind, text, path: response.headers.get("x-inspect-path") || safe, name: safe.split("/").pop() };
		},
		inspectList: async botId => json("GET", `/bots/${encodeURIComponent(botId)}/inspect-list`),
		request: async (operation, input) => {
			if (operation === "getActivity") return { autonomy: { status: "unavailable" } };
			if (operation === "setBotAvatar") return state;
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
		pinQuote: async input => json("POST", "/journal/pin", { quote: input?.quote }),
		steer: async input => {
			const run = activeRun;
			if (!run?.id) throw new Error("The run has not started yet.");
			if (typeof input?.message !== "string" || !input.message.trim()) throw new Error("Interrupt requires a message.");
			return json("POST", `/runs/${run.id}/steer`, { message: input.message, quote: input.quote });
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
			const choice = await decideApproval(pending);
			if (pending.kind === "klaud.approval") await json("POST", `/runs/${run.id}/approvals/${encodeURIComponent(id)}`, { allow: choice.allow });
			else await json("POST", `/runs/${run.id}/tools/${encodeURIComponent(id)}`, { result: JSON.stringify({ confirmed: choice.allow }) });
			run.pending.delete(id);
			return { confirmed: choice.allow };
		},
		onEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
	});
})();

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

test("browser transport is same-origin fetch, not Electron IPC", async () => {
  const source = readFileSync(new URL("../browser.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ipcRenderer|require\(|node:/);
  const fetches = [];
  const storage = new Map();
  const sandbox = {
    location: { origin: "http://10.0.0.56:4317", hash: "", pathname: "/", search: "", protocol: "http:" },
    history: { replaceState() {} },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem(key, value) { storage.set(key, value); } },
    fetch: async (url, opts) => {
      fetches.push({ url, headers: opts.headers });
      if (String(url).includes("/settings")) return { ok: true, json: async () => ({ bashApproval: "ask", reasoningEffort: "default" }), body: { cancel() {} } };
      return { ok: true, json: async () => ({ bots: [] }), body: { cancel() {} } };
    },
    Set, Map, JSON, Object, Error, AbortController, TextDecoder,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert.equal(sandbox.klaud.canStartLocal, false);
  assert.equal(typeof sandbox.klaud.onboardingInspect, "function");
  assert.equal((await sandbox.klaud.onboardingInspect()).completed, true);
  await sandbox.klaud.connect({ token: "runtime-token", url: "http://127.0.0.1:9", mode: "remote" });
  assert.equal(fetches[0].url, "http://10.0.0.56:4317/state");
  assert.match(fetches[0].headers.Authorization, /^Bearer runtime-token$/);
  assert.equal(fetches[0].headers.Origin, "http://10.0.0.56:4317");
  fetches.length = 0;
  storage.clear();
  sandbox.klaud = undefined;
  vm.runInContext(source, sandbox);
  await sandbox.klaud.connect({});
  assert.equal(fetches[0].headers.Authorization, undefined);
  const settings = await sandbox.klaud.request("getRunSettings");
  assert.equal(settings.bashApproval, "ask");
  assert.equal((await sandbox.klaud.request("getActivity")).autonomy.status, "unavailable");
});

import test from "node:test";
import assert from "node:assert/strict";
import { sshRouteArguments, trustedAlternateAddresses } from "../src/ai/ssh-route.ts";

const known = "10.250.1.5 ssh-ed25519 SAME\n10.0.0.5 ssh-ed25519 SAME\n10.0.0.6 ssh-ed25519 OTHER\n203.0.113.5 ssh-ed25519 SAME\n";
test("SSH route recovery requires a previously recorded matching identity on a private address", () => {
  assert.deepEqual(trustedAlternateAddresses(known, "10.250.1.5"), ["10.0.0.5"]);
  assert.deepEqual(trustedAlternateAddresses(known, "unknown"), []);
  assert.deepEqual(trustedAlternateAddresses(known + "@revoked * ssh-ed25519 SAME\n", "10.250.1.5"), []);
  assert.deepEqual(trustedAlternateAddresses("@cert-authority * ssh-ed25519 SAME\n10.0.0.5 ssh-ed25519 SAME", "10.250.1.5"), []);
});
test("recovery retains the original SSH host-key identity without changing configuration", async () => {
  const checked: string[] = [];
  const result = await sshRouteArguments("saved-model", {
    config: async () => "hostname 10.250.1.5\nport 22\n",
    knownHosts: async () => known,
    reachable: async host => { checked.push(host); return host === "10.0.0.5"; },
  });
  assert.deepEqual(checked, ["10.250.1.5", "10.0.0.5"]);
  assert.ok(result.includes("Hostname=10.0.0.5"));
  assert.ok(result.includes("HostKeyAlias=10.250.1.5"));
  assert.ok(result.includes("StrictHostKeyChecking=yes"));
  assert.ok(result.includes("UpdateHostKeys=no"));
});
test("healthy routes, custom proxies and custom trust stores retain their existing behavior", async () => {
  for (const extra of ["", "proxyjump bastion\n", "proxycommand custom\n", "userknownhostsfile /custom/trust\n", "hostkeyalias original\n"]) {
    const result = await sshRouteArguments("saved-model", {
      config: async () => "hostname 10.250.1.5\nport 22\n" + extra,
      knownHosts: async () => { assert.fail("must not read fallback identities"); },
      reachable: async () => true,
    });
    assert.deepEqual(result, []);
  }
  await assert.rejects(sshRouteArguments("-oProxyCommand=bad"));
});

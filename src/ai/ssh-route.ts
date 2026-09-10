/** Recover a saved SSH host through another already trusted private address. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection, isIP } from "node:net";
import { promisify } from "node:util";

const exec = promisify(execFile);
function privateAddress(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const [a, b, , d] = value.split(".").map(Number);
  return d !== 0 && d !== 255 && (a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 100 && b >= 64 && b <= 127);
}

/** Only exact, non-revoked host keys and literal private addresses qualify. */
export function trustedAlternateAddresses(text: string, identity: string): string[] {
  const rows = text.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(row => row.length >= 3 && !row[0].startsWith("#"));
  const keys = new Set(rows.filter(row => !row[0].startsWith("@") && row[0].split(",").includes(identity)).map(row => `${row[1]} ${row[2]}`));
  const revoked = new Set(rows.filter(row => row[0] === "@revoked").map(row => `${row[2]} ${row[3]}`));
  return [...new Set(rows.filter(row => !row[0].startsWith("@") && keys.has(`${row[1]} ${row[2]}`) && !revoked.has(`${row[1]} ${row[2]}`))
    .flatMap(row => row[0].split(",")).filter(host => host !== identity && privateAddress(host)))].slice(0, 4);
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

export interface RouteDependencies {
  config?: (host: string) => Promise<string>;
  knownHosts?: () => Promise<string>;
  reachable?: (host: string, port: number) => Promise<boolean>;
}

export async function sshRouteArguments(host: string, dependencies: RouteDependencies = {}): Promise<string[]> {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]*$/.test(host)) throw new Error("Invalid SSH host.");
  try {
    const output = await (dependencies.config ?? (async value => (await exec("ssh", ["-G", "-o", "PermitLocalCommand=no", "--", value], { timeout: 800, maxBuffer: 256 * 1024 })).stdout))(host);
    const settings = Object.fromEntries(output.trim().split(/\r?\n/).map(line => { const i = line.indexOf(" "); return [line.slice(0, i), line.slice(i + 1)]; }));
    // A configured jump host/proxy or custom trust store must retain its route.
    const defaultStore = join(homedir(), ".ssh/known_hosts");
    if (settings.proxycommand && settings.proxycommand !== "none" || settings.proxyjump && settings.proxyjump !== "none" ||
      settings.hostkeyalias && settings.hostkeyalias !== "none" || settings.port !== "22" || !privateAddress(settings.hostname) ||
      settings.userknownhostsfile && !settings.userknownhostsfile.split(" ").some(path => path === defaultStore || path === "~/.ssh/known_hosts")) return [];
    const check = dependencies.reachable ?? reachable;
    if (await check(settings.hostname, 22)) return [];
    const contents = await (dependencies.knownHosts ?? (() => readFile(defaultStore, "utf8")))();
    const candidates = trustedAlternateAddresses(contents, settings.hostname);
    const checks = await Promise.all(candidates.map(async address => ({ address, ready: await check(address, 22) })));
    const alternate = checks.find(candidate => candidate.ready)?.address;
    // OpenSSH must still authenticate the original host identity. No trust is added.
    return alternate ? ["-o", `Hostname=${alternate}`, "-o", `HostKeyAlias=${settings.hostname}`, "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no"] : [];
  } catch { return []; }
}

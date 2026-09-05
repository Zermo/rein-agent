import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installService, servicePlan, serviceStatus, uninstallService, waitForService, type ServiceOptions } from "../src/harness/autonomy/service.ts";

function fixture(t: { after: (fn: () => void) => void }, platform: NodeJS.Platform = "linux") {
	const directory = mkdtempSync(join(tmpdir(), "rein-service-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const calls: string[][] = [];
	const options: ServiceOptions = {
		home: join(directory, "rein home"), cliPath: "/opt/rein bundle/dist/rein.js", nodePath: "/opt/node bin/node", userHome: directory, platform,
		commandRunner(command, args) { calls.push([command, ...args]); return { status: 0, stdout: platform === "darwin" ? "state = running\n" : "active\n" }; },
	};
	return { directory, calls, options };
}

test("launchd plan is scoped to REIN_HOME, escapes XML, and respects clean shutdown", () => {
	const options = { home: "/Users/alice/rein & <local>", cliPath: '/opt/"rein"/rein.js', nodePath: "/opt/node/bin/node", userHome: "/Users/alice", platform: "darwin" as const, uid: 501 };
	const plan = servicePlan(options);
	assert.equal(plan.manager, "launchd");
	assert.match(plan.path, /^\/Users\/alice\/Library\/LaunchAgents\/dev\.rein\.autonomy\.[a-f0-9]{24}\.plist$/);
	assert.match(plan.content, /<string>\/Users\/alice\/rein &amp; &lt;local&gt;<\/string>/);
	assert.match(plan.content, /<string>\/opt\/&quot;rein&quot;\/rein.js<\/string>/);
	assert.match(plan.content, /<key>SuccessfulExit<\/key><false\/>/);
	assert.doesNotMatch(plan.content, /<key>KeepAlive<\/key>\s*<true\/>/);
	assert.match(plan.content, /<string>\/opt\/node\/bin\/node<\/string><string>\/opt\/&quot;rein&quot;\/rein.js<\/string><string>autonomy<\/string><string>daemon<\/string>/);
	assert.equal(plan.installCommands[1][2], "gui/501");
	assert.notEqual(servicePlan({ ...options, home: options.home + "2" }).path, plan.path);
});

test("systemd preserves spaces, quotes, backslashes, dollars and literal percent signs", () => {
	const plan = servicePlan({ home: '/home/u/rein %n $HOME "local"', userHome: "/home/u", nodePath: '/opt/node $USER %i "x"/node', cliPath: '/opt/rein \\ "quoted" $HOME %n/rein.js', platform: "linux" });
	assert.equal(plan.manager, "systemd");
	assert.match(plan.content, /Environment="REIN_HOME=\/home\/u\/rein %%n \$HOME \\"local\\""/);
	const exec = plan.content.split("\n").find(line => line.startsWith("ExecStart="));
	assert.equal(exec, 'ExecStart=":/opt/node $USER %%i \\"x\\"/node" "/opt/rein \\\\ \\"quoted\\" $HOME %%n/rein.js" autonomy daemon');
	assert.match(plan.content, /Restart=on-failure/);
	assert.match(plan.content, /StandardOutput=null\nStandardError=null/);
	assert.ok(plan.installCommands.every(command => command[0] === "systemctl" && command[1] === "--user"));
	assert.equal(plan.installCommands.at(-1)![2], "restart");
});

test("service paths reject control characters and relative executable paths", () => {
	const options = { home: "/home/u/.rein", cliPath: "/opt/rein.js", nodePath: "/usr/bin/node", userHome: "/home/u", platform: "linux" as const };
	for (const value of ["relative", "/tmp/rein\nInjected=true", "/tmp/rein\r", "/tmp/rein\0", "/tmp/rein\t"]) {
		assert.throws(() => servicePlan({ ...options, home: value }), /absolute path without control/);
		assert.throws(() => servicePlan({ ...options, cliPath: value }), /absolute path without control/);
	}
});

test("service installation and removal use only the scoped user unit and private files", t => {
	const { calls, options } = fixture(t);
	const plan = servicePlan(options);
	assert.equal(serviceStatus(options).installed, false);
	assert.equal(calls.length, 0);
	const installed = installService(options);
	assert.equal(installed.active, true);
	assert.equal(readFileSync(plan.path, "utf8"), plan.content);
	assert.equal(lstatSync(plan.path).mode & 0o777, 0o600);
	assert.deepEqual(calls.slice(0, 3), plan.installCommands);
	const removed = uninstallService(options);
	assert.equal(removed.installed, false);
	assert.equal(existsSync(plan.path), false);
	assert.deepEqual(calls.slice(-2), plan.uninstallCommands);
});

test("launchd reinstall unloads its exact previous registration and replaces the bundle path", t => {
	const { options, calls } = fixture(t, "darwin");
	const plan = servicePlan(options);
	installService(options);
	calls.length = 0;
	installService({ ...options, cliPath: "/new/bundle/rein.js" });
	assert.deepEqual(calls[0], plan.uninstallCommands[0]);
	assert.match(readFileSync(plan.path, "utf8"), /<string>\/new\/bundle\/rein.js<\/string>/);
	assert.equal(calls.filter(call => call.includes("bootstrap")).length, 1);
});

test("changed, unrelated, symlinked or writable service files are never replaced or deleted", t => {
	for (const scenario of ["changed", "unrelated", "symlink", "writable"] as const) {
		const { options, directory, calls } = fixture(t);
		const plan = servicePlan(options);
		mkdirSync(dirname(plan.path), { recursive: true });
		if (scenario === "symlink") {
			const target = join(directory, "unrelated-file");
			writeFileSync(target, plan.content, { mode: 0o600 });
			symlinkSync(target, plan.path);
		} else writeFileSync(plan.path, scenario === "changed" ? plan.content + "# user edit\n" : scenario === "unrelated" ? "[Unit]\nDescription=Other app\n" : plan.content, { mode: 0o600 });
		if (scenario === "writable") chmodSync(plan.path, 0o666);
		const before = readFileSync(plan.path, "utf8");
		assert.throws(() => installService(options), /Refusing|not privately owned/);
		assert.throws(() => uninstallService(options), /Refusing|not privately owned/);
		assert.equal(readFileSync(plan.path, "utf8"), before);
		assert.equal(calls.length, 0);
	}
});

test("service-directory symlinks are rejected without writing through them", t => {
	const { options, directory, calls } = fixture(t);
	const target = join(directory, "unrelated-config");
	mkdirSync(target);
	symlinkSync(target, join(directory, ".config"));
	assert.throws(() => installService(options), /cannot be a symlink/);
	assert.throws(() => uninstallService(options), /cannot be a symlink/);
	assert.throws(() => serviceStatus(options), /cannot be a symlink/);
	assert.equal(existsSync(join(target, "systemd")), false);
	assert.equal(calls.length, 0);
});

test("a failed stop retains the service file and reports the failure", t => {
	const { options } = fixture(t);
	const plan = servicePlan(options);
	installService(options);
	assert.throws(() => uninstallService({ ...options, commandRunner: () => ({ status: 1, stderr: "User bus unavailable" }) }), /file was kept.*User bus unavailable/);
	assert.equal(readFileSync(plan.path, "utf8"), plan.content);
	const status = serviceStatus({ ...options, commandRunner: () => ({ status: 1, stderr: "User bus unavailable" }) });
	assert.equal(status.installed, true);
	assert.equal(status.active, null);
});

test("unsupported platforms provide a foreground command without filesystem or process actions", t => {
	const { options, calls } = fixture(t, "win32");
	for (const action of [serviceStatus, installService, uninstallService]) {
		const result = action(options);
		assert.equal(result.manager, "foreground");
		assert.equal(result.installed, false);
		assert.match(result.message, /rein autonomy daemon/);
	}
	assert.equal(calls.length, 0);
	assert.equal(existsSync(options.home), false);
});

test("startup polling waits for a running service and bounds stopped or unknown startup", async t => {
	const { options } = fixture(t);
	const installed = installService(options);
	let checks = 0;
	const delayed = { ...options, commandRunner: () => ({ status: ++checks < 2 ? 3 : 0, stdout: checks < 2 ? "inactive" : "active" }) };
	assert.equal((await waitForService(delayed, { ...installed, active: false }, { intervalMs: 10, timeoutMs: 100 })).active, true);
	assert.equal(checks, 2);
	const missingManager = { ...options, commandRunner: () => ({ status: 1, stderr: "User bus unavailable" }) };
	const stopped = await waitForService(missingManager, { ...installed, active: false }, { intervalMs: 10, timeoutMs: 20 });
	assert.equal(stopped.active, null);
	assert.match(stopped.message, /status is unavailable/);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/install-macos-app.sh", import.meta.url));
const posix = { skip: process.platform === "win32" };
const bundleID = "org.zermo.rein-klaud";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "rein-app-fixture-"));
    const destination = join(root, "Applications"), app = join(destination, "rein-klaud.app"), archive = join(root, "app.zip");
    mkdirSync(destination); writeFileSync(archive, "synthetic first-party app archive");
    const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const wrapper = `source "$REIN_FIX_SCRIPT"
uname() { if [ "$1" = -s ]; then printf '%s\\n' "\${REIN_FIX_PLATFORM:-Darwin}"; else printf 'arm64\\n'; fi; }
rein_mac_arch() { printf 'arm64\\n'; }
rein_mac_bundle_id() { cat "$1/bundle-id"; }
rein_mac_running() { [ "\${REIN_FIX_RUNNING:-0}" = 1 ]; }
rein_mac_verify_signature() { [ ! -f "$1/modified" ]; }
rein_mac_verify_arch() { [ "\${REIN_FIX_ARCH_FAIL:-0}" != 1 ]; }
rein_mac_gatekeeper() { return 1; }
rein_mac_launch() { printf '%s\\n' "$1" > "$REIN_FIX_ROOT/launched"; }
rein_mac_archive_paths() { printf '%s\\n' "\${REIN_FIX_PATHS:-rein-klaud.app/Contents/Info.plist}"; }
rein_mac_unpack() {
    touch "$REIN_FIX_ROOT/extracted"
    mkdir -p "$2/rein-klaud.app"
    printf '%s' "\${REIN_FIX_ID:-org.zermo.rein-klaud}" > "$2/rein-klaud.app/bundle-id"
    printf 'new' > "$2/rein-klaud.app/version"
    if [ "\${REIN_FIX_SIGNATURE_FAIL:-0}" = 1 ]; then touch "$2/rein-klaud.app/modified"; fi
}
mv() {
    if [ "\${REIN_FIX_PROMOTE_FAIL:-0}" = 1 ] && [[ "$1" == */.rein-klaud-install.*/rein-klaud.app ]]; then return 1; fi
    command mv "$@"
}
rein_macos_main --archive "$REIN_FIX_ARCHIVE" --sha256 "$REIN_FIX_HASH" "$@"
`;
    const env = { ...process.env, REIN_FIX_ROOT: root, REIN_FIX_SCRIPT: script, REIN_FIX_ARCHIVE: archive, REIN_FIX_HASH: hash, REIN_APP_INSTALL_DIR: destination, TMPDIR: root };
    return { root, destination, app,
        run: (extra: NodeJS.ProcessEnv = {}, args = ["--no-launch"]) => spawnSync("/bin/bash", ["-c", wrapper, "fixture", ...args], { env: { ...env, ...extra }, encoding: "utf8" }),
        existing: (id = bundleID) => { mkdirSync(app); writeFileSync(join(app, "bundle-id"), id); writeFileSync(join(app, "version"), "old"); },
        clean: () => rmSync(root, { recursive: true, force: true }) };
}

test("Mac installer verifies and installs an ad hoc app without overriding macOS protections", posix, () => {
    const f = fixture();
    try {
        const result = f.run(); assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(join(f.app, "version"), "utf8"), "new");
        assert.match(result.stdout, /normal macOS approval checks/);
        assert.equal(existsSync(join(f.root, "launched")), false);
        assert.deepEqual(readdirSync(f.destination), ["rein-klaud.app"]);
        const source = readFileSync(script, "utf8");
        assert.doesNotMatch(source, /xattr\s|spctl\s+--(?:master-disable|disable)|sudo\s/);
    } finally { f.clean(); }
});

for (const scenario of ["checksum", "path", "identity", "signature", "architecture"] as const) test(`Mac installer rejects ${scenario} failure before replacing the existing app`, posix, () => {
    const f = fixture();
    try {
        f.existing();
        const settings = {
            checksum: { REIN_FIX_HASH: "0".repeat(64) }, path: { REIN_FIX_PATHS: "rein-klaud.app/../../outside" },
            identity: { REIN_FIX_ID: "org.example.other" }, signature: { REIN_FIX_SIGNATURE_FAIL: "1" }, architecture: { REIN_FIX_ARCH_FAIL: "1" },
        }[scenario];
        const result = f.run(settings); assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(readFileSync(join(f.app, "version"), "utf8"), "old");
        assert.deepEqual(readdirSync(f.destination), ["rein-klaud.app"]);
        if (scenario === "checksum" || scenario === "path") assert.equal(existsSync(join(f.root, "extracted")), false);
    } finally { f.clean(); }
});

for (const scenario of ["other-app", "modified", "running", "symlink"] as const) test(`Mac installer preserves ${scenario} at its destination`, posix, () => {
    const f = fixture();
    try {
        if (scenario === "symlink") symlinkSync(join(f.root, "missing"), f.app);
        else f.existing(scenario === "other-app" ? "org.example.other" : bundleID);
        if (scenario === "modified") writeFileSync(join(f.app, "modified"), "local change");
        const result = f.run({ REIN_FIX_RUNNING: scenario === "running" ? "1" : "0" });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(existsSync(join(f.root, "extracted")), false);
        if (scenario !== "symlink") assert.equal(readFileSync(join(f.app, "version"), "utf8"), "old");
    } finally { f.clean(); }
});

test("Mac update retains the previous app and opens only the promoted copy", posix, () => {
    const f = fixture();
    try {
        f.existing(); const result = f.run({}, []); assert.equal(result.status, 0, result.stderr);
        const backup = readdirSync(f.destination).find(name => name.startsWith("rein-klaud.previous-")); assert.ok(backup);
        assert.equal(readFileSync(join(f.destination, backup, "version"), "utf8"), "old");
        assert.equal(readFileSync(join(f.root, "launched"), "utf8").trim(), f.app);
    } finally { f.clean(); }
});

test("Mac update rolls back when promotion fails", posix, () => {
    const f = fixture();
    try {
        f.existing(); const result = f.run({ REIN_FIX_PROMOTE_FAIL: "1" }); assert.equal(result.status, 1);
        assert.equal(readFileSync(join(f.app, "version"), "utf8"), "old");
        assert.deepEqual(readdirSync(f.destination), ["rein-klaud.app"]);
    } finally { f.clean(); }
});

test("app-only helper rejects non-Mac platforms without changing files", posix, () => {
    const f = fixture();
    try {
        const result = f.run({ REIN_FIX_PLATFORM: "Linux" }); assert.equal(result.status, 1);
        assert.match(result.stderr, /CLI remains available on Linux/); assert.deepEqual(readdirSync(f.destination), []);
    } finally { f.clean(); }
});

test("piping the helper into Bash invokes its entry point", posix, () => {
    const result = spawnSync("/bin/bash", ["-s", "--", "--help"], { input: readFileSync(script), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Install the native rein-klaud Mac app/);
});

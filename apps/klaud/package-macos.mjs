// Assemble an offline-capable .app with the already-built Rein CLI. No installer,
// user configuration, models, or accounts are read or changed by this command.
// Release inputs: REIN_MAC_SIGN_IDENTITY (Developer ID Application certificate)
// and REIN_MAC_NOTARY_PROFILE (an existing notarytool Keychain profile).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
const args = process.argv.slice(2);
let release = false, output = join(directory, ".build"), electronApp, requestedArch;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--release") release = true;
  else if (["--out", "--electron-app", "--arch"].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) {
    const flag = args[i], value = args[++i];
    if (flag === "--out") output = resolve(value);
    else if (flag === "--arch") requestedArch = value;
    else electronApp = resolve(value);
  } else throw new Error("Usage: node package-macos.mjs [--release] [--arch arm64|x64] [--out DIR] [--electron-app Electron.app]");
}
if (requestedArch && !["arm64", "x64"].includes(requestedArch)) throw new Error("--arch must be arm64 or x64.");
if (process.platform !== "darwin") throw new Error("macOS packaging requires a Mac with Xcode command line tools.");
const identity = process.env.REIN_MAC_SIGN_IDENTITY?.trim() || "-";
const notaryProfile = process.env.REIN_MAC_NOTARY_PROFILE?.trim();
if (identity !== "-" && !identity.startsWith("Developer ID Application:")) throw new Error("Direct distribution requires a Developer ID Application identity. Omit the identity for a local ad hoc build.");
if (release && (identity === "-" || !notaryProfile)) throw new Error("The --release mode requires REIN_MAC_SIGN_IDENTITY and REIN_MAC_NOTARY_PROFILE for notarized direct distribution. Omit --release to build an explicitly labeled development preview.");
if (notaryProfile && identity === "-") throw new Error("Notarization requires Developer ID signing.");

const run = (command, argv, options = {}) => execFileSync(command, argv, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024, ...options });
const require = createRequire(import.meta.url);
const electronVersion = JSON.parse(readFileSync(join(directory, "node_modules/electron/package.json"), "utf8")).version;
if (!electronApp && requestedArch) {
  const installedApp = resolve(dirname(require("electron")), "../..");
  const installedArch = run("/usr/bin/lipo", ["-archs", join(installedApp, "Contents/MacOS/Electron")]).trim();
  if (installedArch === (requestedArch === "x64" ? "x86_64" : "arm64")) electronApp = installedApp;
  else {
    // Electron already depends on this downloader. It verifies the target ZIP
    // against the checksums shipped with our pinned Electron dependency.
    const { downloadArtifact } = require("@electron/get");
    const checksums = require("electron/checksums.json");
    console.log(`Fetching verified Electron ${electronVersion} for macOS ${requestedArch}.`);
    const archive = await downloadArtifact({ version: electronVersion, artifactName: "electron", platform: "darwin", arch: requestedArch, checksums });
    const extraction = join(output, `.electron-${electronVersion}-${requestedArch}`);
    rmSync(extraction, { recursive: true, force: true });
    mkdirSync(extraction, { recursive: true });
    run("/usr/bin/ditto", ["-x", "-k", archive, extraction]);
    electronApp = join(extraction, "Electron.app");
  }
}
electronApp ??= resolve(dirname(require("electron")), "../..");
const sourceExecutable = join(electronApp, "Contents/MacOS/Electron");
if (!existsSync(sourceExecutable)) throw new Error("The selected Electron.app is missing its executable.");
const architectures = run("/usr/bin/lipo", ["-archs", sourceExecutable]).trim();
const arch = architectures === "arm64" ? "arm64" : architectures === "x86_64" ? "x64" : undefined;
if (!arch) throw new Error("Use an arm64 or x64 Electron.app. Universal packages are not supported.");
if (requestedArch && requestedArch !== arch) throw new Error("The selected Electron.app does not match --arch.");
const sourceVersion = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", join(electronApp, "Contents/Info.plist")]).trim();
if (sourceVersion !== electronVersion) throw new Error("The selected Electron.app must match the version pinned in apps/klaud/package-lock.json.");
const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
const reinMetadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error("The macOS version must contain three numeric components.");
for (const file of ["dist/rein.js", "dist/meat-worker.js"]) if (!existsSync(join(root, file))) throw new Error(`Missing ${file}. Build and commit Rein bundles before packaging.`);

mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(output, ".macos-"));
const app = join(staging, "rein-klaud.app"), resources = join(app, "Contents/Resources");
const appCode = join(resources, "app"), runtime = join(resources, "rein");
const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");
function copy(source, target) {
  if (!lstatSync(source).isFile()) throw new Error(`Expected a regular package resource: ${basename(source)}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
function plistSet(file, key, value) {
  try { run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, file]); }
  catch { run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, file]); }
}
function plistDelete(file, key) {
  try { run("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, file]); } catch { /* absent is already correct */ }
}
function nativeCode(path, entries = []) {
  // Preserve framework symlinks. Sign concrete children before their containers.
  for (const item of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, item.name);
    if (item.isDirectory()) {
      nativeCode(full, entries);
      if (/\.(app|framework)$/.test(item.name)) entries.push({ path: full, app: item.name.endsWith(".app") });
    } else if (item.isFile()) {
      const descriptor = openSync(full, "r"), magic = Buffer.alloc(4);
      try {
        if (readSync(descriptor, magic, 0, 4, 0) === 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic.readUInt32BE())) entries.push({ path: full, app: false });
      } finally { closeSync(descriptor); }
    }
  }
  return entries;
}
function zip(target) {
  // HFS metadata becomes ._ AppleDouble files in ZIPs. bsdtar can leave those
  // beside framework symlinks, which invalidates the signed framework envelope.
  // Distribute the signed files and symlinks without those metadata sidecars.
  run("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--keepParent", app, target]);
}

try {
  console.log(`Building rein-klaʊd ${metadata.version} for macOS ${arch}.`);
  run(process.execPath, [join(directory, "build.mjs")]);
  // ditto retains the Electron binaries, framework symlinks and signatures. The
  // complete app is then signed from the inside out under its own identity.
  run("/usr/bin/ditto", [electronApp, app]);
  rmSync(join(resources, "default_app.asar"), { force: true });
  rmSync(join(resources, "electron.icns"), { force: true });
  for (const file of ["main.mjs", "model.mjs", "lifecycle.mjs", "runtime-paths.mjs", "onboarding.mjs", "avatar-catalog.mjs", "preload.cjs", "icon.png", "NOTICE"]) copy(join(directory, file), join(appCode, file));
  const trayFiles = ["ready", "working"].flatMap(state => ["", "@2x", "Template", "Template@2x"].map(suffix => `tray-${state}${suffix}.png`));
  for (const file of trayFiles) copy(join(directory, file), join(appCode, file));
  for (const file of ["index.html", "renderer.js", "styles.css", "avatars.css", "setup.css", "tokens.css", "icon.svg", "icon.png", "rein-logo.svg", "rein-field-guide-card.jpg", ...trayFiles]) copy(join(directory, "dist", file), join(appCode, "dist", file));
  writeFileSync(join(appCode, "package.json"), JSON.stringify({ name: "rein-klaud", productName: metadata.productName, version: metadata.version, type: "module", main: "main.mjs", license: metadata.license }, null, 2) + "\n");
  for (const file of ["package.json", "LICENSE", "dist/rein.js", "dist/meat-worker.js"]) copy(join(root, file), join(runtime, file));

  // An explicit allowlist keeps source checkouts, test exports and local secrets
  // out of the app while retaining every resource used by the bundled runtime.
  const vendorFiles = [
    "meat/meat.wasm.gz", "meat/wasm_exec.cjs", "meat/build.json", "meat/LICENSE", "meat/APACHE-2.0", "meat/GO-LICENSE", "meat/UPSTREAM.md",
    "obscura/releases.json", "obscura/LICENSE", "obscura/UPSTREAM.md", "fold/LICENSE", "fold/UPSTREAM.md", "pi-posthorse/LICENSE", "pi-posthorse/UPSTREAM.md",
    ...["mattpocock", "ponytail"].flatMap(name => {
      const manifest = JSON.parse(readFileSync(join(root, "vendor", name, "manifest.json"), "utf8"));
      const files = Object.keys(manifest.files);
      if (files.some(file => file.startsWith("/") || file.includes("\\") || file.split("/").some(part => part === ".."))) throw new Error("Invalid bundled skill manifest path.");
      return [...new Set(["LICENSE", "manifest.json", ...files])].map(file => `${name}/${file}`);
    }),
    ...["LICENSE", "SKILL.md", "SECURITY.md", "templates/gates-leaf.md", "templates/gates-node.md", "templates/PLAN.md", "scripts/gate-check.mjs", "scripts/gate-lint.mjs", "scripts/lib/process-tree.mjs", "scripts/lib/regex-worker.mjs", "scripts/lib/gates.mjs", "scripts/lib/dispatch.mjs", "scripts/lib/check-supervisor.mjs", "references/dispatch.md", "references/gates.md", "references/parallel.md", "references/token-economy.md", "references/orchestration.md", "references/method.md"].map(file => `unlazy/${file}`),
  ];
  for (const file of vendorFiles) copy(join(root, "vendor", file), join(runtime, "vendor", file));
  copy(join(dirname(electronApp), "LICENSE"), join(resources, "LICENSE.electron"));
  copy(join(dirname(electronApp), "LICENSES.chromium.html"), join(resources, "LICENSES.chromium.html"));

  const iconset = join(staging, "rein.iconset");
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    run("/usr/bin/sips", ["-z", String(size * scale), String(size * scale), join(directory, "icon.png"), "--out", join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)]);
  }
  run("/usr/bin/iconutil", ["-c", "icns", "-o", join(resources, "rein.icns"), iconset]);
  const info = join(app, "Contents/Info.plist");
  renameSync(join(app, "Contents/MacOS/Electron"), join(app, "Contents/MacOS/rein-klaud"));
  // Electron's native helper lookup reads CFBundleName before JavaScript runs.
  // Keep it aligned with the ASCII executable/helper names; the display name
  // and the app's own menu use Klaudbot branding.
  for (const [key, value] of Object.entries({ CFBundleIdentifier: "org.zermo.rein-klaud", CFBundleName: "rein-klaud", CFBundleDisplayName: "Klaudbot", CFBundleExecutable: "rein-klaud", CFBundleIconFile: "rein.icns", CFBundleVersion: metadata.version, CFBundleShortVersionString: metadata.version, NSHumanReadableCopyright: "Copyright Zermo. MIT License." })) plistSet(info, key, value);
  plistDelete(info, "ElectronAsarIntegrity");
  for (const suffix of ["", " (GPU)", " (Plugin)", " (Renderer)"]) {
    const oldName = `Electron Helper${suffix}`, newName = `rein-klaud Helper${suffix}`;
    const helper = join(app, "Contents/Frameworks", `${newName}.app`);
    renameSync(join(app, "Contents/Frameworks", `${oldName}.app`), helper);
    renameSync(join(helper, "Contents/MacOS", oldName), join(helper, "Contents/MacOS", newName));
    const helperInfo = join(helper, "Contents/Info.plist"), kind = suffix.replace(/[ ()]/g, "").toLowerCase();
    for (const [key, value] of Object.entries({ CFBundleExecutable: newName, CFBundleName: newName, CFBundleDisplayName: newName, CFBundleIdentifier: `org.zermo.rein-klaud.helper${kind ? `.${kind}` : ""}` })) plistSet(helperInfo, key, value);
  }
  const nativeAppName = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleName", info]).trim();
  for (const suffix of ["", " (GPU)", " (Plugin)", " (Renderer)"]) {
    const helperName = `${nativeAppName} Helper${suffix}`;
    const helperContents = join(app, "Contents/Frameworks", `${helperName}.app`, "Contents");
    if (!existsSync(join(helperContents, "MacOS", helperName)) || run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", join(helperContents, "Info.plist")]).trim() !== helperName) throw new Error("The native app name and Electron helper executables do not match.");
  }
  const bundledBuild = { appVersion: metadata.version, reinVersion: reinMetadata.version, electronVersion, arch, bundleId: "org.zermo.rein-klaud", reinSha256: sha256(join(runtime, "dist/rein.js")), meatWorkerSha256: sha256(join(runtime, "dist/meat-worker.js")) };
  writeFileSync(join(resources, "rein-build.json"), JSON.stringify(bundledBuild, null, 2) + "\n");
  const entitlements = join(staging, "entitlements.plist");
  writeFileSync(entitlements, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n');
  const targets = nativeCode(app).sort((a, b) => b.path.split(sep).length - a.path.split(sep).length);
  targets.push({ path: app, app: true });
  // Hardened runtime requires a Developer ID team shared by the app and its
  // libraries. Local ad hoc signatures have no team and remain dev-only.
  for (const target of targets) run("/usr/bin/codesign", ["--force", "--sign", identity, identity === "-" ? "--timestamp=none" : "--timestamp", ...(identity === "-" ? [] : ["--options", "runtime"]), ...(target.app ? ["--entitlements", entitlements] : []), target.path]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);

  // Run only the headless Node entry after the final ZIP has been extracted by
  // the installer's exact command. A build never opens the desktop app.
  let smoke = "not-run-cross-architecture";
  let canRun = arch === process.arch;
  if (!canRun && arch === "x64" && process.arch === "arm64") {
    try { run("/usr/bin/arch", ["-x86_64", "/usr/bin/true"]); canRun = true; } catch { /* Rosetta is optional, never installed by a build. */ }
  }
  let notarized = false;
  const archive = join(staging, `rein-klaud-macos-${arch}.zip`);
  zip(archive);
  if (notaryProfile) {
    console.log("Submitting the Developer ID app for notarization.");
    const result = JSON.parse(run("/usr/bin/xcrun", ["notarytool", "submit", archive, "--keychain-profile", notaryProfile, "--wait", "--timeout", "30m", "--output-format", "json"], { timeout: 31 * 60_000 }));
    if (result.status !== "Accepted") throw new Error(`Notarization did not finish as Accepted. Submission: ${result.id || "unknown"}; status: ${result.status || "unknown"}.`);
    run("/usr/bin/xcrun", ["stapler", "staple", app]);
    run("/usr/bin/xcrun", ["stapler", "validate", app]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    run("/usr/sbin/spctl", ["--assess", "--type", "execute", app]);
    notarized = true;
    rmSync(archive); zip(archive);
  }
  const archivePaths = run("/usr/bin/tar", ["-tf", archive]).trim().split("\n");
  if (!archivePaths.length || archivePaths.some(path => !path.startsWith("rein-klaud.app/") || path.includes("\\") || path.split("/").some(part => part === ".." || part.startsWith("._")))) throw new Error("The app archive contains an unexpected path or AppleDouble metadata file.");
  const roundtrip = join(staging, "installed");
  mkdirSync(roundtrip);
  run("/usr/bin/tar", ["-xf", archive, "--no-same-owner", "--no-same-permissions", "-C", roundtrip]);
  const installedApp = join(roundtrip, "rein-klaud.app");
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", installedApp]);
  // A notarized release must retain its stapled ticket through the same ZIP
  // roundtrip. Validate that directly instead of assuming metadata survived.
  if (notarized) {
    run("/usr/bin/xcrun", ["stapler", "validate", installedApp]);
    run("/usr/sbin/spctl", ["--assess", "--type", "execute", installedApp]);
  }
  if (canRun) {
    run(process.execPath, [join(directory, "smoke-macos.mjs"), installedApp]);
    smoke = "passed";
  }
  const destination = join(output, "macos", arch);
  mkdirSync(destination, { recursive: true });
  const finalApp = join(destination, "rein-klaud.app"), finalZip = join(output, basename(archive));
  rmSync(finalApp, { recursive: true, force: true });
  renameSync(app, finalApp); renameSync(archive, finalZip);
  const report = { ...bundledBuild, artifact: basename(finalZip), bytes: statSync(finalZip).size, sha256: sha256(finalZip), codeSignature: identity === "-" ? "ad-hoc" : "developer-id", hardenedRuntime: identity !== "-", notarized, distribution: notarized ? "direct-distribution" : "local-development-only", archiveRoundtrip: "passed", smoke };
  writeFileSync(`${finalZip}.json`, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(`${finalZip}.sha256`, `${report.sha256}  ${basename(finalZip)}\n`);
  console.log(JSON.stringify({ ...report, appPath: finalApp, zipPath: finalZip }, null, 2));
} finally {
  rmSync(staging, { recursive: true, force: true });
}

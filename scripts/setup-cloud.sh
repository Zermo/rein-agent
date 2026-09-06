#!/usr/bin/env bash
# Development bootstrap for a checked-out Rein repository. Safe to rerun.
set -euo pipefail

fail() { printf 'Rein cloud setup: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 0 ] || fail "Usage: bash scripts/setup-cloud.sh"
REIN_SOURCE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REIN_SOURCE_ROOT"
[ -f package.json ] && [ -f package-lock.json ] && [ -f src/cli.ts ] ||
    fail "Run the script from a complete rein-agent checkout."

for dependency in node npm git tar; do
    command -v "$dependency" >/dev/null 2>&1 ||
        fail "Missing $dependency. Add it to the cloud image, then rerun this script. Node must support source TypeScript."
done

# Test the actual Node invocation, including any configured NODE_OPTIONS.
REIN_PROBE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rein-cloud-node.XXXXXX")"
trap 'rm -rf -- "$REIN_PROBE_DIR"' EXIT
printf 'const ready: number = 1; if (ready !== 1) process.exit(1);\n' > "$REIN_PROBE_DIR/probe.ts"
node "$REIN_PROBE_DIR/probe.ts" >/dev/null 2>&1 ||
    fail "$(node --version) cannot run source TypeScript. Choose Node 22.18+ in the environment package settings, or Node 24 or newer if available. Check that NODE_OPTIONS does not disable type stripping."

missing=()
for dependency in tmux python3 zstd; do
    command -v "$dependency" >/dev/null 2>&1 || missing+=("$dependency")
done
if [ "${#missing[@]}" -gt 0 ]; then
    [ "$(uname -s)" = Linux ] && command -v apt-get >/dev/null 2>&1 ||
        fail "Install ${missing[*]} with this machine's package manager, then rerun. Automatic system-package setup requires Linux with apt-get."
    if [ "$(id -u)" -eq 0 ]; then
        apt_command=(env DEBIAN_FRONTEND=noninteractive apt-get)
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        apt_command=(sudo -n env DEBIAN_FRONTEND=noninteractive apt-get)
    else
        fail "Missing ${missing[*]}. Preinstall them in the cloud image or allow noninteractive apt-get through sudo; setup cannot request a password."
    fi
    printf 'Installing missing development tools: %s\n' "${missing[*]}"
    # The cloud image may already have usable signed package indexes. Avoid
    # refreshing unrelated repositories unless installation actually needs it.
    if ! "${apt_command[@]}" install -y --no-install-recommends "${missing[@]}"; then
        printf 'Package installation needs a refresh; updating indexes and retrying.\n'
        "${apt_command[@]}" update || fail "apt-get update failed. Check setup-phase network access and package sources, or preinstall ${missing[*]} in the cloud image, then rerun."
        "${apt_command[@]}" install -y --no-install-recommends "${missing[@]}" ||
            fail "Could not install ${missing[*]} after refreshing package indexes. Preinstall them in the cloud image, then rerun."
    fi
fi
for dependency in tmux python3 zstd; do
    command -v "$dependency" >/dev/null 2>&1 || fail "$dependency is still unavailable on PATH after installation."
done

npm ci --include=dev --no-audit --no-fund ||
    fail "npm ci failed. Check setup-phase registry access and that package-lock.json matches package.json."
printf 'Rein development dependencies ready with Node %s. Run npm test, then npm run bundle.\n' "$(node --version)"

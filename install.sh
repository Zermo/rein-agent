#!/bin/bash
# ============================================================================
# rein — minimal local-first agent harness. Installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh | bash
#
# Installs the harness (prebuilt, zero runtime deps) and runs the interactive
# onboarding wizard: detect local AI servers → pick model → test → save config.
#
# Options (after `bash -s --`):
#   --skip-setup    install only; skip the wizard
#   --yes           non-interactive wizard (first local server / existing config)
#   --branch NAME   clone a different branch (default: main)
#
# Env:
#   REIN_REPO   alternate repo URL (default: the GitHub repo)
#   REIN_HOME   state directory (default: ~/.rein)
# ============================================================================
set -euo pipefail

REPO_URL="${REIN_REPO:-https://github.com/Zermo/rein-agent.git}"
REIN_HOME="${REIN_HOME:-$HOME/.rein}"
REPO_DIR="$REIN_HOME/repo"
BRANCH="main"
RUN_SETUP=true
ASSUME_YES=false

while [ $# -gt 0 ]; do
    case "$1" in
        --skip-setup) RUN_SETUP=false ;;
        --yes) ASSUME_YES=true ;;
        --branch) shift; BRANCH="${1:-main}" ;;
        -h|--help)
            sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
    shift
done

# ---- ui --------------------------------------------------------------------
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
    BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; NC=$'\033[0m'
else
    BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; NC=""
fi
step()  { printf '%s\n' "${BOLD}$*${NC}"; }
ok()    { printf '%s✓%s %s\n' "$GREEN" "$NC" "$*"; }
warn()  { printf '%s⚠%s %s\n' "$YELLOW" "$NC" "$*"; }
fail()  { printf '%s✗%s %s\n' "$RED" "$NC" "$*" >&2; exit 1; }

echo "${BOLD}rein${NC} — minimal local-first agent harness"
echo "${DIM}repo: $REPO_URL (branch: $BRANCH)${NC}"
echo ""

# ---- prerequisites ----------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git is required (brew install git / apt install git)"
command -v node >/dev/null 2>&1 || fail "Node.js 18+ is required (brew install node / nvm install 24 / npx n)"
command -v npm  >/dev/null 2>&1 || fail "npm is required (ships with Node.js)"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
    fail "Node.js 18+ required (found $(node --version)). brew install node / nvm install 24"
fi
ok "node $(node --version), npm $(npm --version), git $(git --version | awk '{print $3}')"

# ---- install ----------------------------------------------------------------
if [ -d "$REPO_DIR/.git" ]; then
    step "updating existing checkout at $REPO_DIR"
    git -C "$REPO_DIR" fetch --depth 1 origin "$BRANCH" && git -C "$REPO_DIR" checkout -q FETCH_HEAD
elif [ -e "$REPO_DIR" ]; then
    warn "$REPO_DIR exists but is not a git checkout — leaving it untouched"
else
    step "cloning $REPO_URL"
    mkdir -p "$REIN_HOME"
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi
ok "source at $REPO_DIR"

# devDependencies are optional (only needed to rebuild the bundle / run tests);
# the CLI itself is prebuilt and has zero runtime dependencies.
if (cd "$REPO_DIR" && npm install --no-audit --no-fund --loglevel=error) 2>/dev/null; then
    ok "dev dependencies installed (tests + bundle rebuild available)"
else
    warn "dev dependencies skipped (npm install failed — the CLI still works)"
fi

step "installing globally"
npm install --global --no-audit --no-fund --loglevel=error "$REPO_DIR"
ok "installed"

# ---- PATH -------------------------------------------------------------------
if ! command -v rein >/dev/null 2>&1; then
    GLOBAL_BIN="$(npm prefix -g)/bin"
    if [ -x "$GLOBAL_BIN/rein" ]; then
        warn "'rein' is not on PATH. Add this to your shell rc:"
        echo "    export PATH=\"$GLOBAL_BIN:\$PATH\""
    fi
fi

VERSION=$(node "$REPO_DIR/dist/rein.js" --version 2>/dev/null || node -p "require('$REPO_DIR/package.json').version")
ok "rein $VERSION"
echo ""

# ---- onboarding -------------------------------------------------------------
CONFIG="$REIN_HOME/config.json"
if [ -f "$CONFIG" ]; then
    step "existing config found — verifying"
    rein setup --status
elif [ "$RUN_SETUP" = true ]; then
    echo ""
    if [ -t 0 ] && [ "$ASSUME_YES" = false ]; then
        rein setup
    else
        if ! rein setup --yes 2>/dev/null; then
            echo ""
            warn "no local AI server detected — the wizard could not auto-pick a model"
            echo "    Start one (e.g. ollama serve) or run:"
            echo "        rein setup"
        fi
    fi
else
    echo ""
    warn "skipped setup (--skip-setup). Configure your model with:"
    echo "    rein setup"
fi

echo ""
echo "${BOLD}done.${NC} Quick start:"
echo "    rein -p \"hello, what model are you?\"   # one-shot"
echo "    rein                                     # interactive session"
echo "    rein models                              # what rein can see"
echo "    rein setup --status                      # re-check config + connection"

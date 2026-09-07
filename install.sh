#!/bin/bash
# ============================================================================
# rein — minimal local-first agent harness. Installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh | bash
#
# Installs the harness (prebuilt, zero runtime deps) and runs the interactive
# onboarding wizard: work style → model connection → follow-ups → first task.
#
# Options (after `bash -s --`):
#   --skip-setup    install only; skip the wizard and connection checks
#   --yes           non-interactive wizard (first local server / existing config)
#   --no-app        install CLI only; skip the native Mac app
#   --app-only      install the native Mac app without Git, Node, or npm
#   --terminal-only keep Rein in your current terminal; skip native apps
#   --nodeterm      also install the optional native NodeTerm app
#   --no-launch     finish setup without starting the interactive session
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
RUN_DESKTOP=false
PREFER_TERMINAL=false
LAUNCH_SESSION=true
SETUP_READY=false
SETUP_TTY=""
RUN_APP=false
[ "$(uname -s)" != Darwin ] || RUN_APP=true
APP_ONLY=false
APP_READY=false

while [ $# -gt 0 ]; do
    case "$1" in
        --skip-setup) RUN_SETUP=false ;;
        --yes) ASSUME_YES=true ;;
        --no-app) RUN_APP=false ;;
        --app-only) RUN_APP=true; APP_ONLY=true ;;
        --terminal-only) RUN_APP=false; RUN_DESKTOP=false; PREFER_TERMINAL=true ;;
        --nodeterm) RUN_DESKTOP=true; PREFER_TERMINAL=false ;;
        --no-launch) LAUNCH_SESSION=false ;;
        --branch)
            [ $# -ge 2 ] && [ -n "$2" ] || { echo "--branch requires a name" >&2; exit 2; }
            shift; BRANCH="$1" ;;
        -h|--help)
            cat <<'HELP'
Rein installer
  curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh | bash

Options after bash -s --:
  --skip-setup     Install only; keep saved settings and skip checks
  --yes            Unattended model setup; never invent an operator profile
  --no-app         Install only the CLI; skip the native Mac app
  --app-only       Install the native Mac app; no Git, Node, or npm needed
  --terminal-only  Stay in the current terminal; skip native apps
  --nodeterm       Also install the optional native NodeTerm app
  --no-launch      Finish setup without starting a chat session
  --branch NAME    Install a branch, default main

Run rein setup later for the guided walkthrough.
HELP
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

# App-only does not need a checkout or a system Node runtime. Download the
# bounded helper from the same public release origin as the app itself.
if [ "$APP_ONLY" = true ]; then
    [ "$RUN_APP" = true ] || fail "--app-only cannot be combined with --no-app or --terminal-only"
    [ "$(uname -s)" = Darwin ] || fail "The native app is for macOS. Omit --app-only to install the CLI on Linux or WSL."
    APP_INSTALLER=$(mktemp "${TMPDIR:-/tmp}/rein-app-installer.XXXXXXXX")
    trap 'rm -f "$APP_INSTALLER"' EXIT
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --connect-timeout 15 --max-time 60 --max-filesize 131072 \
        --output "$APP_INSTALLER" https://github.com/Zermo/rein-agent/releases/latest/download/install-macos-app.sh ||
        fail "The app installer is unavailable. See https://github.com/Zermo/rein-agent/releases."
    if [ "$LAUNCH_SESSION" = false ] || [ "$RUN_SETUP" = false ] || [ "$ASSUME_YES" = true ] || [ -n "${CI:-}" ]; then
        bash "$APP_INSTALLER" --no-launch
    else
        bash "$APP_INSTALLER"
    fi
    exit $?
fi

# ---- prerequisites ----------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git is required (brew install git / apt install git)"
command -v node >/dev/null 2>&1 || fail "Node.js 18+ is required (brew install node / nvm install 24 / npx n)"
command -v npm  >/dev/null 2>&1 || fail "npm is required (ships with Node.js)"
git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 || fail "invalid branch name: $BRANCH"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
    fail "Node.js 18+ required (found $(node --version)). brew install node / nvm install 24"
fi
ok "node $(node --version), npm $(npm --version), git $(git --version | awk '{print $3}')"

# ---- install ----------------------------------------------------------------
if [ -e "$REPO_DIR/.git" ]; then
    step "updating existing checkout at $REPO_DIR"
    CHECKOUT_STATUS=$(git -C "$REPO_DIR" status --porcelain) || fail "could not inspect the existing checkout"
    [ -z "$CHECKOUT_STATUS" ] || fail "local changes exist in $REPO_DIR; commit or move them before updating"
    git -C "$REPO_DIR" fetch --depth 1 origin "$BRANCH" || fail "could not fetch $BRANCH; the existing build was not replaced"
    git -C "$REPO_DIR" checkout --detach -q FETCH_HEAD || fail "could not switch to the downloaded build"
elif [ -e "$REPO_DIR" ]; then
    fail "$REPO_DIR exists but is not a git checkout; move it before installing"
else
    step "cloning $REPO_URL"
    mkdir -p "$REIN_HOME"
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi
ok "source at $REPO_DIR"
[ -f "$REPO_DIR/dist/rein.js" ] || fail "downloaded build is missing dist/rein.js"
VERSION=$(node "$REPO_DIR/dist/rein.js" --version) || fail "downloaded build could not start"

# devDependencies are optional (only needed to rebuild the bundle / run tests);
# the CLI itself is prebuilt and has zero runtime dependencies.
if (cd "$REPO_DIR" && npm ci --no-audit --no-fund --loglevel=error) 2>/dev/null; then
    ok "dev dependencies installed (tests + bundle rebuild available)"
else
    warn "dev dependencies skipped (npm ci failed — the CLI still works)"
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

ok "$VERSION"
echo ""

# Native Mac app is an optional addition; a missing app release never removes
# the working CLI. Keep setup here in the caller's terminal before opening it.
if [ "$RUN_APP" = true ] && [ "$(uname -s)" = Darwin ]; then
    step "installing the native rein-klaud app"
    if [ -f "$REPO_DIR/scripts/install-macos-app.sh" ] && bash "$REPO_DIR/scripts/install-macos-app.sh" --no-launch; then
        APP_READY=true
    else
        warn "Rein CLI is installed. The native app could not be installed; quit an existing app before updating, or retry: curl -fsSL https://github.com/Zermo/rein-agent/releases/latest/download/install-macos-app.sh | bash"
    fi
fi

# NodeTerm remains an explicit extra.
# Use the just-installed bundle, not a potentially stale global executable.
if [ "$RUN_DESKTOP" = true ]; then
    node "$REPO_DIR/dist/rein.js" desktop install --no-launch ||
        fail "Rein CLI installed, but optional NodeTerm setup failed. Retry: rein desktop install --no-launch."
elif [ "$PREFER_TERMINAL" = true ]; then
    node "$REPO_DIR/dist/rein.js" desktop use terminal
fi

# ---- onboarding -------------------------------------------------------------
if [ "$RUN_SETUP" = false ]; then
    step "setup skipped (--skip-setup)"
elif [ "$ASSUME_YES" = true ]; then
    node "$REPO_DIR/dist/rein.js" setup --yes ||
        warn "Connection setup needs attention. Run rein setup for the guided walkthrough."
elif [ -t 0 ] && [ -t 1 ]; then
    SETUP_TTY=stdin
    if node "$REPO_DIR/dist/rein.js" setup; then SETUP_READY=true; else
        warn "Setup is unfinished. Run rein setup to continue; saved settings are kept."
    fi
# curl owns stdin. Read answers from the controlling terminal instead of the script.
elif [ -t 1 ] && [ -z "${CI:-}" ] && ( : < /dev/tty ) 2>/dev/null; then
    SETUP_TTY=controlling
    if node "$REPO_DIR/dist/rein.js" setup < /dev/tty; then SETUP_READY=true; else
        warn "Setup is unfinished. Run rein setup to continue; saved settings are kept."
    fi
else
    step "No interactive terminal. Run rein setup when ready, or use --yes for unattended model setup."
fi

echo ""
echo "${BOLD}done.${NC} Quick start:"
echo "    rein -p \"hello, what model are you?\"   # one-shot"
echo "    rein                                     # interactive session"
echo "    rein models                              # what rein can see"
echo "    rein setup --status                      # re-check config + connection"
if [ "$SETUP_READY" = true ] && [ "$LAUNCH_SESSION" = true ] && [ -z "${CI:-}" ]; then
    if [ "$APP_READY" = true ]; then
        step "Opening the native rein-klaud app. Choose Start local rein serve to begin."
        if open -a "${REIN_APP_INSTALL_DIR:-$HOME/Applications}/rein-klaud.app"; then exit 0; fi
        warn "macOS could not open the app. Open rein-klaud from Finder; continuing in this terminal."
    fi
    step "Starting Rein in this terminal. Type /help for commands or /quit to exit."
    # Replace the installer so Ctrl-C, EOF and terminal resize go straight to Rein.
    # Keep the caller's directory; installing the repo must not change the workspace.
    if [ "$SETUP_TTY" = controlling ]; then
        exec node "$REPO_DIR/dist/rein.js" --terminal < /dev/tty
    else
        exec node "$REPO_DIR/dist/rein.js" --terminal
    fi
fi

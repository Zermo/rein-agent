#!/bin/bash
# Tom-only: mint a one-shot okay for ios git push and/or TestFlight.
# Agents: do not run this unless Tom said "ok ios" in THIS turn.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/ios-guard.sh" issue "${1:-both}" "${2:-2}"

#!/bin/bash
# klaʊdbot iOS ship gate. Agents must not write the receipt.
set -euo pipefail

ROOT="/Users/macmini/Projects/rein-agent-private"
RECEIPT="$ROOT/.tom-ok-ios"
LOG="/Users/macmini/Projects/klaud-ios-dist/ios-guard.log"
mkdir -p "$(dirname "$LOG")"

stamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

notify() {
  local why="$1"
  local line
  line="$(stamp) BLOCKED why=${why} user=${USER:-?} pwd=${PWD:-?} actor=${SSH_ORIGINAL_COMMAND:-local}"
  echo "$line" >>"$LOG"
  echo "$line" >&2
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"${why}\" with title \"klaʊdbot iOS guard\" subtitle \"blocked without Tom okay\"" >/dev/null 2>&1 || true
  fi
}

scope_ok() {
  local need="$1"
  local got="$2"
  case "$got" in
    both) return 0 ;;
    "$need") return 0 ;;
    git) [ "$need" = git ] ;;
    testflight) [ "$need" = testflight ] ;;
    *) return 1 ;;
  esac
}

require() {
  local need="${1:-git}"
  if [ ! -f "$RECEIPT" ]; then
    notify "no .tom-ok-ios receipt (need scope=${need})"
    echo "iOS ${need} blocked. Tom: run apps/klaud-ios/scripts/ios-ok.sh ${need}" >&2
    return 1
  fi
  local scope expires first
  first="$(head -1 "$RECEIPT" | tr -d '\r')"
  if [ "$first" != "SHIP-IOS" ]; then
    notify "receipt missing SHIP-IOS header"
    return 1
  fi
  scope="$(awk -F= '/^scope=/{print $2; exit}' "$RECEIPT" | tr -d '\r')"
  expires="$(awk -F= '/^expires=/{print $2; exit}' "$RECEIPT" | tr -d '\r')"
  scope="${scope:-both}"
  if [ -n "$expires" ]; then
    local now exp_s now_s
    now="$(stamp)"
    exp_s="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$expires" +%s 2>/dev/null || echo 0)"
    now_s="$(date -u +%s)"
    if [ "$exp_s" -gt 0 ] && [ "$now_s" -gt "$exp_s" ]; then
      notify "receipt expired at ${expires}"
      rm -f "$RECEIPT"
      return 1
    fi
  fi
  if ! scope_ok "$need" "$scope"; then
    notify "receipt scope=${scope} does not cover ${need}"
    return 1
  fi
  echo "$(stamp) ALLOW ${need} scope=${scope} expires=${expires:-none}" >>"$LOG"
  return 0
}

consume() {
  local need="${1:-git}"
  if [ -f "$RECEIPT" ]; then
    echo "$(stamp) CONSUME ${need}" >>"$LOG"
    rm -f "$RECEIPT"
  fi
}

issue() {
  local scope="${1:-both}"
  local hours="${2:-2}"
  local exp
  exp="$(date -u -v+"${hours}"H +"%Y-%m-%dT%H:%M:%SZ")"
  umask 077
  cat >"$RECEIPT" <<EOF
SHIP-IOS
scope=${scope}
expires=${exp}
issued=$(stamp)
EOF
  echo "okay written: scope=${scope} expires=${exp}"
}

cmd="${1:-}"
case "$cmd" in
  require) require "${2:-git}" ;;
  consume) consume "${2:-git}" ;;
  notify) notify "${2:-manual}" ;;
  issue) issue "${2:-both}" "${3:-2}" ;;
  *)
    echo "usage: ios-guard.sh require|consume|notify|issue [git|testflight|both] [hours]" >&2
    exit 2
    ;;
esac

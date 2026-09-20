#!/bin/bash
export PATH=/opt/homebrew/bin:/usr/bin:/bin
export NEXT_TELEMETRY_DISABLED=1
export KLAUD_ORIGIN=http://10.0.0.56:4317
export KLAUD_BIND_HOST=10.0.0.56
export KLAUD_PORT=4322
export KLAUD_SANDBOX_ORIGIN=http://10.0.0.56:4322
if [ -f /Users/macmini/.rein/klaud/typesafe.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /Users/macmini/.rein/klaud/typesafe.env
  set +a
fi
cd /Users/macmini/Projects/klaudbot-next
exec /opt/homebrew/bin/node /Users/macmini/Projects/klaudbot-next/node_modules/next/dist/bin/next start --hostname 10.0.0.56 --port 4322

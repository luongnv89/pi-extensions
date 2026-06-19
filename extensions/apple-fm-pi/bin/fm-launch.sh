#!/usr/bin/env bash
# apple-fm-pi — foreground fm serve + background fm-proxy (PCC attribution).
# Based on https://github.com/gregbarbosa/fm-proxy (MIT)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VERBOSE=false
FM_PORT="${FM_PORT:-1976}"
PROXY_PORT="${PROXY_PORT:-1977}"
FM_BIN="${FM_BIN:-/usr/bin/fm}"
HEALTH_TIMEOUT_MS="${HEALTH_TIMEOUT_MS:-20000}"

usage() {
  cat <<EOF
apple-fm-pi fm-launch — fm serve (foreground) + fm-proxy

  OpenAI base URL: http://127.0.0.1:\$PROXY_PORT/v1

  -v, --verbose
  --fm-port <n>       (default 1976)
  --proxy-port <n>    (default 1977)
  --fm-bin <path>
  -h, --help

Keep this Terminal open for PCC. Ctrl-C to stop.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -v|--verbose) VERBOSE=true; shift ;;
    --fm-port) FM_PORT="${2:-}"; shift 2 ;;
    --proxy-port) PROXY_PORT="${2:-}"; shift 2 ;;
    --fm-bin) FM_BIN="${2:-}"; shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT_MS="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown: $1" >&2; exit 2 ;;
  esac
done

ts() { date '+%H:%M:%S'; }
say() { printf '%s [apple-fm-pi] %s\n' "$(ts)" "$*"; }

probe_health() {
  curl -s -m 1 "http://127.0.0.1:$1/health" 2>/dev/null | grep -qE 'running|available|status'
}

wait_health() {
  local deadline=$(( $(date +%s) * 1000 + $2 ))
  while :; do
    probe_health "$1" && return 0
    [[ $(( $(date +%s) * 1000 )) -ge $deadline ]] && return 1
    sleep 0.3
  done
}

probe_listening() {
  curl -s -m 1 -o /dev/null "http://127.0.0.1:$1/health" 2>/dev/null
}

wait_listening() {
  local deadline=$(( $(date +%s) * 1000 + $2 ))
  while :; do
    probe_listening "$1" && return 0
    [[ $(( $(date +%s) * 1000 )) -ge $deadline ]] && return 1
    sleep 0.3
  done
}

PROXY_PID=""
cleaning=false
cleanup() {
  $cleaning && return
  cleaning=true
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
  pkill -f "fm serve --port $FM_PORT" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM HUP EXIT

export FM_PORT PROXY_PORT
say "starting fm-proxy on :$PROXY_PORT → fm :$FM_PORT"
node "$SCRIPT_DIR/vendor/fm-proxy/fm-proxy.cjs" >>"$HOME/.pi/agent/logs/apple-fm-pi-fm-launch-proxy.log" 2>&1 &
PROXY_PID=$!
if ! wait_listening "$PROXY_PORT" 10000; then
  say "proxy did not listen on :$PROXY_PORT"
  exit 1
fi

say "starting fm serve on :$FM_PORT (foreground — required for PCC)"
(
  if wait_health "$FM_PORT" "$HEALTH_TIMEOUT_MS"; then
    say "stack up — OpenAI base URL: http://127.0.0.1:$PROXY_PORT/v1"
  else
    say "fm serve not healthy; check Apple Intelligence / Terminal sign-in"
  fi
) &

exec "$FM_BIN" serve --port "$FM_PORT"
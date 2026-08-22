#!/usr/bin/env bash
# Publish all npm extensions.
#
# Auth modes:
#   1. Browser (default): npm prints/opens an authorization URL for each
#      publish — approve it in the browser. Requires a recent npm (>= 9.6).
#   2. Legacy OTP: pass the code as the first arg, or set NPM_OTP.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OTP="${1:-${NPM_OTP:-}}"

EXTENSIONS=(9router-pi advisor-pi agy-pi cache-warm claude-code-pi grok-pi model-debugger opencode-pi statusline-pi subagents-pi timestamp-pi)

echo "===== packaging check ====="
node "$ROOT/scripts/check-packaging.mjs"

for name in "${EXTENSIONS[@]}"; do
  echo "===== publish $name ====="
  if [[ -n "$OTP" ]]; then
    (cd "$ROOT/extensions/$name" && npm publish --access public --otp="$OTP")
  else
    # npm shows an https://www.npmjs.com/auth/cli/... link (and opens the
    # browser when possible) — approve it to complete the publish.
    (cd "$ROOT/extensions/$name" && npm publish --access public)
  fi
done

echo "Done. Verify: npm view statusline-pi version"

#!/usr/bin/env bash
# Publish all npm extensions. Requires npm 2FA: pass OTP as first arg or NPM_OTP env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OTP="${1:-${NPM_OTP:-}}"
OTP_FLAG=()
if [[ -n "$OTP" ]]; then
  OTP_FLAG=(--otp="$OTP")
fi

EXTENSIONS=(advisor-pi grok-pi model-debugger opencode-pi statusline-pi)

echo "===== packaging check ====="
node "$ROOT/scripts/check-packaging.mjs"

for name in "${EXTENSIONS[@]}"; do
  echo "===== publish $name ====="
  (cd "$ROOT/extensions/$name" && npm publish --access public "${OTP_FLAG[@]}")
done

echo "Done. Verify: npm view statusline-pi version"
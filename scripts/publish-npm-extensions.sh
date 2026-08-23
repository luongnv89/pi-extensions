#!/usr/bin/env bash
# Publish npm extensions that are already published and have a newer local
# version than what's on the registry.
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

TO_PUBLISH=()
for name in "${EXTENSIONS[@]}"; do
  dir="$ROOT/extensions/$name"
  local_version="$(node -p "require('$dir/package.json').version")"
  published_version="$(npm view "$name" version 2>/dev/null || true)"

  if [[ -z "$published_version" ]]; then
    echo "-- $name $local_version: not yet on npm, skipping"
    continue
  fi

  if [[ "$local_version" == "$published_version" ]]; then
    echo "-- $name $local_version: already published, skipping"
    continue
  fi

  if [[ "$(printf '%s\n' "$published_version" "$local_version" | sort -V | head -n1)" != "$published_version" ]]; then
    echo "-- $name: local $local_version is NOT newer than published $published_version, skipping"
    continue
  fi

  echo "-- $name: $published_version -> $local_version, will publish"
  TO_PUBLISH+=("$name")
done

if [[ ${#TO_PUBLISH[@]} -eq 0 ]]; then
  echo "Nothing to publish."
  exit 0
fi

echo "===== publishing ${#TO_PUBLISH[@]} extension(s): ${TO_PUBLISH[*]} ====="
for name in "${TO_PUBLISH[@]}"; do
  echo "===== publish $name ====="
  if [[ -n "$OTP" ]]; then
    (cd "$ROOT/extensions/$name" && npm publish --access public --otp="$OTP")
  else
    # npm shows an https://www.npmjs.com/auth/cli/... link (and opens the
    # browser when possible) — approve it to complete the publish.
    (cd "$ROOT/extensions/$name" && npm publish --access public)
  fi
done

echo "Done. Verify e.g.: npm view statusline-pi version"

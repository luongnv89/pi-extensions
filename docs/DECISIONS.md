# Decisions Log

Append-only log of documentation ambiguities resolved with the user.

## 2026-08-21
- Q: Should `scripts/publish-npm-extensions.sh` include the npm-packaged but unpublished `agy-pi`, `hermes-pi`, and `timestamp-pi`?
- A (user): Remove hermes-pi; clarified — delete the hermes-pi extension from the repository entirely (extension + theme + docs), like the earlier apple-fm-pi removal. Add `agy-pi` and `timestamp-pi` to the publish list; their first script run performs their initial npm publish.
- Source: `scripts/publish-npm-extensions.sh:12`, npm registry 404 for `hermes-pi`/`agy-pi`/`timestamp-pi`
- Q: How should root README document the unpublished extensions?
- A (user): Full usage sections (same depth as existing extensions), marked as repo-only installs until published.
- Source: README "Quick Start" note + Usage sections for agy-pi / timestamp-pi

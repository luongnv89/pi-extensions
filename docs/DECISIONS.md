# Decisions Log

Append-only log of documentation ambiguities resolved with the user.

## 2026-08-21
- Q: Should `scripts/publish-npm-extensions.sh` include the npm-packaged but unpublished `agy-pi`, `hermes-pi`, and `timestamp-pi`?
- A (user): Remove hermes-pi; clarified — delete the hermes-pi extension from the repository entirely (extension + theme + docs), like the earlier apple-fm-pi removal. Add `agy-pi` and `timestamp-pi` to the publish list; their first script run performs their initial npm publish.
- Source: `scripts/publish-npm-extensions.sh:12`, npm registry 404 for `hermes-pi`/`agy-pi`/`timestamp-pi`
- Q: How should root README document the unpublished extensions?
- A (user): Full usage sections (same depth as existing extensions), marked as repo-only installs until published.
- Source: README "Quick Start" note + Usage sections for agy-pi / timestamp-pi

## 2026-08-22
- Q: Should prompt-cache keep-alive ship by extending timestamp-pi, or as a separate `cache-warm` package?
- A: Separate `extensions/cache-warm` npm package. timestamp-pi stays TUI-only (timestamps never reach the LLM). Warming is paid session traffic and must be independently togglable (default off). Countdown helpers (`CACHE_TTL_MS`, `computeCacheStatus`) are copied (~20 lines) rather than extracted into a shared library; no runtime imports from timestamp-pi or statusline-pi.
- Source: issue #51

## 2026-08-24
- Q: Should cache-warm keep-alive start enabled, and should idle warming be unbounded?
- A: Default on for new sessions (#55). Auto-stop after 30 minutes idle (from last user turn or enable) so a forgotten session does not bill overnight. `/cache-warm duration 1h` / `CACHE_WARM_DURATION` sets the window; `forever` disables auto-stop. `/cache-warm on` also clears a suppressed epoch while already enabled.
- Source: issue #55 / PR #56 review; follow-up idle auto-stop

## 2026-09-02
- Q: Should cache-warm continue starting enabled, and should its default timing move from roughly 4m00s to 4m50s for a five-minute cache?
- A (user): Make cache-warm off by default. Keep the existing one-minute safety margin rather than moving to 4m50s: review found that the 12/hour limiter, not the 4m00s send point, could force periodic misses. Derive the default cap from the cadence (15/hour) so it cannot block a normally scheduled refresh.
- Source: cache-warm logic review

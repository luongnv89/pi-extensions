# Code Review Report

**Date**: 2026-09-02
**Scope**: Full audit of `extensions/cache-warm`
**Mode**: Mode 1 — small extension, inline review
**Files Reviewed**: 6 source/test files
**Excluded**: generated `dist/`, `node_modules/`, and `package-lock.json`

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| Major | 2 |
| Minor | 0 |
| Info | 1 |

## Critical Issues

None.

## Major Issues

### [Correctness]: Default rate cap forces periodic cache expiry
**File**: `extensions/cache-warm/src/warm.ts:27`
**Category**: Conflicting invariants

The short-cache scheduler warms when 60 seconds remain, producing a four-minute cadence. That requires up to 15 pings in a rolling hour, but the default cap is 12. In a continuously enabled session, the limiter eventually blocks warming long enough for the five-minute cache to expire. The existing rate-limit test checks burst limiting but not a sustained keep-alive cadence.

**Suggested fix**: Derive the default cap from the rate window and the default refresh interval, and add a sustained-cadence regression test. A user-specified lower cap may still intentionally permit expiry.

**Resolution**: Fixed. The derived default is 15/hour and the test suite covers sustained cadence.

### [Safety]: Paid warming starts without explicit opt-in
**File**: `extensions/cache-warm/src/warm.ts:124`
**Category**: Unsafe default

`createWarmState()` and `resetSession()` both enable paid background turns. This conflicts with the requested opt-in behavior and means installing or starting a session can generate paid traffic without `/cache-warm on`.

**Suggested fix**: Default and reset `enabled` to `false`; verify startup creates no timer or warm request and explicit enablement still works.

**Resolution**: Fixed. Startup and session-reset tests verify opt-in behavior and timer cleanup.

## Minor Issues

None.

## Info

### [Reliability]: Moving the warm point to 4m50s would reduce safety margin
**File**: `extensions/cache-warm/src/cache.ts:8`
**Category**: Scheduling trade-off

The current threshold sends at roughly 4m00s for a five-minute TTL, leaving about 60 seconds for event-loop delay, machine wake-up, queueing, and provider latency. Sending at 4m50s leaves only ten seconds and cannot fix misses caused by the incompatible rate cap, idle auto-stop, prompt-prefix changes, or provider behavior.

**Resolution**: Retained the one-minute safety margin and documented the rationale.

## Recommendations

1. Keep the current 60-second safety margin.
2. Make warming off by default and require `/cache-warm on` per session.
3. Raise/derive the default rolling-hour cap so it cannot defeat the default cadence.
4. Document that cache hits are best-effort and that the 30-minute idle stop or an explicitly lower cap can permit later misses.

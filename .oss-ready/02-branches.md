# Branch Inventory Report

**Generated:** 2026-05-22  
**Repository:** luongnv89/pi-extensions  
**Remote:** origin (git@github.com:luongnv89/pi-extensions)

---

## Protected — Do Not Touch

| Branch | Type | Last Commit | Author | Note |
|--------|------|-------------|--------|------|
| `main` | local + remote | 2026-05-22 | Luong NGUYEN | Default branch, protected by convention |

## Unmerged — Needs Review

| Branch | Ahead | Behind | Last Commit | Author | Open PR | Proposed Action |
|--------|-------|--------|-------------|--------|---------|----------------|
| `origin/feature/statusline-pi` | +5 | -3 | 2026-05-22 | Luong NGUYEN | No | Rebase onto main, create PR, then delete |

### Commits on `feature/statusline-pi` not in `main`
```
185be21 Merge context window and zone status
fac66ee Use distinct statusline section colors
592687d Improve statusline PR refresh visibility
baa6600 Replace context stats with compact statusline extension
a5c11d8 Add context stats speed and git status indicators
```

### Commits in `main` not on `feature/statusline-pi`
```
11766f2 fix: show actual thinking level from pi API, add reasoning support indicator
b689dfc feat(install): single-command install with auto-cleanup
6d9ccff Replace context-stats-pi with statusline-pi
```

---

## Summary Count

| Category | Count |
|----------|-------|
| `protected-do-not-touch` | 1 |
| `merged-safe-to-delete` | 0 |
| `unmerged-needs-review` | 1 |
| `stale-no-activity-90d` | 0 |
| `active-recent` | 1 |

### Notes

- `origin/HEAD` is a symbolic ref pointing to `origin/main`, not an independent branch.
- `origin/main` tracks `main` locally; both are fully in sync (0 ahead, 0 behind).
- Branch protection is **not** configured on GitHub for any branch.
- `feature/statusline-pi` is actively diverged (5 ahead, 3 behind) with no open PR. Must be rebased/merged before deletion.

## Actions Log

| Branch | Action | Status |
|--------|--------|--------|
| `feature/statusline-pi` | Cherry-picked 2 useful commits (`fac66ee`, `185be21`) onto main, deleted local + remote branch | ✅ done |

### Cherry-picked commits
- `274349c` — Use distinct statusline section colors
- `e61e05c` — Merge context window and zone status

**Result:** Only `main` remains. Verified by `git branch -a`.

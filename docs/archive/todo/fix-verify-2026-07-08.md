# Consolidated Fix Verification - 2026-07-08

Scope: original local fix range `da84f435..944bd2ef` on `main` (32 commits, batches 1-7, not pushed). During verification one regression fix was committed locally, so current `HEAD` is `5ece9d28` and `da84f435~1..HEAD` is now 33 commits.

## Worktree State

- Initial check: `git log --oneline da84f435~1..HEAD` showed the requested 32 commits ending at `944bd2ef`.
- Initial status: clean except untracked `docs/todo/*.md`.
- Final status after verification: clean application tree; only untracked `docs/todo/*.md`, including this report.
- Temporary base worktree: `/tmp/codeshell-verify-base-da84f435` at `da84f435~1` (`5ead7494`), removed after comparison.

## Build

| Command | Result | Notes |
| --- | --- | --- |
| `bun run build` on original current tree | PASS | Core and TUI builds exited 0. |
| `bun run build` on base worktree `da84f435~1` | PASS | Required package-level `node_modules` links in the temp worktree. |
| `bun run build` after regression fix | PASS | Core and TUI builds exited 0. |

## Full Test Suite

Final current-tree run after the local regression fix:

| Command | Result |
| --- | --- |
| `bun test` | exit 1 |
| Pass | 4878 |
| Skip | 6 |
| Fail | 2 |
| Errors | 1 |
| Expect calls | 10985 |
| Total | 4886 tests across 704 files |

Comparison base run at `da84f435~1`:

| Command | Result |
| --- | --- |
| `bun test` | exit 1 |
| Pass | 4827 |
| Skip | 6 |
| Fail | 2 |
| Errors | 2 |
| Total | 4835 tests across 690 files |

Pre-fix current-tree full runs repeatedly exited early at `packages/core/src/cli/__tests__/agent-server-stdio-factory.test.ts` after `3792` pass markers and `2` explicit fail markers, with no Bun summary. That was a real regression introduced by the batch because the base full suite reached a normal summary.

## Failing Tests / Errors Classification

| Current full-suite item | Classification | Evidence |
| --- | --- | --- |
| `public VERSION > matches package.json version` | PRE-EXISTING | Fails on current and at `da84f435~1` with the same mismatch: expected `0.6.0-rc.14`, received `0.6.0-rc.13`. Targeted base run: `bun test packages/core/src/version.test.ts` -> `0 pass / 1 fail`. |
| `checkPluginUpdate > remote + missing meta.commit -> updateAvailable false, reason about no recorded commit` | PRE-EXISTING suite artifact | Targeted current and base runs of `packages/core/src/plugins/installer/checkUpdate.test.ts` both pass `5 pass / 0 fail`. The full-suite failure is attached to pre-existing unhandled `rm-race-* / run.json.lock` `ECOMPROMISED` errors, which are also present in the base full-suite log and were charged there to a different nearby plugin test (`uninstallPluginByName`). |
| `Unhandled error between tests`: `ENOENT stat .../rm-race-*/run.json.lock` (`ECOMPROMISED`) | PRE-EXISTING | Same `rm-race-*` lockfile errors occur in the base full-suite log before the plugin installer section. Targeted `RunManager.resume-race.test.ts` passes `5 pass / 0 fail`; this is a known full-suite async/lock cleanup artifact, not caused by the 32 commits. |

## Regression Found And Fixed

| Regression | Fix commit | Verification |
| --- | --- | --- |
| Current full suite exited early when `agent-server-stdio-factory.test.ts` imported `agent-server-stdio.ts` after prior tests left ambient cwd/HOME unsuitable for the worker's top-level settings load. Base full suite did not exit early. | `5ece9d28 fix(test): isolate stdio factory config` | `bun test packages/core/src/cli/__tests__/agent-server-stdio-factory.test.ts` -> `4 pass / 0 fail`; ordered reproduction tail -> `49 pass / 0 fail`; full `bun test` now reaches the normal summary. |

No application code was changed for this fix; only the affected test now creates an explicit temp settings fixture before dynamically importing the stdio worker module.

## Lint / Typecheck

| Command | Result | Notes |
| --- | --- | --- |
| `bun run lint` | PASS | Exit 0. Reports 167 existing warnings, 0 errors. No warning was reported for the changed stdio factory test file. |
| `bun run typecheck` | PASS | Exit 0 (`tsc --noEmit`). No changed-file type errors. |

## Final Verdict

1 REGRESSIONS FOUND AND FIXED

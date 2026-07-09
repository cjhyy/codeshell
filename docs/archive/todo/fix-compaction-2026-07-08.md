# Compaction Fix Report - 2026-07-08

## Task A

Command:

```bash
bun test packages/cdp/src/driver.test.ts packages/core/src/release-workflow.test.ts
```

Result: PASS.

- 35 pass
- 0 fail
- 112 expect() calls
- Ran 35 tests across 2 files

## Task B

Verdict: FIXED-NOW-with-commit.

Commit: `ba7b2dc5` (`fix(core): persist context usage anchor`)

Evidence from current code before the fix:

- The fallback estimator remains heuristic in `packages/core/src/context/compaction.ts:21-22`.
- The in-process anchor/rescale path was already present: `ContextManager.recordActualUsage()` stored real prompt tokens, message count, and an estimate anchor; `estimateTokensHybrid()` used real-plus-delta for appended messages and ratio rescale after message shrinkage.
- `TurnLoop` fed provider `usage.promptTokens` and the current messages into `ContextManager.recordActualUsage()`.
- The remaining gap was persistence/resume: `SessionState` had cumulative `tokenUsage`, but no context-estimation anchor, so a resumed/cold process could not seed `ContextManager` before the first provider response.

What changed:

- Added `ContextUsageAnchor` to `SessionState`.
- Added `ContextManager.seedActualUsage()` and `getActualUsageAnchor()`; `recordActualUsage()` now returns the normalized anchor it stores.
- `TurnLoop` forwards the normalized anchor through an optional dependency callback.
- `Engine.run()` stores the latest anchor in `session.state.contextUsageAnchor`, tagged with provider/model.
- `Engine.run()` seeds `ContextManager` from a compatible persisted anchor before the first context-management decision and uses it for the initial `session_started.promptTokens` seed when available.

Tests added:

- `packages/core/src/context/manager-hybrid.test.ts`: persisted anchor seeding preserves the same post-compaction rescale behavior as a live provider response.
- `packages/core/src/engine/engine.context-anchor.test.ts`: provider prompt-token anchors are persisted in session state; resumed `session_started.promptTokens` uses a compatible persisted anchor instead of the rough char estimate.

Verification:

```bash
bun test packages/core/src/context/manager-hybrid.test.ts packages/core/src/context/manager-micro-escalation.test.ts
bun test packages/core/src/engine/engine.context-anchor.test.ts packages/core/src/engine/turn-loop-usage-cache.test.ts
```

Result: PASS.

- Context tests: 9 pass, 0 fail, 29 expect() calls
- Engine/turn-loop tests: 7 pass, 0 fail, 34 expect() calls


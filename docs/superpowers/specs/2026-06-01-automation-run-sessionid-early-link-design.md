# Automation Run sessionId Early-Link + In-Flight Import — Design

**Date**: 2026-06-01
**Status**: Approved design, pending spec review
**Related**: [[project-automation-run-sidebar]], [[project-automation-plan]], [[project-runlock-esm-bug]]

## Problem

The sidebar-import feature (`feat/automation-run-sidebar`) is correct but **inert in the real environment**: every automation run's `run.json` has `sessionId: null`, so `importAutomationRuns` filters them all out and no automation session ever appears in the sidebar.

Root cause (verified from logs + code, simpler than the memory implied):

- The engine emits `session_started` carrying the real sessionId at the **start** of every run (`engine/engine.ts:1081`; the comment at :1078 says "without this, the client only learns the sid when the run completes").
- RunManager's `onStream` callback (`run/RunManager.ts:444`) receives that event but does **not** use it to link the sessionId. It only links at `result.sessionId` (`run/RunManager.ts:477`), which fires after the **whole run completes**.
- Therefore, for the entire `running` lifetime — and for the many runs that are still queued/running — `run.json` `sessionId` stays `null`.

Observed: 8 automation runs on disk, all `sessionId=None` (running + queued), e.g. run `05tJtYdHIMIhLA6t` ("每日早间新闻汇总") shows `run.submitted sid="session-1780245883110-puenc5"` in the engine log yet `run.json` `sessionId` is null. The desktop "运行历史" page (the old `runs:list` view, not the new sidebar) shows the raw `runId` because there's no session/title yet.

## Decisions (locked with user)

| Topic | Decision |
|---|---|
| Fix scope | **RunManager only** — minimal, low-risk. Do NOT touch `helpers.ts:58` or `EngineRunner`. The `session_started` event already carries `sessionId` inside the event, so the envelope-drop at helpers.ts:58 is irrelevant to this fix. |
| In-flight runs | **Import `running` runs too** — drop the terminal-status filter; import any automation run with a non-null `sessionId`. Matches the user intent ("click in to see what ran"). |
| Refresh semantics | A run imported while `running` must be **re-importable** once it completes (so the half-written transcript snapshot gets replaced by the full one). Achieve by **excluding non-terminal imported sessions from the dedup skip-set**, keyed on a new `runStatus` field. |

## Architecture

Two small, isolated changes — one per package. No new files.

```
core: engine emits session_started(sessionId) at run start  [already exists]
        │
        ▼
   RunManager.onStream  ──(NEW)── on session_started: link sessionId into
   (RunManager.ts:444)            RunSnapshot immediately (reuse the existing
                                  session_linked persist path from :477-483)
        │
        ▼
   run.json sessionId is populated while status === "running"
        │
        ▼
desktop: importAutomationRuns  ──(CHANGED)── drop terminal-status filter;
   (importRuns.ts)                            import any automation run with
                                              a sessionId. Carry runStatus.
        │
        ▼
   App.tsx backfill  ──(CHANGED)── build the dedup skip-set from ONLY
                                   terminal-status imported sessions, so a
                                   running import can be overwritten on the
                                   next backfill once it completes.
```

### Change 1 — RunManager links sessionId on `session_started` (core)

**File**: `packages/core/src/run/RunManager.ts`, the `onStream` callback at line 444.

Today the callback feeds checkpointWriter/artifactTracker and forwards to subscribers. Add: when `event.type === "session_started"` and it has no `agentId` (main run, not a sub-agent — sub-agent session_started is already filtered upstream at engine.ts:832, but guard anyway), and the run's current `sessionId` differs, link it immediately by reusing the same three steps the post-completion path uses at lines 477-483:

1. `current.sessionId = event.sessionId`
2. `checkpointWriter.setSessionId(event.sessionId)`
3. `await this.emitRunEvent(runId, "session_linked", { sessionId: event.sessionId })`
4. persist the snapshot (same persistence the existing link path triggers).

The callback must fetch the current run snapshot (RunManager already has a `get`/`getOrThrow` accessor used at line 465) and persist via the same store mutation the completion-link uses. **Plan-time lookup**: identify the exact snapshot-persist call RunManager uses after setting `current.sessionId` at lines 477-483 (e.g. a `store.update`/`store.save`/`persistRun` call near there) and reuse it verbatim in the onStream path — do not invent a new persistence route. Idempotency: the existing completion-time link at line 477 (`result.sessionId && current.sessionId !== result.sessionId`) becomes a natural no-op once the sessionId is already set, so `session_linked` is emitted exactly once.

Edge cases:
- `session_started` carries an `agentId` (sub-agent) → skip (don't link a sub-agent session as the run's session).
- Multiple `session_started` for the same run (resume) → the `current.sessionId !== event.sessionId` guard prevents redundant links/persists.
- onStream is `async`; the link persist is awaited inside it so ordering with checkpoint writes is deterministic.

### Change 2 — import in-flight runs + refreshable dedup (desktop)

**Files**: `packages/desktop/src/renderer/automation/importRuns.ts`, `packages/desktop/src/renderer/transcripts.ts` (add `runStatus?`), `packages/desktop/src/renderer/App.tsx` (skip-set construction).

1. **importRuns.ts filter**: change from
   `source==="automation" && TERMINAL.has(status) && sessionId && !known.has(sessionId)`
   to
   `source==="automation" && !!sessionId && !known.has(sessionId)`.
   (Drop the `TERMINAL` check. `queued` runs without a sessionId are naturally excluded by `!!sessionId`.) Remove the now-unused `TERMINAL` const in importRuns.ts.

2. **SessionSummary** (transcripts.ts): add `runStatus?: string` — the run's status at import time. `importAutomationRuns` sets it from `r.status`. `ImportableRun` already carries `status`.

3. **App.tsx backfill skip-set**: when building `known` (`existingEngineSessionIds`), include a session's `engineSessionId` only when it is NOT a still-running automation import — i.e. skip-set excludes sessions where `s.source === "automation" && s.runStatus is non-terminal`. Define terminal as `completed|failed|cancelled`. Concretely: a session counts toward dedup if `!s.source || s.runStatus is terminal || !s.runStatus` (manual sessions and completed imports dedupe; running imports do not). This lets a `running`-imported session be re-imported and overwritten (via `upsertImportedSession`, which updates in place by engineSessionId) once it reaches a terminal state.

## Data flow (run lifecycle → sidebar)

1. Cron fires → RunManager submits run → engine emits `session_started(sid)` → **(new)** RunManager writes `sid` into `run.json` immediately; status is `running`.
2. Next desktop mount/backfill → `listRuns()` returns the run with `sessionId=sid, status="running"` → imported (transcript = current snapshot) → sidebar shows it (with the existing automation marker), `runStatus="running"`.
3. Run completes → `run.json` status `completed`, transcript fully written.
4. Next desktop mount/backfill → the running import's sessionId is NOT in the skip-set (its `runStatus` was non-terminal) → re-imported → `upsertImportedSession` overwrites in place with the full transcript + `runStatus="completed"` → now it IS in the skip-set, no further re-import.

## Error handling

- onStream link-persist failure: log and continue (don't crash the run over a snapshot write); the completion-time link at :477 remains as a backstop.
- A run that never emits `session_started` (crashes pre-session): stays `sessionId=null`, naturally never imported — unchanged from today.
- transcript fetch failure during import (already handled in importRuns): folds empty state, still imports the summary.

## Testing

- **RunManager (core, unit/characterization)**: feed a fake stream where `session_started(sid)` fires before completion; assert the RunSnapshot `sessionId` is set and a `session_linked` event emitted BEFORE the run finishes (not only at the end). Assert a sub-agent `session_started` (with `agentId`) does NOT link. Assert idempotency: completion-time link does not emit a second `session_linked`.
- **importRuns (desktop, unit)**: a `running` automation run with a sessionId IS imported (terminal filter gone); a `queued` run with null sessionId is NOT; `runStatus` is carried onto the summary.
- **Backfill skip-set (desktop, unit if extractable, else characterization)**: a session imported with `runStatus="running"` is NOT in the dedup skip-set (so re-import overwrites); one with `runStatus="completed"` IS.
- **End-to-end sanity (manual)**: with the cron job running, confirm `run.json` gets a sessionId while still `running`, and the run appears in the sidebar under its cwd's project.

## Out of scope (YAGNI)

- Fixing `helpers.ts:58` envelope-drop (not needed; separate latent issue).
- Live push (real-time stream into the sidebar tab while open) — still a fast-follow; backfill-on-mount covers "see it on next open/refresh".
- Reconciling the old desktop "运行历史" page that shows raw runIds — separate surface, not this feature.

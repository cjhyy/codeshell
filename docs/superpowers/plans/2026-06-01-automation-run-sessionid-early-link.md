# Automation Run sessionId Early-Link + In-Flight Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automation runs link their sessionId into `run.json` the moment the engine emits `session_started` (instead of only at run completion), and let the sidebar import in-flight (`running`) runs and refresh them when they complete — so automation runs actually appear in the sidebar.

**Architecture:** Two isolated changes. (1) `core/RunManager.onStream` links the sessionId on `session_started` by reusing the existing `session_linked` persist path, with an explicit `store.update` since the run is still mid-flight. (2) `desktop/importRuns` drops the terminal-status filter (imports any automation run with a sessionId) and carries `runStatus`; `App.tsx` builds its dedup skip-set from only terminal-status imports so a running import is overwritten on completion.

**Tech Stack:** TypeScript; Bun test runner. Core is `@cjhyy/code-shell-core` (ESM, `tsc module ESNext`). Desktop is a thin renderer client. After adding/changing core exports, rebuild core (`bun run --filter '@cjhyy/code-shell-core' build`) before relying on it from tui dist — but here core changes are internal to RunManager (no new export), so no rebuild is needed for the change to take effect in tests. Desktop has its OWN `tsc --noEmit` + tests — run them in `packages/desktop`.

---

## File Structure

**Modify:**
- `packages/core/src/run/RunManager.ts` — in the `onStream` callback (line 444), link sessionId on `session_started`.
- `packages/desktop/src/renderer/automation/importRuns.ts` — drop terminal filter; carry `runStatus`; sort by `finishedAt ?? createdAt`.
- `packages/desktop/src/renderer/transcripts.ts` — add `runStatus?: string` to `SessionSummary`.
- `packages/desktop/src/renderer/App.tsx` — build the dedup skip-set excluding still-running automation imports.

**Test:**
- `packages/core/src/run/RunManager.test.ts` (or a new focused test file if that's the repo convention — check; the task specifies the assertions either way).
- `packages/desktop/src/renderer/automation/importRuns.test.ts` (extend existing).

---

## Task 1: RunManager links sessionId on `session_started` (core)

**Files:**
- Modify: `packages/core/src/run/RunManager.ts:444-451` (the `onStream` callback)
- Test: `packages/core/src/run/RunManager.test.ts` (extend; if it doesn't exist, create `packages/core/src/run/RunManager.session-link.test.ts`)

**Context — the exact current code at RunManager.ts:442-452:**
```typescript
    const context: RunExecutionContext = {
      signal: ac.signal,
      onStream: async (event: StreamEvent) => {
        // Feed events to checkpoint writer and artifact tracker
        await checkpointWriter.onStreamEvent(event);
        await artifactTracker.onStreamEvent(event);

        // Forward to run subscribers
        this.notifySubscribers(runId, { type: "engine_stream", event });
      },
    };
```
The completion-time link (lines 477-483) does `current.sessionId = result.sessionId; checkpointWriter.setSessionId(...); emitRunEvent("session_linked", ...)` and is persisted later by `store.update(current)` in the finalize block (lines 534/547). For the EARLY link the run is still mid-flight, so we must `await this.store.update(...)` ourselves. Accessors available: `this.getOrThrow(runId)` (→ `RunSnapshot`), `this.store.update(run)`, `this.emitRunEvent(runId, type, data)`, `checkpointWriter.setSessionId(id)`. The `session_started` StreamEvent shape is `{ type: "session_started"; sessionId: string; promptTokens: number }` (no `agentId`); sub-agent variants would carry `agentId`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/run/RunManager.test.ts` (read the file first to match its existing harness for constructing a RunManager with a fake/stub executor; mirror an existing test's setup). The test drives a run whose executor, during execution, invokes `context.onStream({ type: "session_started", sessionId: "sess-early", promptTokens: 0 })` BEFORE returning, then returns a result. Assert that the snapshot's `sessionId` is `"sess-early"` and a `session_linked` event was emitted *during* execution (before completion), and that no duplicate `session_linked` is emitted at completion.

```typescript
// Pattern (adapt to the file's existing RunManager construction helpers):
it("links sessionId as soon as session_started fires, not only at completion", async () => {
  const linkedEvents: string[] = [];
  // Build a RunManager with an in-memory store and a stub executor that
  // emits session_started mid-run then resolves. (Reuse the file's existing
  // makeManager / stub-executor helper — see other tests in this file.)
  const mgr = makeManagerWithStubExecutor(async (run, context) => {
    await context.onStream?.({ type: "session_started", sessionId: "sess-early", promptTokens: 0 });
    // snapshot must already carry the sessionId at this point
    const mid = await mgr.get(run.runId);
    expect(mid?.sessionId).toBe("sess-early");
    return { result: { text: "done", reason: "completed", sessionId: "sess-early", turnCount: 1 }, handle: {} as never };
  });
  const { runId } = await mgr.submit({ objective: "x", cwd: "/tmp" });
  await mgr.waitForIdle?.(); // or however the file awaits run completion
  const events = await mgr.listEvents(runId);
  const linked = events.filter((e) => e.type === "session_linked");
  expect(linked).toHaveLength(1);
  expect(linked[0].data.sessionId).toBe("sess-early");
  const snap = await mgr.get(runId);
  expect(snap?.sessionId).toBe("sess-early");
});

it("does not link a sub-agent session_started (event with agentId)", async () => {
  const mgr = makeManagerWithStubExecutor(async (run, context) => {
    await context.onStream?.({ type: "session_started", sessionId: "sub-sess", promptTokens: 0, agentId: "sub-1" } as never);
    return { result: { text: "done", reason: "completed", sessionId: "main-sess", turnCount: 1 }, handle: {} as never };
  });
  const { runId } = await mgr.submit({ objective: "x", cwd: "/tmp" });
  await mgr.waitForIdle?.();
  const snap = await mgr.get(runId);
  expect(snap?.sessionId).toBe("main-sess"); // linked at completion, NOT to sub-sess
});
```
NOTE: The exact helper names (`makeManagerWithStubExecutor`, `waitForIdle`) are placeholders — replace with this test file's actual setup utilities. If the file builds RunManager via `new RunManager({ store, executor })` with a custom executor, write the stub executor inline as that shape. The assertions (mid-run sessionId set, exactly one `session_linked`, sub-agent skipped) are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/run/RunManager.test.ts -t "links sessionId as soon"`
Expected: FAIL — mid-run `snap.sessionId` is `null` (link only happens at completion today).

- [ ] **Step 3: Implement — link in onStream**

Replace the `onStream` callback (RunManager.ts:444-451) with:
```typescript
      onStream: async (event: StreamEvent) => {
        // Feed events to checkpoint writer and artifact tracker
        await checkpointWriter.onStreamEvent(event);
        await artifactTracker.onStreamEvent(event);

        // Link the run's sessionId the moment the engine resolves it
        // (session_started fires at run START — see engine.ts:1081). Without
        // this, sessionId is only written at run completion, so in-flight runs
        // have sessionId=null on disk and never reach the sidebar import.
        // Skip sub-agent sessions (they carry an agentId); only the main run's
        // session identifies the run.
        if (
          event.type === "session_started" &&
          !(event as { agentId?: string }).agentId
        ) {
          const run = await this.getOrThrow(runId);
          if (run.sessionId !== event.sessionId) {
            run.sessionId = event.sessionId;
            checkpointWriter.setSessionId(event.sessionId);
            await this.store.update(run);
            await this.emitRunEvent(runId, "session_linked", {
              sessionId: event.sessionId,
            });
          }
        }

        // Forward to run subscribers
        this.notifySubscribers(runId, { type: "engine_stream", event });
      },
```
This reuses the same link steps as the completion path (set sessionId, setSessionId on the writer, emit `session_linked`) plus an explicit `store.update(run)` because the run is mid-flight. The completion-time link at line 477 (`result.sessionId && current.sessionId !== result.sessionId`) then becomes a no-op (sessionId already equals result.sessionId), so `session_linked` is emitted exactly once.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/run/RunManager.test.ts -t "session"`
Expected: PASS (both new tests).

- [ ] **Step 5: Run the full RunManager test file (no regression)**

Run: `bun test packages/core/src/run/RunManager.test.ts`
Expected: all pass (the completion-link no-op must not break existing session_linked assertions — if an existing test asserted `session_linked` count/timing, confirm it still holds; the count is unchanged at 1).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/run/RunManager.ts packages/core/src/run/RunManager.test.ts
git commit -m "fix(run): link sessionId on session_started, not only at completion

Automation runs had sessionId=null in run.json for their entire running
lifetime because RunManager only linked at result.sessionId (completion).
The engine emits session_started with the real sid at run start; link it
immediately so in-flight runs carry a sessionId on disk."
```
(If you created a separate test file instead of extending RunManager.test.ts, adjust the `git add` path accordingly.)

---

## Task 2: importRuns imports in-flight runs + carries runStatus (desktop)

**Files:**
- Modify: `packages/desktop/src/renderer/transcripts.ts` (add `runStatus?` to `SessionSummary`)
- Modify: `packages/desktop/src/renderer/automation/importRuns.ts:43-100`
- Test: `packages/desktop/src/renderer/automation/importRuns.test.ts` (extend)

Run desktop test/tsc from inside `packages/desktop`.

**Context — current importRuns.ts filter (lines 50-57) and summary (89-97) are shown in Task 1 of the prior plan / the file itself.** The filter currently requires `TERMINAL.has(r.status)`; the sort key is `(b.finishedAt ?? 0) - (a.finishedAt ?? 0)` which sinks running runs (finishedAt null) to the bottom.

- [ ] **Step 1: Add `runStatus?` to SessionSummary (transcripts.ts)**

In `packages/desktop/src/renderer/transcripts.ts`, in the `SessionSummary` interface, after the existing `runId?: string;` field, add:
```typescript
  /** Run status at import time (e.g. "running" | "completed"). Lets the
   *  backfill dedup re-import a still-running import once it completes. */
  runStatus?: string;
```

- [ ] **Step 2: Write the failing test**

Add to `packages/desktop/src/renderer/automation/importRuns.test.ts` (the `run()` and `deps()` helpers already exist there; `run()` defaults `status:"completed"`, `finishedAt:1000`):
```typescript
  it("imports a running automation run (no terminal filter) and carries runStatus", async () => {
    const { d, imported } = deps();
    await importAutomationRuns(
      [run({ runId: "live", sessionId: "sess-live", status: "running", finishedAt: null })],
      repos,
      d,
    );
    expect(imported).toHaveLength(1);
  });

  it("still skips a run with no sessionId (e.g. queued)", async () => {
    const { d, imported } = deps();
    await importAutomationRuns(
      [run({ runId: "q", sessionId: null, status: "queued", finishedAt: null })],
      repos,
      d,
    );
    expect(imported).toHaveLength(0);
  });
```
Also extend the existing `deps()`/`writeImported` capture so the test can see `runStatus` — change the captured shape to also record `runStatus`. Find the `writeImported` in the test's `deps()` helper:
```typescript
    writeImported: (repoId, summary, _state) => { imported.push({ repoId, sessionId: summary.id }); },
```
and change the pushed object to include `runStatus: summary.runStatus`:
```typescript
    writeImported: (repoId, summary, _state) => { imported.push({ repoId, sessionId: summary.id, runStatus: summary.runStatus }); },
```
Then add an assertion in the running-import test:
```typescript
    expect(imported[0].runStatus).toBe("running");
```
(Update the local `imported` array's type annotation in `deps()` to include `runStatus?: string` so tsc is happy.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/desktop && bun test src/renderer/automation/importRuns.test.ts -t "running automation run"`
Expected: FAIL — the running run is filtered out by `TERMINAL.has(status)` (imported length 0), and `runStatus` is undefined.

- [ ] **Step 4: Implement**

In `packages/desktop/src/renderer/automation/importRuns.ts`:

(a) Delete the `TERMINAL` const (line 43) — it's no longer used here.

(b) Change the filter (lines 50-57) to drop the terminal check:
```typescript
  // 1. Filter: automation-sourced, has a sessionId, not already known.
  //    No terminal-status filter — a running run already has a sessionId once
  //    the engine emits session_started, and we want it in the sidebar live.
  //    (queued runs without a sessionId are excluded by the !!r.sessionId guard.)
  const candidates = runs.filter(
    (r) =>
      r.source === "automation" &&
      !!r.sessionId &&
      !deps.existingEngineSessionIds.has(r.sessionId),
  );
```

(c) Change the per-repo sort (line 81) so running runs (finishedAt null) rank by createdAt instead of sinking to 0:
```typescript
    list.sort(
      (a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt),
    );
```

(d) Add `runStatus: r.status` to the summary object (after `runId: r.runId,` at line 96):
```typescript
      const summary: SessionSummary = {
        id: r.sessionId as string, // engine sessionId doubles as the UI session id for imports
        title: (r.cronJobName || r.objective || "automation").slice(0, 60),
        createdAt: r.createdAt,
        updatedAt: r.finishedAt ?? r.createdAt,
        engineSessionId: r.sessionId as string,
        source: "automation",
        runId: r.runId,
        runStatus: r.status,
      };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/desktop && bun test src/renderer/automation/importRuns.test.ts`
Expected: all pass, including the new running-import + runStatus assertions and the existing 8 tests. (The existing "skips non-terminal or session-less runs" test asserted a `running` run is skipped — that test must be UPDATED: a running run WITH a sessionId now imports. Read that test; it currently passes `run({ status: "running" })` which defaults `sessionId:"sess-1"`. Change it so the "skip" case it still proves is the session-less one only, OR split it: keep the `sessionId: null` skip, and remove the now-incorrect `status:"running"` skip assertion. Make the test reflect the new contract: session-less skipped, running-with-session imported.)

- [ ] **Step 6: tsc**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/renderer/transcripts.ts packages/desktop/src/renderer/automation/importRuns.ts packages/desktop/src/renderer/automation/importRuns.test.ts
git commit -m "feat(desktop): import in-flight automation runs; carry runStatus

Drop the terminal-status filter so a running run (which now has a sessionId,
per the RunManager fix) shows in the sidebar live. Carry runStatus so the
backfill dedup can refresh a running import once it completes."
```

---

## Task 3: backfill dedup excludes still-running imports (desktop)

**Files:**
- Modify: `packages/desktop/src/renderer/App.tsx:502-512` (the `known` skip-set construction)

No new unit test (App.tsx wiring; verified by tsc + the importRuns unit tests that prove the refresh contract end-to-end at the data layer). The behavior: a session imported with a non-terminal `runStatus` must NOT be added to the dedup skip-set, so the next backfill re-imports and `upsertImportedSession` overwrites it in place.

**Context — current code at App.tsx:502-512:**
```typescript
      // Known engineSessionIds across every repo index (manual + already-imported).
      const currentRepos = loadRepos();
      const known = new Set<string>();
      for (const r of currentRepos) {
        for (const s of loadSessionIndex(r.id).sessions) {
          if (s.engineSessionId) known.add(s.engineSessionId);
        }
      }
      for (const s of loadSessionIndex(null).sessions) {
        if (s.engineSessionId) known.add(s.engineSessionId);
      }
```

- [ ] **Step 1: Implement — exclude still-running automation imports from the skip-set**

Add a terminal-status set near the top of the effect (just before building `known`), then gate the `known.add` calls. Replace the block above with:
```typescript
      // Known engineSessionIds across every repo index (manual + already-imported).
      // A still-running automation import is intentionally NOT counted, so the
      // next backfill re-imports it once it completes and upsertImportedSession
      // overwrites the partial transcript in place. Manual sessions and
      // completed/failed/cancelled imports dedupe normally.
      const TERMINAL_RUN = new Set(["completed", "failed", "cancelled"]);
      const dedupable = (s: SessionSummary): boolean =>
        s.source !== "automation" || !s.runStatus || TERMINAL_RUN.has(s.runStatus);
      const currentRepos = loadRepos();
      const known = new Set<string>();
      for (const r of currentRepos) {
        for (const s of loadSessionIndex(r.id).sessions) {
          if (s.engineSessionId && dedupable(s)) known.add(s.engineSessionId);
        }
      }
      for (const s of loadSessionIndex(null).sessions) {
        if (s.engineSessionId && dedupable(s)) known.add(s.engineSessionId);
      }
```
NOTE: `SessionSummary` is already imported as a type in App.tsx (added in the prior feature). If tsc complains it's not imported, add `type SessionSummary` to the `./transcripts` import block.

- [ ] **Step 2: tsc + renderer build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: clean; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): backfill — don't dedup still-running automation imports

A run imported while running must be re-importable once it completes, so the
half-written transcript snapshot is replaced by the full one. Exclude
non-terminal automation imports from the dedup skip-set."
```

---

## Task 4: Full verification

**Files:** none.

- [ ] **Step 1: Core RunManager tests**

Run: `bun test packages/core/src/run/RunManager.test.ts`
Expected: all pass.

- [ ] **Step 2: Desktop tests + tsc + build (own pipeline)**

Run: `cd packages/desktop && bun test && bunx tsc --noEmit && bun run build:renderer`
Expected: all pass; tsc clean; build ok (chunk-size advisory is pre-existing, not an error).

- [ ] **Step 3: Repo-wide tests + lint**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bun test && bun run lint`
Expected: no new failures; lint 0 errors (pre-existing warnings OK; remove any untracked `packages/desktop/.preview/` scratch first if it re-appears and trips no-undef).

- [ ] **Step 4: Manual end-to-end sanity (optional but recommended)**

With a cron job running: confirm `~/.code-shell/runs/<id>/run.json` now has a non-null `sessionId` while `status` is still `running` (was null before). Then open the desktop app and confirm the automation run appears in the sidebar under its cwd's project with the clock marker, and clicking it shows the transcript-so-far.

---

## Self-Review notes

- **Spec coverage:** Change 1 (RunManager early link) → Task 1; Change 2 part 1 (drop terminal filter + import in-flight) → Task 2; Change 2 part 2 (`runStatus` field) → Task 2; Change 2 part 3 (skip-set excludes running imports) → Task 3. Testing section → Tasks 1/2 unit tests + Task 4 e2e.
- **Plan-time lookup resolved:** the spec flagged "identify the exact persist call" — it's `this.store.update(run)` (used at RunManager.ts:259/337/347/534/547); the completion-link's sessionId is persisted by `store.update(current)` in finalize, so the early link adds its own `store.update(run)`. Accessors: `getOrThrow` (line 731), `emitRunEvent` (line 693), `checkpointWriter.setSessionId` (CheckpointWriter.ts:104).
- **Existing-test breakage flagged:** Task 2 Step 5 explicitly calls out that the existing importRuns test "skips non-terminal or session-less runs" asserted a running run is skipped — that assertion is now wrong and must be updated to the new contract (session-less skipped; running-with-session imported). Not silently left to fail.
- **Sort fix:** running runs (finishedAt null) would sort to the bottom of the per-repo cap; changed sort key to `finishedAt ?? createdAt` so they rank correctly. `createdAt` is always present on `ImportableRun`.
- **Idempotency:** completion-time link at RunManager.ts:477 becomes a no-op once early-linked → exactly one `session_linked` (asserted in Task 1 test).
- **Type consistency:** `runStatus?: string` on SessionSummary (Task 2) is read by App.tsx skip-set (Task 3) and set by importRuns (Task 2) — names match. `TERMINAL` removed from importRuns (Task 2); a separate `TERMINAL_RUN` introduced in App.tsx (Task 3) — distinct scopes, intentional.

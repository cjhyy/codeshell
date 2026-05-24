# Codex-grade Run Control & Recovery Design

> Date: 2026-05-24
> Status: Design approved by user direction
> Scope: Upgrade the existing CodeShell run system from record/display to control/recovery/audit semantics.

## 1. Goal

CodeShell already has managed runs: `RunManager`, `RunSnapshot`, events, checkpoints, approvals, artifact refs, filesystem storage under `~/.code-shell/runs/<runId>/`, and Electron run visibility. The next Codex-oriented iteration should not create a new run subsystem. It should make the existing one the product-grade control plane for coding work.

The goal is to make a run:

- controllable: cancel, resume, retry where safe, and later pause/continue;
- recoverable: crash or app restart can identify unfinished runs and reattach or mark them recoverable;
- reversible: record a baseline and expose rollback for the whole run first;
- auditable: persist diff, checkpoint, approval, tool, and test evidence so the final summary is grounded in artifacts;
- protocol-driven: TUI, Electron, future HTTP server, and SDKs use the same core API instead of reading run files directly.

## 2. Non-goals

This phase does not rebuild TUI, Electron, or the engine loop. It also does not introduce a complex planner/executor/tester/reviewer multi-agent workflow yet. That workflow should come after the run lifecycle can reliably represent control, recovery, and evidence.

This phase does not replace git or force all runs into isolated worktrees. It records enough repository state to make rollback safe, and leaves deeper worktree orchestration as a follow-up.

## 3. Existing baseline

Current code already provides much of the foundation:

- `packages/core/src/run/types.ts`
  - `RunStatus`: `queued`, `running`, `waiting_input`, `waiting_approval`, `blocked`, `completed`, `failed`, `cancelled`.
  - `RunSnapshot`, `RunEvent`, `RunCheckpoint`, `RunApproval`, `RunArtifactRef`.
  - `ResumeRunInput`, `ListRunsQuery`, `RunStreamEvent`, state transition table.
- `packages/core/src/run/RunManager.ts`
  - `submit`, `start`, `resume`, `cancel`, attach/stream, lifecycle transitions, approval/input coordination.
  - heartbeat, locks, checkpoint writer, evaluator hooks.
- `packages/core/src/run/FileRunStore.ts`
  - `run.json`, `events.jsonl`, `checkpoints/`, `approvals/`, `artifacts/refs.jsonl`.
- `packages/core/src/protocol/types.ts`
  - UI agent protocol has `agent/run`, `agent/approve`, `agent/cancel`, `agent/configure`, `agent/query`, `agent/inject`.

The main gap is not data existence. The gap is that product clients still do not have a first-class run-control protocol and the stored run data does not yet consistently encode repository baseline, diff outcome, test evidence, crash recovery status, or rollback results.

## 4. Target model

A CodeShell coding run should have this lifecycle:

```text
created → queued → running
                 ↘ waiting_input → resumed → running
                 ↘ waiting_approval → resumed → running
                 ↘ blocked/recoverable → resumed → running
                 ↘ completed
                 ↘ failed
                 ↘ cancelled
                 ↘ rolled_back
```

The existing state machine can remain mostly intact for phase 1. `rolled_back` can be represented initially as terminal metadata and a `run_rolled_back` event, then promoted to a first-class status if UI and query ergonomics require it.

A run should persist these additional semantics:

- `control`: whether current state allows cancel, resume, retry, rollback;
- `recovery`: heartbeat/lock status, last known active process, stale reason, recoverability;
- `repoBaseline`: cwd, git root, branch, HEAD, dirty state, untracked snapshot summary;
- `changeSet`: final or current diff summary, changed files, insertions/deletions, patch artifact path;
- `evidence`: test/lint/typecheck commands, exit code, duration, stdout/stderr summaries, artifact locators;
- `rollback`: strategy used, status, resulting git state, errors if any.

These can start inside `RunSnapshot.metadata` for compatibility, but should be surfaced through typed helpers and protocol result types so clients do not depend on metadata keys forever.

## 5. Core API design

### 5.1 RunManager additions

Extend the existing manager rather than adding a parallel service:

- `list(query?: ListRunsQuery): Promise<RunSnapshot[]>`
- `get(runId: string): Promise<RunSnapshot | null>`
- `getDetail(runId: string): Promise<RunDetail>`
- `cancel(runId: string, reason?: string): Promise<void>` already exists and should become protocol-backed.
- `resume(runId: string, input?: ResumeRunInput): Promise<void>` already exists and should become protocol-backed.
- `recover(runId: string): Promise<RunSnapshot>` for stale running/blocked runs.
- `rollback(runId: string, options?: RollbackRunOptions): Promise<RollbackRunResult>`.
- `recordEvidence(runId: string, evidence: RunEvidenceInput): Promise<void>`.
- `recordRepoSnapshot(runId: string, phase: "baseline" | "current" | "final"): Promise<void>`.

`RunDetail` should combine snapshot, events, latest checkpoint, pending approval, artifact refs, evidence, baseline, diff, and computed control actions.

### 5.2 Control action computation

Clients should not duplicate lifecycle rules. Core should return allowed actions:

```ts
type RunControlAction =
  | "cancel"
  | "resume"
  | "retry"
  | "recover"
  | "rollback"
  | "openDiff"
  | "viewEvidence";
```

Rules:

- `queued` and `running`: allow `cancel`.
- `waiting_input`, `waiting_approval`, `blocked`: allow `resume`, `cancel`; allow `recover` if no active handle and heartbeat is stale.
- `failed` and `cancelled`: allow `retry` only if the run has enough objective/cwd/preset data; allow `rollback` if changes exist.
- `completed`: allow `rollback` if changes exist; allow `viewEvidence` if evidence exists.

### 5.3 Recovery semantics

Recovery should be conservative:

1. On manager startup, scan non-terminal runs.
2. Use lock and heartbeat to distinguish active vs stale.
3. For stale `running`, transition to `blocked` with reason `stale_heartbeat` and emit `run_recovery_detected`.
4. `recover(runId)` requeues from the latest checkpoint or from the original objective if checkpoint resume is not available.
5. The resumed prompt must include previous summary/checkpoint and explicit instruction not to duplicate already completed work.

If exact continuation is impossible, recovery should be honest: mark the run `blocked` with a recoverable reason and require user-driven resume.

## 6. Repository state and rollback

### 6.1 Baseline capture

At run start, record:

- cwd and resolved git root;
- branch name;
- HEAD SHA;
- whether working tree was dirty;
- list of modified/untracked files summary;
- optional initial patch artifact if dirty.

Dirty baseline matters because rollback must not erase user changes that existed before the run.

### 6.2 Change tracking

At checkpoints and terminal states, record:

- changed file list;
- insertions/deletions summary;
- diff patch artifact under the run directory;
- whether changes overlap with pre-existing dirty files.

The first implementation can use git commands behind a focused helper. It should not expose shell details to clients.

### 6.3 Rollback strategy

Phase 1 rollback should be whole-run and conservative:

- If baseline was clean: apply reverse patch or restore files to baseline HEAD where safe.
- If baseline was dirty: only rollback hunks/files confidently attributed to the run; otherwise refuse with a clear conflict result.
- If conflicts exist: return `requires_manual_resolution` and preserve artifacts.

Do not use destructive `git reset --hard` as a default. That would risk deleting user work. Rollback should prefer patch-based reversal and explicit conflict reporting.

## 7. Evidence model

A Codex-grade run should not merely say “tests passed.” It should store evidence.

Introduce typed evidence records:

```ts
interface RunEvidence {
  evidenceId: string;
  runId: string;
  kind: "test" | "lint" | "typecheck" | "build" | "manual" | "custom";
  command?: string;
  cwd: string;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  status: "passed" | "failed" | "skipped" | "unknown";
  stdoutSummary?: string;
  stderrSummary?: string;
  artifactRefs: string[];
  metadata: Record<string, unknown>;
}
```

Storage can be `evidence/<id>.json` plus optional stdout/stderr artifacts. Existing `Evaluator` can produce these records on completion, and tool execution can later auto-record shell commands that look like tests/builds.

Final assistant summaries and UI run detail should reference evidence records rather than plain text claims.

## 8. Protocol design

The existing `agent/run` protocol is session-oriented and good for chat execution. Add managed-run methods rather than overloading chat methods:

```text
run/list
run/get
run/submit
run/cancel
run/resume
run/recover
run/rollback
run/attach
```

Recommended phase 1 protocol:

- `run/list`: returns snapshots plus computed controls.
- `run/get`: returns `RunDetail`.
- `run/submit`: creates a managed run and returns snapshot.
- `run/cancel`: calls `RunManager.cancel`.
- `run/resume`: calls `RunManager.resume`.
- `run/recover`: calls `RunManager.recover`.
- `run/rollback`: calls `RunManager.rollback`.
- `run/attach`: subscribes to `RunStreamEvent` notifications for a run.

A compatibility path may keep Electron reading `~/.code-shell/runs` for one release, but the target is protocol-only access.

## 9. UI integration

### 9.1 Electron

Electron should stop treating Runs as read-only files once protocol methods exist.

Runs dashboard should display:

- status and allowed actions;
- latest checkpoint;
- pending approval/input;
- changed files and diff artifact;
- evidence cards;
- recovery warnings;
- rollback result.

Buttons should call core protocol methods: cancel, resume, recover, rollback. UI should not infer unsafe actions itself.

### 9.2 TUI

TUI can start smaller:

- show current managed run id/status in the status area;
- expose command or tool path to list/get/cancel/resume runs;
- render recovery/rollback outcomes in text form.

The TUI should not need a visual dashboard in phase 1.

## 10. Error handling and safety

All run control methods should return structured errors:

- `RunNotFound`
- `InvalidRunState`
- `RunStillActive`
- `RunNotRecoverable`
- `RollbackUnsafe`
- `RollbackConflict`
- `EvidenceArtifactMissing`
- `StoreCorrupt`

Rollback must be safety-first. If attribution is uncertain, refuse and explain what artifact to inspect. The design should never make `git reset --hard` the implicit rollback path.

Crash recovery must avoid double-running by checking active locks and heartbeat before requeueing.

## 11. Testing strategy

Use Bun tests around the run package first.

Core tests:

- state transition and allowed action computation;
- protocol parameter/result typing where practical;
- stale heartbeat detection;
- cancelled active run aborts execution and records event;
- resume waiting approval/input persists decision and requeues or continues;
- baseline capture on clean and dirty repositories;
- rollback clean baseline success;
- rollback dirty baseline conflict/refusal;
- evidence persistence and retrieval;
- `RunDetail` composes snapshot/events/checkpoints/evidence/artifacts.

Integration tests:

- submit managed run, attach stream, cancel, verify terminal state;
- simulate process restart by creating stale running run and calling recovery scan;
- Electron can be tested later with renderer-level mocks once protocol exists.

## 12. Phased implementation plan shape

This design should be implemented in small phases:

1. **Run detail and control protocol**
   - expose list/get/submit/cancel/resume through protocol;
   - compute allowed actions in core;
   - update clients to call protocol for control.

2. **Recovery hardening**
   - startup scan for non-terminal runs;
   - stale heartbeat detection;
   - blocked/recoverable state metadata;
   - recover method.

3. **Repo baseline and diff artifacts**
   - git state helper;
   - baseline capture;
   - terminal diff artifact;
   - changed file summary.

4. **Evidence records**
   - evidence storage;
   - evaluator writes evidence;
   - UI displays evidence.

5. **Rollback**
   - conservative whole-run rollback;
   - conflict reporting;
   - rollback events and result detail.

6. **Client polish**
   - Electron action buttons;
   - TUI run commands/status;
   - remove direct file reads where protocol is available.

## 13. Success criteria

The iteration is successful when:

- a managed run can be submitted, listed, inspected, cancelled, and resumed through core protocol;
- stale unfinished runs are detected and surfaced as recoverable/blocked, not silently left as running;
- each coding run records baseline and final diff summary;
- test/build/lint evidence can be persisted and shown in run detail;
- rollback exists for safe whole-run cases and refuses unsafe cases with a clear conflict result;
- Electron and TUI consume the same run-control API for the supported actions.

## 14. Follow-ups

After this lifecycle is stable, the next Codex-oriented iterations should be:

1. coding workflow preset: planner/executor/tester/reviewer on top of managed runs;
2. richer Electron run experience: step timeline, diff/evidence inspector, rollback previews;
3. HTTP server and SDK methods for the same run protocol;
4. Arena-backed review evidence as a first-class run artifact.

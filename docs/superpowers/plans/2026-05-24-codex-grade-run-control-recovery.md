# Codex-grade Run Control & Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing managed run system into a Codex-grade control and recovery layer with protocol access, detail views, evidence, repo baseline/diff metadata, and conservative rollback.

**Architecture:** Reuse the existing `RunManager`, `FileRunStore`, and `RunSnapshot` model. Add small focused modules for run controls, detail composition, evidence persistence, git state capture, and rollback safety; expose them through protocol methods so Electron/TUI/future SDK clients do not read run files directly.

**Tech Stack:** TypeScript, Bun test runner, existing CodeShell core packages, JSON-RPC protocol layer, filesystem run store, local git CLI through focused helpers.

---

## File Structure

Create:

- `packages/core/src/run/controlActions.ts` — computes allowed run actions from snapshot/detail metadata.
- `packages/core/src/run/detail.ts` — composes `RunDetail` from store data.
- `packages/core/src/run/evidence.ts` — evidence types and helpers.
- `packages/core/src/run/GitRunState.ts` — safe git baseline/diff helper.
- `packages/core/src/run/rollback.ts` — conservative whole-run rollback planning/execution.
- `tests/run-control-actions.test.ts`
- `tests/run-detail.test.ts`
- `tests/run-evidence.test.ts`
- `tests/run-git-state.test.ts`
- `tests/run-rollback.test.ts`
- `tests/protocol-run-control.test.ts`

Modify:

- `packages/core/src/run/types.ts` — export typed metadata/detail/evidence/control types.
- `packages/core/src/run/RunStore.ts` — add evidence and artifact/detail support methods only where needed.
- `packages/core/src/run/FileRunStore.ts` — persist evidence under `evidence/<id>.json` and expose detail data.
- `packages/core/src/run/RunManager.ts` — add `getDetail`, `recordEvidence`, `recordRepoSnapshot`, `rollbackRun`, and harden recovery metadata.
- `packages/core/src/run/index.ts` and `packages/core/src/index.ts` — export new public types/helpers.
- `packages/core/src/protocol/types.ts` — add `run/list`, `run/get`, `run/submit`, `run/cancel`, `run/resume`, `run/recover`, `run/rollback` methods and params/results.
- `packages/core/src/protocol/server.ts` — optionally accepts a `RunManager`; dispatch run-control methods.
- `packages/core/src/protocol/client.ts` — add typed run-control client methods.

---

## Task 1: Control action computation

**Files:**
- Create: `packages/core/src/run/controlActions.ts`
- Modify: `packages/core/src/run/types.ts`
- Modify: `packages/core/src/run/index.ts`
- Test: `tests/run-control-actions.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/run-control-actions.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { getRunControlActions } from "../packages/core/src/run/controlActions.js";
import type { RunSnapshot } from "../packages/core/src/run/types.js";

function makeRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    objective: "Test run",
    preset: "terminal-coding",
    cwd: "/tmp/project",
    status: "queued",
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: null,
    finishedAt: null,
    parentRunId: null,
    sessionId: null,
    childSessionIds: [],
    attemptCount: 0,
    latestCheckpointId: null,
    latestApprovalId: null,
    summary: null,
    error: null,
    tags: [],
    metadata: {},
    ...overrides,
  };
}

describe("getRunControlActions", () => {
  it("allows cancel for queued and running runs", () => {
    expect(getRunControlActions(makeRun({ status: "queued" }))).toContain("cancel");
    expect(getRunControlActions(makeRun({ status: "running" }))).toContain("cancel");
  });

  it("allows resume and cancel for waiting runs", () => {
    const actions = getRunControlActions(makeRun({ status: "waiting_approval" }));
    expect(actions).toContain("resume");
    expect(actions).toContain("cancel");
  });

  it("allows recover when metadata marks a blocked run recoverable", () => {
    const actions = getRunControlActions(
      makeRun({ status: "blocked", metadata: { recovery: { recoverable: true } } }),
    );
    expect(actions).toContain("recover");
  });

  it("allows rollback for terminal runs with a recorded change set", () => {
    const actions = getRunControlActions(
      makeRun({ status: "completed", metadata: { changeSet: { changedFiles: ["src/a.ts"] } } }),
    );
    expect(actions).toContain("rollback");
    expect(actions).toContain("openDiff");
  });

  it("allows viewEvidence when evidence metadata exists", () => {
    const actions = getRunControlActions(
      makeRun({ status: "completed", metadata: { evidence: { count: 1 } } }),
    );
    expect(actions).toContain("viewEvidence");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/run-control-actions.test.ts
```

Expected: FAIL because `packages/core/src/run/controlActions.ts` does not exist.

- [ ] **Step 3: Add types and implementation**

In `packages/core/src/run/types.ts`, add:

```ts
export type RunControlAction =
  | "cancel"
  | "resume"
  | "retry"
  | "recover"
  | "rollback"
  | "openDiff"
  | "viewEvidence";

export interface RunRecoveryMetadata {
  recoverable: boolean;
  reason?: string;
  detectedAt?: number;
}

export interface RunChangeSetMetadata {
  changedFiles: string[];
  insertions?: number;
  deletions?: number;
  patchArtifactPath?: string;
  hasConflictsWithBaseline?: boolean;
}

export interface RunEvidenceSummaryMetadata {
  count: number;
  failedCount?: number;
  passedCount?: number;
}

export interface RunLifecycleMetadata {
  recovery?: RunRecoveryMetadata;
  changeSet?: RunChangeSetMetadata;
  evidence?: RunEvidenceSummaryMetadata;
  rollback?: Record<string, unknown>;
  repoBaseline?: Record<string, unknown>;
}
```

Create `packages/core/src/run/controlActions.ts`:

```ts
import type { RunControlAction, RunLifecycleMetadata, RunSnapshot } from "./types.js";

function lifecycleMetadata(run: RunSnapshot): RunLifecycleMetadata {
  return (run.metadata ?? {}) as RunLifecycleMetadata;
}

function hasChanges(run: RunSnapshot): boolean {
  const metadata = lifecycleMetadata(run);
  return Array.isArray(metadata.changeSet?.changedFiles) && metadata.changeSet.changedFiles.length > 0;
}

function hasEvidence(run: RunSnapshot): boolean {
  const metadata = lifecycleMetadata(run);
  return typeof metadata.evidence?.count === "number" && metadata.evidence.count > 0;
}

export function getRunControlActions(run: RunSnapshot): RunControlAction[] {
  const actions = new Set<RunControlAction>();
  const metadata = lifecycleMetadata(run);

  if (run.status === "queued" || run.status === "running") actions.add("cancel");

  if (run.status === "waiting_input" || run.status === "waiting_approval" || run.status === "blocked") {
    actions.add("resume");
    actions.add("cancel");
  }

  if (metadata.recovery?.recoverable) actions.add("recover");

  if (run.status === "failed" || run.status === "cancelled") {
    if (run.objective && run.cwd) actions.add("retry");
  }

  if ((run.status === "completed" || run.status === "failed" || run.status === "cancelled") && hasChanges(run)) {
    actions.add("rollback");
    actions.add("openDiff");
  }

  if (hasEvidence(run)) actions.add("viewEvidence");

  return [...actions];
}
```

In `packages/core/src/run/index.ts`, export it:

```ts
export { getRunControlActions } from "./controlActions.js";
export type {
  RunControlAction,
  RunLifecycleMetadata,
  RunRecoveryMetadata,
  RunChangeSetMetadata,
  RunEvidenceSummaryMetadata,
} from "./types.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/run-control-actions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/run/types.ts packages/core/src/run/controlActions.ts packages/core/src/run/index.ts tests/run-control-actions.test.ts
git commit -m "feat: add run control action computation"
```

---

## Task 2: Run detail composition

**Files:**
- Create: `packages/core/src/run/detail.ts`
- Modify: `packages/core/src/run/types.ts`
- Modify: `packages/core/src/run/RunManager.ts`
- Modify: `packages/core/src/run/index.ts`
- Test: `tests/run-detail.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/run-detail.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileRunStore } from "../packages/core/src/run/FileRunStore.js";
import { getRunDetail } from "../packages/core/src/run/detail.js";
import type { RunSnapshot, RunEvent, RunCheckpoint, RunApproval, RunArtifactRef } from "../packages/core/src/run/types.js";

function makeRun(): RunSnapshot {
  return {
    runId: "run-detail-1",
    objective: "Detail test",
    preset: "terminal-coding",
    cwd: "/tmp/project",
    status: "waiting_approval",
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: null,
    finishedAt: null,
    parentRunId: null,
    sessionId: null,
    childSessionIds: [],
    attemptCount: 0,
    latestCheckpointId: "cp-1",
    latestApprovalId: "appr-1",
    summary: null,
    error: null,
    tags: [],
    metadata: {},
  };
}

describe("getRunDetail", () => {
  let tmpDir: string;
  let store: FileRunStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "run-detail-"));
    store = new FileRunStore(tmpDir);
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("composes snapshot, events, checkpoint, approval, artifacts, and controls", async () => {
    const run = makeRun();
    await store.create(run);

    const event: RunEvent = { eventId: "evt-1", runId: run.runId, type: "run_created", timestamp: 1000, data: {} };
    await store.appendEvent(event);

    const checkpoint: RunCheckpoint = {
      checkpointId: "cp-1",
      runId: run.runId,
      createdAt: 1100,
      phase: "final",
      objective: run.objective,
      summary: "checkpoint summary",
      nextAction: null,
      linkedSessionId: null,
      touchedTools: ["Read"],
      touchedArtifacts: [],
      waitingFor: null,
      evaluator: null,
      metadata: {},
    };
    await store.saveCheckpoint(checkpoint);

    const approval: RunApproval = {
      approvalId: "appr-1",
      runId: run.runId,
      createdAt: 1200,
      resolvedAt: null,
      status: "pending",
      category: "tool",
      title: "Approve Bash",
      description: "Run command",
      payload: {},
    };
    await store.saveApproval(approval);

    const artifact: RunArtifactRef = {
      artifactId: "art-1",
      runId: run.runId,
      kind: "file",
      role: "output",
      path: "artifact.txt",
      createdAt: 1300,
      metadata: {},
    };
    await store.appendArtifactRef(artifact);

    const detail = await getRunDetail(store, run.runId);
    expect(detail.snapshot.runId).toBe(run.runId);
    expect(detail.events).toHaveLength(1);
    expect(detail.latestCheckpoint?.checkpointId).toBe("cp-1");
    expect(detail.pendingApproval?.approvalId).toBe("appr-1");
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.controls).toContain("resume");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/run-detail.test.ts
```

Expected: FAIL because `detail.ts` does not exist.

- [ ] **Step 3: Add detail type and helper**

In `packages/core/src/run/types.ts`, add:

```ts
export interface RunDetail {
  snapshot: RunSnapshot;
  events: RunEvent[];
  latestCheckpoint: RunCheckpoint | null;
  pendingApproval: RunApproval | null;
  artifacts: RunArtifactRef[];
  controls: RunControlAction[];
}
```

Create `packages/core/src/run/detail.ts`:

```ts
import type { RunStore } from "./RunStore.js";
import { getRunControlActions } from "./controlActions.js";
import type { RunDetail } from "./types.js";

export async function getRunDetail(store: RunStore, runId: string): Promise<RunDetail> {
  const snapshot = await store.get(runId);
  if (!snapshot) throw new Error(`Run not found: ${runId}`);

  const [events, latestCheckpoint, pendingApproval, artifacts] = await Promise.all([
    store.listEvents(runId),
    store.getLatestCheckpoint(runId),
    store.getPendingApproval(runId),
    store.listArtifactRefs(runId),
  ]);

  return {
    snapshot,
    events,
    latestCheckpoint,
    pendingApproval,
    artifacts,
    controls: getRunControlActions(snapshot),
  };
}
```

In `RunManager.ts`, add a public method near query methods:

```ts
async getDetail(runId: string): Promise<RunDetail> {
  return getRunDetail(this.store, runId);
}
```

Also import `getRunDetail` and `RunDetail`.

In `packages/core/src/run/index.ts`, export:

```ts
export { getRunDetail } from "./detail.js";
export type { RunDetail } from "./types.js";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/run-detail.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/run/types.ts packages/core/src/run/detail.ts packages/core/src/run/RunManager.ts packages/core/src/run/index.ts tests/run-detail.test.ts
git commit -m "feat: compose managed run details"
```

---

## Task 3: Evidence persistence

**Files:**
- Create: `packages/core/src/run/evidence.ts`
- Modify: `packages/core/src/run/types.ts`
- Modify: `packages/core/src/run/RunStore.ts`
- Modify: `packages/core/src/run/FileRunStore.ts`
- Modify: `packages/core/src/run/RunManager.ts`
- Modify: `packages/core/src/run/detail.ts`
- Test: `tests/run-evidence.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/run-evidence.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileRunStore } from "../packages/core/src/run/FileRunStore.js";
import type { RunEvidence, RunSnapshot } from "../packages/core/src/run/types.js";

function makeRun(): RunSnapshot {
  return {
    runId: "run-evidence-1",
    objective: "Evidence test",
    preset: "terminal-coding",
    cwd: "/tmp/project",
    status: "completed",
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: null,
    finishedAt: null,
    parentRunId: null,
    sessionId: null,
    childSessionIds: [],
    attemptCount: 0,
    latestCheckpointId: null,
    latestApprovalId: null,
    summary: null,
    error: null,
    tags: [],
    metadata: {},
  };
}

describe("Run evidence persistence", () => {
  let tmpDir: string;
  let store: FileRunStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "run-evidence-"));
    store = new FileRunStore(tmpDir);
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("saves and lists evidence records", async () => {
    await store.create(makeRun());
    const evidence: RunEvidence = {
      evidenceId: "ev-1",
      runId: "run-evidence-1",
      kind: "test",
      command: "bun test tests/run-evidence.test.ts",
      cwd: "/tmp/project",
      startedAt: 1000,
      finishedAt: 2000,
      exitCode: 0,
      status: "passed",
      stdoutSummary: "1 pass",
      stderrSummary: "",
      artifactRefs: [],
      metadata: {},
    };

    await store.saveEvidence(evidence);
    const records = await store.listEvidence("run-evidence-1");
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(evidence);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/run-evidence.test.ts
```

Expected: FAIL because `RunEvidence`, `saveEvidence`, and `listEvidence` do not exist.

- [ ] **Step 3: Add evidence types and store methods**

In `types.ts`, add `RunEvidenceKind`, `RunEvidenceStatus`, `RunEvidence`, and `RunEvidenceInput` matching the design spec.

In `RunStore.ts`, add:

```ts
saveEvidence(evidence: RunEvidence): Promise<void>;
listEvidence(runId: string): Promise<RunEvidence[]>;
```

In `FileRunStore.ts`, implement evidence persistence under `<runDir>/evidence/<evidenceId>.json`. Use existing JSON helper patterns already present in the file.

In `detail.ts`, include `evidence: RunEvidence[]` in `RunDetail` and load it with `store.listEvidence(runId)`.

In `RunManager.ts`, add:

```ts
async recordEvidence(evidence: RunEvidence): Promise<void> {
  await this.store.saveEvidence(evidence);
  const run = await this.getOrThrow(evidence.runId);
  const existing = (run.metadata.evidence as { count?: number; passedCount?: number; failedCount?: number } | undefined) ?? {};
  run.metadata.evidence = {
    count: (existing.count ?? 0) + 1,
    passedCount: (existing.passedCount ?? 0) + (evidence.status === "passed" ? 1 : 0),
    failedCount: (existing.failedCount ?? 0) + (evidence.status === "failed" ? 1 : 0),
  };
  run.updatedAt = Date.now();
  await this.store.update(run);
  await this.emitRunEvent(evidence.runId, "artifact_recorded", {
    kind: "evidence",
    evidenceId: evidence.evidenceId,
    status: evidence.status,
  });
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/run-evidence.test.ts tests/run-detail.test.ts tests/run-control-actions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/run/types.ts packages/core/src/run/evidence.ts packages/core/src/run/RunStore.ts packages/core/src/run/FileRunStore.ts packages/core/src/run/RunManager.ts packages/core/src/run/detail.ts tests/run-evidence.test.ts tests/run-detail.test.ts
git commit -m "feat: persist run evidence records"
```

---

## Task 4: Protocol run-control methods

**Files:**
- Modify: `packages/core/src/protocol/types.ts`
- Modify: `packages/core/src/protocol/server.ts`
- Modify: `packages/core/src/protocol/client.ts`
- Test: `tests/protocol-run-control.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/protocol-run-control.test.ts` with capture-transport tests for `AgentClient.listRuns`, `AgentClient.getRun`, `AgentClient.cancelRun`, `AgentClient.resumeRun`, `AgentClient.recoverRun`, and `AgentClient.rollbackRun`. Assert method strings are `run/list`, `run/get`, `run/cancel`, `run/resume`, `run/recover`, `run/rollback` and params contain `runId` where required.

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/protocol-run-control.test.ts
```

Expected: FAIL because client methods and method constants do not exist.

- [ ] **Step 3: Add protocol types and client methods**

In `Methods`, add:

```ts
RunList: "run/list",
RunGet: "run/get",
RunSubmit: "run/submit",
RunCancel: "run/cancel",
RunResume: "run/resume",
RunRecover: "run/recover",
RunRollback: "run/rollback",
```

Add params/results interfaces using `RunSnapshot`, `RunDetail`, `SubmitRunInput`, `ResumeRunInput`, `ListRunsQuery`.

In `AgentClient`, add methods:

```ts
listRuns(query?: ListRunsQuery): Promise<RunSnapshot[]>;
getRun(runId: string): Promise<RunDetail>;
submitRun(input: SubmitRunInput): Promise<RunSnapshot>;
cancelRun(runId: string, reason?: string): Promise<void>;
resumeRun(runId: string, input?: ResumeRunInput): Promise<void>;
recoverRun(runId?: string): Promise<string[] | RunSnapshot>;
rollbackRun(runId: string): Promise<RollbackRunResult>;
```

- [ ] **Step 4: Add server dispatch**

Change `AgentServerOptions` to accept `runManager?: RunManager`. In `handleRequest`, dispatch run methods to new private handlers. If `runManager` is missing, return `ErrorCodes.InvalidRequest` with message `Run manager is not configured`.

Handlers call existing `runManager.list/getDetail/submit/cancel/resume/recover` plus rollback once Task 6 adds it. Until Task 6, `run/rollback` can return method-not-ready only if tests do not exercise server rollback.

- [ ] **Step 5: Run protocol tests**

```bash
bun test tests/protocol-run-control.test.ts tests/protocol-client-query.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/protocol/types.ts packages/core/src/protocol/server.ts packages/core/src/protocol/client.ts tests/protocol-run-control.test.ts
git commit -m "feat: expose managed run control protocol"
```

---

## Task 5: Git baseline and diff metadata

**Files:**
- Create: `packages/core/src/run/GitRunState.ts`
- Modify: `packages/core/src/run/types.ts`
- Modify: `packages/core/src/run/RunManager.ts`
- Test: `tests/run-git-state.test.ts`

- [ ] **Step 1: Write failing tests**

Create tests that initialize a temp git repo, commit `file.txt`, call `captureRepoBaseline(repoDir)`, modify `file.txt`, then call `captureRunChangeSet(repoDir, baseline)`. Assert baseline has `head`, `branch`, `dirty === false`, and change set includes `file.txt`.

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/run-git-state.test.ts
```

Expected: FAIL because `GitRunState.ts` does not exist.

- [ ] **Step 3: Implement git helper**

Create `GitRunState.ts` using `Bun.spawn` or `child_process.execFile` with `git -C <cwd> ...`. Implement:

```ts
export async function captureRepoBaseline(cwd: string): Promise<RunRepoBaseline>;
export async function captureRunChangeSet(cwd: string, baseline?: RunRepoBaseline): Promise<RunChangeSetMetadata>;
```

Use:

- `git rev-parse --show-toplevel`
- `git rev-parse HEAD`
- `git branch --show-current`
- `git status --porcelain`
- `git diff --numstat`
- `git diff --name-only`

Return `isGitRepo: false` metadata instead of throwing when cwd is not a git repo.

- [ ] **Step 4: Wire terminal diff capture**

In `RunManager.executeRun`, after final checkpoint/evaluator and before terminal update, call `captureRunChangeSet(current.cwd)` and store it in `current.metadata.changeSet`. In `submit`, capture `repoBaseline` before create when possible.

- [ ] **Step 5: Run tests**

```bash
bun test tests/run-git-state.test.ts tests/run-manager.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/run/GitRunState.ts packages/core/src/run/types.ts packages/core/src/run/RunManager.ts tests/run-git-state.test.ts
git commit -m "feat: record run git baseline and diff metadata"
```

---

## Task 6: Conservative rollback

**Files:**
- Create: `packages/core/src/run/rollback.ts`
- Modify: `packages/core/src/run/types.ts`
- Modify: `packages/core/src/run/RunManager.ts`
- Modify: `packages/core/src/protocol/server.ts`
- Test: `tests/run-rollback.test.ts`

- [ ] **Step 1: Write failing tests**

Create a temp clean git repo, commit `file.txt`, modify it to simulate run changes, save a completed `RunSnapshot` with `metadata.repoBaseline` and `metadata.changeSet.changedFiles = ["file.txt"]`, call `rollbackRunChanges(run)`, and assert file content returns to committed content. Add a dirty-baseline test where `repoBaseline.dirty === true` and assert rollback returns `status: "requires_manual_resolution"`.

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/run-rollback.test.ts
```

Expected: FAIL because `rollback.ts` does not exist.

- [ ] **Step 3: Implement rollback helper**

Create `rollback.ts` with:

```ts
export interface RollbackRunOptions { dryRun?: boolean }
export interface RollbackRunResult {
  runId: string;
  status: "rolled_back" | "requires_manual_resolution" | "unsafe";
  changedFiles: string[];
  message: string;
}
export async function rollbackRunChanges(run: RunSnapshot, options?: RollbackRunOptions): Promise<RollbackRunResult>;
```

Rules:

- If no `changeSet.changedFiles`, return `unsafe`.
- If `repoBaseline.dirty === true`, return `requires_manual_resolution`.
- If clean baseline and not dry run, run `git -C cwd checkout <head> -- <changedFiles...>`.
- Never run `git reset --hard`.

- [ ] **Step 4: Wire RunManager and protocol**

Add `RunManager.rollbackRun(runId, options)` that loads run, calls `rollbackRunChanges`, writes `metadata.rollback`, emits `run_rolled_back` using a new event type or existing generic event if type widening is required, updates snapshot, and returns result.

Update protocol server `run/rollback` handler to call it.

- [ ] **Step 5: Run tests**

```bash
bun test tests/run-rollback.test.ts tests/protocol-run-control.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/run/rollback.ts packages/core/src/run/types.ts packages/core/src/run/RunManager.ts packages/core/src/protocol/server.ts tests/run-rollback.test.ts
git commit -m "feat: add conservative run rollback"
```

---

## Task 7: Recovery metadata hardening

**Files:**
- Modify: `packages/core/src/run/RunManager.ts`
- Test: `tests/run-manager.test.ts`

- [ ] **Step 1: Add failing test**

In `tests/run-manager.test.ts`, add a recovery test that creates a running run with stale heartbeat conditions, calls `manager.recover()`, and asserts the snapshot metadata contains `recovery.detectedAt`, `recovery.reason`, and `recovery.recoverable` when the run is blocked after max attempts.

- [ ] **Step 2: Run focused test**

```bash
bun test tests/run-manager.test.ts -t recovery
```

Expected: FAIL because metadata is not populated.

- [ ] **Step 3: Implement metadata updates**

In `RunManager.recover()`, when a stale run is detected, set:

```ts
run.metadata.recovery = {
  recoverable: run.attemptCount < 3,
  reason: stale ? "stale_heartbeat" : "process_dead",
  detectedAt: Date.now(),
};
```

When blocked after max attempts, keep `recoverable: false` and include `reason: "max_recovery_attempts"`.

- [ ] **Step 4: Run test**

```bash
bun test tests/run-manager.test.ts -t recovery
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/run/RunManager.ts tests/run-manager.test.ts
git commit -m "feat: record run recovery metadata"
```

---

## Task 8: Final verification

**Files:**
- Modify only if previous tasks reveal export or type issues.

- [ ] **Step 1: Run focused test suite**

```bash
bun test tests/run-control-actions.test.ts tests/run-detail.test.ts tests/run-evidence.test.ts tests/protocol-run-control.test.ts tests/run-git-state.test.ts tests/run-rollback.test.ts tests/run-manager.test.ts tests/run-store.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run lint on packages**

```bash
bun run lint
```

Expected: PASS or only unrelated pre-existing issues. If failures are caused by changed files, fix them.

- [ ] **Step 3: Run typecheck for changed surface**

```bash
bun run typecheck
```

Expected: May show pre-existing repo errors per `CODESHELL.md`; inspect errors and fix any caused by run/protocol changes.

- [ ] **Step 4: Commit final cleanup if needed**

```bash
git add packages/core/src/run packages/core/src/protocol tests
git commit -m "chore: verify run control recovery integration"
```

Only commit if there are actual cleanup changes.

---

## Self-review

Spec coverage:

- Protocol access: Tasks 4 and 6.
- Run detail and computed controls: Tasks 1 and 2.
- Evidence persistence: Task 3.
- Repo baseline and diff metadata: Task 5.
- Conservative rollback: Task 6.
- Recovery metadata: Task 7.
- Verification: Task 8.

No known placeholders remain. The plan intentionally defers multi-agent coding workflow and rich Electron UI polish because the design marked those as follow-ups after lifecycle stability.

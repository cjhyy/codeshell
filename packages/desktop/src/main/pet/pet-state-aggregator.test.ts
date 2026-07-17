import { describe, expect, test } from "bun:test";
import type {
  PetProjectionDelta,
  PetProjectionSnapshotResult,
  PetSessionProjection,
} from "@cjhyy/code-shell-core";
import type { DiskSessionMeta, ListDiskSessionsResult } from "@cjhyy/code-shell-server/storage";
import {
  PetStateAggregator,
  type AgentBridgePetEvent,
  type DesktopPetProjectionEvent,
  type PetStateBridge,
} from "./pet-state-aggregator";
import { PetWorkerProjectionGeneration } from "./pet-worker-generation";

function disk(id: string, overrides: Partial<DiskSessionMeta> = {}): DiskSessionMeta {
  return {
    id,
    engineSessionId: id,
    cwd: `/Users/me/work/${id}`,
    title: `Disk ${id}`,
    updatedAt: 1_000,
    origin: "desktop",
    ...overrides,
  };
}

function live(id: string, overrides: Partial<PetSessionProjection> = {}): PetSessionProjection {
  return {
    owner: "local-user",
    agentSessionId: id,
    coreSessionId: `core-${id}`,
    runState: "running",
    queueDepth: 0,
    lastActivityAt: 2_000,
    pendingDecisionCount: 0,
    freshness: { source: "live-snapshot", observedAt: 2_000, workerState: "active" },
    ...overrides,
  };
}

function workerSnapshot(
  version: number,
  sessions: PetSessionProjection[] = [],
): PetProjectionSnapshotResult {
  return {
    // ChatSessionManager's real stdio construction defaults every process to generation 1.
    workerGeneration: 1,
    snapshotVersion: version,
    observedAt: 2_000,
    sessions,
    pending: [],
  };
}

class FakeBridge implements PetStateBridge {
  active = false;
  snapshot: PetProjectionSnapshotResult | null = null;
  snapshotError: Error | null = null;
  snapshotRequests = 0;
  private listener?: (event: AgentBridgePetEvent) => void | Promise<void>;

  hasLiveWorker(): boolean {
    return this.active;
  }

  async requestPetProjectionSnapshot(): Promise<PetProjectionSnapshotResult | null> {
    this.snapshotRequests += 1;
    if (this.snapshotError) throw this.snapshotError;
    return this.snapshot;
  }

  subscribePetProjection(
    listener: (event: AgentBridgePetEvent) => void | Promise<void>,
  ): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  async emit(event: AgentBridgePetEvent): Promise<void> {
    await this.listener?.(event);
  }
}

function pagedCatalog(initial: DiskSessionMeta[]) {
  // Mirror listDiskSessions: the on-disk catalog is served mtime-descending
  // (ties broken by id), which is the ordering the incremental cursor relies on.
  const sort = (rows: DiskSessionMeta[]) =>
    [...rows].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.engineSessionId.localeCompare(b.engineSessionId),
    );
  let sessions = sort(initial);
  const callArgs: Array<{ limit: number; cursor?: string }> = [];
  const readSessionIds: string[] = [];
  const list = async ({
    limit,
    cursor,
  }: {
    limit: number;
    cursor?: string;
  }): Promise<ListDiskSessionsResult> => {
    callArgs.push({ limit, cursor });
    const start = cursor ? Number(cursor) : 0;
    const page = sessions.slice(start, start + limit);
    for (const session of page) readSessionIds.push(session.engineSessionId);
    const next = start + page.length;
    return { sessions: page, nextCursor: next < sessions.length ? String(next) : null };
  };
  return {
    list,
    replace: (next: DiskSessionMeta[]) => (sessions = sort(next)),
    callArgs,
    readSessionIds,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("PetStateAggregator", () => {
  test("reads every disk page without spawning a worker and exposes only display workspace names", async () => {
    const bridge = new FakeBridge();
    const catalog = pagedCatalog([
      disk("one"),
      disk("two"),
      disk("three", { status: "completed" }),
    ]);
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions: catalog.list,
      pageSize: 2,
      now: () => 3_000,
    });

    await aggregator.start();

    expect(bridge.snapshotRequests).toBe(0);
    expect(aggregator.getSnapshot()).toMatchObject({ workerState: "reclaimed", generation: 0 });
    expect(aggregator.getSnapshot().sessions.map((session) => session.agentSessionId)).toEqual([
      "one",
      "three",
      "two",
    ]);
    expect(aggregator.getSnapshot().sessions[0]).toMatchObject({
      runState: "dormant",
      workspaceDisplayName: "one",
    });
    expect(
      aggregator.getSnapshot().sessions.find((session) => session.agentSessionId === "three"),
    ).toMatchObject({ runState: "terminal", terminal: { status: "completed" } });
    expect(JSON.stringify(aggregator.getSnapshot())).not.toContain("/Users/me/work");
  });

  test("overlays a live snapshot and applies only ordered same-generation deltas", async () => {
    const bridge = new FakeBridge();
    bridge.active = true;
    const generation = new PetWorkerProjectionGeneration();
    generation.beginWorker();
    bridge.snapshot = generation.normalizeSnapshot(workerSnapshot(8, [live("one")]));
    const catalog = pagedCatalog([disk("one"), disk("two")]);
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions: catalog.list,
      now: () => 3_000,
    });
    await aggregator.start();

    expect(aggregator.getSnapshot()).toMatchObject({ workerState: "active", generation: 1 });
    expect(
      aggregator.getSnapshot().sessions.find((session) => session.agentSessionId === "one")
        ?.runState,
    ).toBe("running");
    expect(
      aggregator.getSnapshot().sessions.find((session) => session.agentSessionId === "one"),
    ).toMatchObject({ title: "Disk one", workspaceDisplayName: "one" });
    expect(JSON.stringify(aggregator.getSnapshot())).not.toContain("core-one");

    const delta: PetProjectionDelta = {
      workerGeneration: 1,
      version: 9,
      observedAt: 3_100,
      kind: "session-upsert",
      session: live("one", { runState: "idle" }),
    };
    await bridge.emit({ kind: "delta", delta });
    await bridge.emit({ kind: "delta", delta });
    expect(
      aggregator.getSnapshot().sessions.find((session) => session.agentSessionId === "one")
        ?.runState,
    ).toBe("idle");
    expect(
      aggregator.getSnapshot().sessions.find((session) => session.agentSessionId === "one"),
    ).toMatchObject({ title: "Disk one", workspaceDisplayName: "one" });
    expect(aggregator.getSnapshot().version).toBe(1);
  });

  test("reconciles a finalizing live event with the current durable terminal state", async () => {
    const bridge = new FakeBridge();
    bridge.active = true;
    bridge.snapshot = workerSnapshot(8, [live("one")]);
    const catalog = pagedCatalog([disk("one", { status: "active" })]);
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions: catalog.list,
      now: () => 3_000,
    });
    await aggregator.start();
    catalog.replace([disk("one", { status: "completed", updatedAt: 2_500 })]);
    const events: DesktopPetProjectionEvent[] = [];
    aggregator.subscribe((event) => events.push(event));

    await bridge.emit({
      kind: "delta",
      delta: {
        workerGeneration: 1,
        version: 9,
        observedAt: 2_600,
        kind: "session-upsert",
        session: live("one", {
          runState: "idle",
          phase: "finalizing",
          summary: "turn closed",
          lastActivityAt: 2_400,
        }),
      },
    });

    expect(events.at(-1)).toMatchObject({
      kind: "session-upsert",
      observedAt: 3_000,
      session: {
        title: "Disk one",
        workspaceDisplayName: "one",
        runState: "terminal",
        phase: undefined,
        terminal: { status: "completed", at: 2_500 },
      },
    });
    expect(aggregator.getSnapshot().sessions[0]).toMatchObject({
      runState: "terminal",
      phase: undefined,
      terminal: { status: "completed", at: 2_500 },
    });
  });

  test("serializes deltas while an older finalizing event awaits disk reconciliation", async () => {
    const bridge = new FakeBridge();
    bridge.active = true;
    bridge.snapshot = workerSnapshot(8, [live("one")]);
    const finalizingRefreshStarted = deferred<void>();
    const releaseFinalizingRefresh = deferred<ListDiskSessionsResult>();
    let catalogCalls = 0;
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions: async () => {
        catalogCalls += 1;
        if (catalogCalls === 1) return { sessions: [disk("one")], nextCursor: null };
        finalizingRefreshStarted.resolve();
        return releaseFinalizingRefresh.promise;
      },
    });
    await aggregator.start();
    const events: DesktopPetProjectionEvent[] = [];
    aggregator.subscribe((event) => events.push(event));

    const finalizing = bridge.emit({
      kind: "delta",
      delta: {
        workerGeneration: 1,
        version: 9,
        observedAt: 3_000,
        kind: "session-upsert",
        session: live("one", { phase: "finalizing", summary: "closing" }),
      },
    });
    await finalizingRefreshStarted.promise;
    const newer = bridge.emit({
      kind: "delta",
      delta: {
        workerGeneration: 1,
        version: 10,
        observedAt: 3_100,
        kind: "session-upsert",
        session: live("one", { phase: "tool", summary: "new turn" }),
      },
    });

    // The newer delta is queued at the aggregator boundary, not emitted while
    // version 9 is still awaiting its durable overlay.
    await Promise.resolve();
    expect(events).toEqual([]);
    releaseFinalizingRefresh.resolve({ sessions: [disk("one")], nextCursor: null });
    await Promise.all([finalizing, newer]);

    expect(
      events.map((event) => (event.kind === "session-upsert" ? event.session.phase : null)),
    ).toEqual(["finalizing", "tool"]);
    expect(aggregator.getSnapshot().sessions[0]).toMatchObject({
      phase: "tool",
      summary: "new turn",
    });
  });

  test("reconciles a new generation, discards old deltas and replaces live overlay", async () => {
    const bridge = new FakeBridge();
    bridge.active = true;
    const generation = new PetWorkerProjectionGeneration();
    generation.beginWorker();
    bridge.snapshot = generation.normalizeSnapshot(workerSnapshot(3, [live("old")]));
    const aggregator = new PetStateAggregator({ bridge, listDiskSessions: pagedCatalog([]).list });
    await aggregator.start();

    const oldDelta = generation.normalizeDelta({
      workerGeneration: 1,
      version: 99,
      observedAt: 5_000,
      kind: "session-upsert",
      session: live("ghost"),
    });
    generation.beginWorker();
    bridge.snapshot = generation.normalizeSnapshot(workerSnapshot(1, [live("new")]));
    await bridge.emit({
      kind: "delta",
      delta: generation.normalizeDelta({
        workerGeneration: 1,
        version: 2,
        observedAt: 4_000,
        kind: "session-upsert",
        session: live("new"),
      }),
    });
    expect(bridge.snapshotRequests).toBe(2);
    expect(aggregator.getSnapshot()).toMatchObject({ generation: 2, workerState: "active" });
    expect(aggregator.getSnapshot().sessions.map((session) => session.agentSessionId)).toEqual([
      "new",
    ]);

    await bridge.emit({
      kind: "delta",
      delta: oldDelta,
    });
    expect(aggregator.getSnapshot().sessions.map((session) => session.agentSessionId)).toEqual([
      "new",
    ]);
  });

  test("fails a rejected live reconciliation closed instead of remaining reconciling", async () => {
    const bridge = new FakeBridge();
    bridge.active = true;
    bridge.snapshotError = new Error("worker snapshot failed");
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions: pagedCatalog([disk("one")]).list,
      now: () => 4_000,
    });

    await expect(aggregator.start()).resolves.toBeUndefined();
    expect(aggregator.getSnapshot()).toMatchObject({
      workerState: "disconnected",
      pending: [],
      sessions: [
        {
          agentSessionId: "one",
          runState: "unknown",
          freshness: { workerState: "disconnected" },
        },
      ],
    });

    bridge.snapshotError = null;
    bridge.snapshot = workerSnapshot(1, [live("one")]);
    await bridge.emit({ kind: "lifecycle", state: "active" });
    expect(aggregator.getSnapshot()).toMatchObject({
      workerState: "active",
      sessions: [{ agentSessionId: "one", runState: "running" }],
    });

    const events: DesktopPetProjectionEvent[] = [];
    aggregator.subscribe((event) => events.push(event));
    bridge.snapshotError = new Error("worker snapshot failed again");
    await expect(bridge.emit({ kind: "lifecycle", state: "active" })).resolves.toBeUndefined();
    expect(events.map((event) => event.kind)).toEqual(["worker-state", "reset"]);
    expect(aggregator.getSnapshot()).toMatchObject({
      workerState: "disconnected",
      pending: [],
    });
  });

  test("distinguishes normal reclaim from disconnect and fails pending closed", async () => {
    const bridge = new FakeBridge();
    bridge.active = true;
    bridge.snapshot = {
      ...workerSnapshot(1, [live("one")]),
      pending: [
        {
          owner: "local-user",
          agentSessionId: "one",
          coreSessionId: "core-one",
          requestId: "req-1",
          workerGeneration: 1,
          kind: "ask_user",
          title: "Need input",
          createdAt: 2_000,
          status: "pending",
        },
      ],
    };
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions: pagedCatalog([disk("one")]).list,
    });
    await aggregator.start();

    await bridge.emit({ kind: "lifecycle", state: "reclaimed" });
    expect(aggregator.getSnapshot()).toMatchObject({ workerState: "reclaimed", pending: [] });
    expect(aggregator.getSnapshot().sessions[0].runState).toBe("dormant");

    bridge.snapshot = workerSnapshot(1, [live("one")]);
    await bridge.emit({ kind: "lifecycle", state: "active" });
    await bridge.emit({ kind: "lifecycle", state: "disconnected" });
    expect(aggregator.getSnapshot()).toMatchObject({ workerState: "disconnected", pending: [] });
    expect(aggregator.getSnapshot().sessions[0].runState).toBe("unknown");
  });

  test("refreshes disk truth so closed or deleted sessions do not remain as ghosts", async () => {
    const bridge = new FakeBridge();
    const catalog = pagedCatalog([disk("gone"), disk("keep")]);
    const aggregator = new PetStateAggregator({ bridge, listDiskSessions: catalog.list });
    await aggregator.start();
    catalog.replace([disk("keep")]);

    // A full refresh is the delete-aware path: the mtime cursor cannot observe a
    // vanished session on its own, so removals are reconciled by rebuilding.
    await aggregator.refreshCatalog(true, { full: true });

    expect(aggregator.getSnapshot().sessions.map((session) => session.agentSessionId)).toEqual([
      "keep",
    ]);
  });

  test("incremental refresh only pages sessions newer than the last high-water mark", async () => {
    const bridge = new FakeBridge();
    // Three sessions at the low end (100) live in a later page; only the newest
    // matters after the first refresh establishes the high-water mark.
    const catalog = pagedCatalog([
      disk("a1", { updatedAt: 100 }),
      disk("a2", { updatedAt: 100 }),
      disk("b", { updatedAt: 200 }),
    ]);
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions: catalog.list,
      pageSize: 1,
      now: () => 5_000,
    });
    await aggregator.start();
    catalog.callArgs.length = 0; // reset the recorded (limit,cursor) calls
    catalog.readSessionIds.length = 0;

    catalog.replace([
      disk("a1", { updatedAt: 100 }),
      disk("a2", { updatedAt: 100 }),
      disk("b", { updatedAt: 200 }),
      disk("c", { updatedAt: 300 }),
    ]);
    await aggregator.refreshCatalog(false);

    // Incremental refresh pages c (300) and b (200), then fetches the first
    // older page (a1 at 100 < 200) only to detect the boundary and halt. The
    // remaining older page holding a2 is never fetched.
    expect(aggregator.getSnapshot().sessions.some((s) => s.agentSessionId === "c")).toBe(true);
    expect(catalog.readSessionIds).not.toContain("a2");
    // The older sessions are retained from the prior refresh rather than rebuilt.
    expect(aggregator.getSnapshot().sessions.map((s) => s.agentSessionId)).toEqual([
      "a1",
      "a2",
      "b",
      "c",
    ]);
    // A full pass would have fetched all four pages; incremental stops earlier.
    expect(catalog.callArgs.length).toBeLessThan(4);
  });

  test("a session that jumps ahead in mtime (e.g. archival) is re-read incrementally", async () => {
    const bridge = new FakeBridge();
    const catalog = pagedCatalog([disk("a", { updatedAt: 100 }), disk("b", { updatedAt: 200 })]);
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions: catalog.list,
      pageSize: 10,
      now: () => 5_000,
    });
    await aggregator.start();
    catalog.readSessionIds.length = 0;

    // "a" is rewritten (its mtime jumps past the prior high-water 200): it now
    // sorts to the front and its updated title must be picked up incrementally.
    catalog.replace([
      disk("a", { updatedAt: 300, title: "archived a" }),
      disk("b", { updatedAt: 200 }),
    ]);
    await aggregator.refreshCatalog(false);

    expect(catalog.readSessionIds).toContain("a");
    expect(aggregator.getSnapshot().sessions.find((s) => s.agentSessionId === "a")?.title).toBe(
      "archived a",
    );
  });

  test("incremental refresh does not miss a new session sharing the high-water mtime", async () => {
    const bridge = new FakeBridge();
    // "dup" shares mtime 200 with the already-held "b" but is not yet in the
    // catalog: <= high-water alone must not stop paging when the id is unseen.
    const catalog = pagedCatalog([disk("a", { updatedAt: 100 }), disk("b", { updatedAt: 200 })]);
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions: catalog.list,
      pageSize: 1,
      now: () => 5_000,
    });
    await aggregator.start();

    catalog.replace([
      disk("a", { updatedAt: 100 }),
      disk("b", { updatedAt: 200 }),
      disk("dup", { updatedAt: 200 }),
    ]);
    await aggregator.refreshCatalog(false);

    expect(aggregator.getSnapshot().sessions.some((s) => s.agentSessionId === "dup")).toBe(true);
  });

  test("observes a failed background refresh after session removal without rejecting the bridge", async () => {
    const bridge = new FakeBridge();
    bridge.active = true;
    bridge.snapshot = workerSnapshot(8, [live("one")]);
    let failRefresh = false;
    const backgroundErrors: Array<{ operation: string; error: unknown }> = [];
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions: async () => {
        if (failRefresh) throw new Error("catalog unavailable");
        return { sessions: [disk("one")], nextCursor: null };
      },
      onBackgroundError: (operation, error) => backgroundErrors.push({ operation, error }),
    });
    await aggregator.start();
    failRefresh = true;

    await expect(
      bridge.emit({
        kind: "delta",
        delta: {
          workerGeneration: 1,
          version: 9,
          observedAt: 3_000,
          kind: "session-remove",
          sessionId: "one",
        },
      }),
    ).resolves.toBeUndefined();
    await Promise.resolve();

    expect(backgroundErrors).toHaveLength(1);
    expect(backgroundErrors[0]).toMatchObject({
      operation: "session-remove-refresh",
      error: expect.objectContaining({ message: "catalog unavailable" }),
    });
  });

  test("revalidates structured navigation against current disk and pending generations", async () => {
    const bridge = new FakeBridge();
    bridge.active = true;
    bridge.snapshot = {
      ...workerSnapshot(4, [live("one")]),
      pending: [
        {
          owner: "local-user",
          agentSessionId: "one",
          coreSessionId: "core-one",
          requestId: "req-1",
          routeGeneration: 3,
          workerGeneration: 1,
          kind: "tool_approval",
          title: "Approve Write",
          createdAt: 2_000,
          status: "pending",
        },
      ],
    };
    const catalog = pagedCatalog([disk("one")]);
    const aggregator = new PetStateAggregator({ bridge, listDiskSessions: catalog.list });
    await aggregator.start();

    expect(
      await aggregator.resolveNavigation({
        agentSessionId: "one",
        snapshotVersion: aggregator.getSnapshot().version,
        generation: 1,
        requestId: "req-1",
        routeGeneration: 3,
      }),
    ).toMatchObject({
      status: "ok",
      target: { uiSessionId: "one", projectPath: "/Users/me/work/one" },
    });

    expect(
      await aggregator.resolveNavigation({
        agentSessionId: "one",
        snapshotVersion: 0,
        generation: 0,
        requestId: "resolved",
      }),
    ).toMatchObject({ status: "stale", pendingStatus: "resolved" });

    catalog.replace([]);
    expect(
      await aggregator.resolveNavigation({
        agentSessionId: "one",
        snapshotVersion: 0,
        generation: 1,
      }),
    ).toEqual({ status: "not-found" });
  });
});

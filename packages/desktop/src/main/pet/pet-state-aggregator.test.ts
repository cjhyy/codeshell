import { describe, expect, test } from "bun:test";
import type {
  PetProjectionDelta,
  PetProjectionSnapshotResult,
  PetSessionProjection,
} from "@cjhyy/code-shell-core";
import type { DiskSessionMeta, ListDiskSessionsResult } from "@cjhyy/code-shell-server";
import {
  PetStateAggregator,
  type AgentBridgePetEvent,
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
  snapshotRequests = 0;
  private listener?: (event: AgentBridgePetEvent) => void | Promise<void>;

  hasLiveWorker(): boolean {
    return this.active;
  }

  async requestPetProjectionSnapshot(): Promise<PetProjectionSnapshotResult | null> {
    this.snapshotRequests += 1;
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
  let sessions = initial;
  const list = async ({
    limit,
    cursor,
  }: {
    limit: number;
    cursor?: string;
  }): Promise<ListDiskSessionsResult> => {
    const start = cursor ? Number(cursor) : 0;
    const page = sessions.slice(start, start + limit);
    const next = start + page.length;
    return { sessions: page, nextCursor: next < sessions.length ? String(next) : null };
  };
  return { list, replace: (next: DiskSessionMeta[]) => (sessions = next) };
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

    await aggregator.refreshCatalog();

    expect(aggregator.getSnapshot().sessions.map((session) => session.agentSessionId)).toEqual([
      "keep",
    ]);
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

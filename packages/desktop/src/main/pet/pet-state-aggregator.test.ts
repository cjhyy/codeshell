import { describe, expect, test } from "bun:test";
import type {
  PetProjectionDelta,
  PetProjectionSnapshotResult,
  PetSessionProjection,
} from "@cjhyy/code-shell-core";
import type { DiskSessionMeta, ListDiskSessionsResult } from "../sessions-service";
import {
  PetStateAggregator,
  type AgentBridgePetEvent,
  type PetStateBridge,
} from "./pet-state-aggregator";

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
    title: `Live ${id}`,
    workspaceDisplayName: id,
    runState: "running",
    queueDepth: 0,
    lastActivityAt: 2_000,
    pendingDecisionCount: 0,
    freshness: { source: "live-snapshot", observedAt: 2_000, workerState: "active" },
    ...overrides,
  };
}

function snapshot(
  generation: number,
  version: number,
  sessions: PetSessionProjection[] = [],
): PetProjectionSnapshotResult {
  return {
    workerGeneration: generation,
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
    bridge.snapshot = snapshot(4, 8, [live("one")]);
    const catalog = pagedCatalog([disk("one"), disk("two")]);
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions: catalog.list,
      now: () => 3_000,
    });
    await aggregator.start();

    expect(aggregator.getSnapshot()).toMatchObject({ workerState: "active", generation: 4 });
    expect(
      aggregator.getSnapshot().sessions.find((session) => session.agentSessionId === "one")
        ?.runState,
    ).toBe("running");
    expect(JSON.stringify(aggregator.getSnapshot())).not.toContain("core-one");

    const delta: PetProjectionDelta = {
      workerGeneration: 4,
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
    expect(aggregator.getSnapshot().version).toBe(1);
  });

  test("reconciles a new generation, discards old deltas and replaces live overlay", async () => {
    const bridge = new FakeBridge();
    bridge.active = true;
    bridge.snapshot = snapshot(2, 3, [live("old")]);
    const aggregator = new PetStateAggregator({ bridge, listDiskSessions: pagedCatalog([]).list });
    await aggregator.start();

    bridge.snapshot = snapshot(3, 1, [live("new")]);
    await bridge.emit({
      kind: "delta",
      delta: {
        workerGeneration: 3,
        version: 2,
        observedAt: 4_000,
        kind: "session-upsert",
        session: live("new"),
      },
    });
    expect(bridge.snapshotRequests).toBe(2);
    expect(aggregator.getSnapshot()).toMatchObject({ generation: 3, workerState: "active" });
    expect(aggregator.getSnapshot().sessions.map((session) => session.agentSessionId)).toEqual([
      "new",
    ]);

    await bridge.emit({
      kind: "delta",
      delta: {
        workerGeneration: 2,
        version: 99,
        observedAt: 5_000,
        kind: "session-upsert",
        session: live("ghost"),
      },
    });
    expect(aggregator.getSnapshot().sessions.map((session) => session.agentSessionId)).toEqual([
      "new",
    ]);
  });

  test("distinguishes normal reclaim from disconnect and fails pending closed", async () => {
    const bridge = new FakeBridge();
    bridge.active = true;
    bridge.snapshot = {
      ...snapshot(5, 1, [live("one")]),
      pending: [
        {
          owner: "local-user",
          agentSessionId: "one",
          coreSessionId: "core-one",
          requestId: "req-1",
          workerGeneration: 5,
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

    bridge.snapshot = snapshot(6, 1, [live("one")]);
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
});

import { describe, expect, test } from "bun:test";
import type { PetProjectionSnapshotResult } from "@cjhyy/code-shell-pet";
import type { ListDiskSessionsResult } from "@cjhyy/code-shell-server/storage";
import { PetAttentionPolicy } from "./pet-attention-policy";
import {
  PetStateAggregator,
  type AgentBridgePetEvent,
  type PetStateBridge,
} from "./pet-state-aggregator";

class Bridge implements PetStateBridge {
  active = false;
  snapshot: PetProjectionSnapshotResult | null = null;
  listener?: (event: AgentBridgePetEvent) => void | Promise<void>;
  hasLiveWorker = () => this.active;
  requestPetProjectionSnapshot = async () => this.snapshot;
  subscribePetProjection = (listener: (event: AgentBridgePetEvent) => void | Promise<void>) => {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  };
  emit = async (event: AgentBridgePetEvent) => this.listener?.(event);
}

describe("Pet lifecycle integration", () => {
  test("rebuilds disk → live → disconnected → reconnected without ghost pending", async () => {
    const bridge = new Bridge();
    const listDiskSessions = async (): Promise<ListDiskSessionsResult> => ({
      sessions: [
        {
          id: "work-a",
          engineSessionId: "work-a",
          cwd: "/work/a",
          title: "Work A",
          updatedAt: 1,
          origin: "desktop",
        },
      ],
      nextCursor: null,
    });
    const aggregator = new PetStateAggregator({ bridge, listDiskSessions, now: () => 20_000 });
    await aggregator.start();
    expect(aggregator.getSnapshot()).toMatchObject({
      workerState: "reclaimed",
      sessions: [{ runState: "dormant" }],
    });

    bridge.active = true;
    bridge.snapshot = {
      workerGeneration: 2,
      snapshotVersion: 1,
      observedAt: 20_000,
      sessions: [
        {
          owner: "local-user",
          agentSessionId: "work-a",
          coreSessionId: "core-a",
          title: "Work A",
          runState: "running",
          queueDepth: 0,
          lastActivityAt: 20_000,
          pendingDecisionCount: 1,
          freshness: { source: "live-snapshot", observedAt: 20_000, workerState: "active" },
        },
      ],
      pending: [
        {
          owner: "local-user",
          agentSessionId: "work-a",
          coreSessionId: "core-a",
          requestId: "req-a",
          workerGeneration: 2,
          kind: "ask_user",
          title: "Choose",
          createdAt: 1,
          status: "pending",
        },
      ],
    };
    await bridge.emit({ kind: "lifecycle", state: "active" });
    const policy = new PetAttentionPolicy({
      source: aggregator,
      receipts: { has: () => true, mark: () => {} },
      now: () => 20_000,
    });
    policy.start();
    expect(aggregator.getSnapshot()).toMatchObject({ workerState: "active" });
    expect(policy.getSnapshot().surfaceablePendingCount).toBe(1);

    await bridge.emit({ kind: "lifecycle", state: "disconnected" });
    expect(aggregator.getSnapshot()).toMatchObject({ workerState: "disconnected", pending: [] });
    expect(aggregator.getSnapshot().sessions[0]?.runState).toBe("unknown");
    expect(policy.getSnapshot().surfaceablePendingCount).toBe(0);

    bridge.snapshot = {
      workerGeneration: 3,
      snapshotVersion: 1,
      observedAt: 21_000,
      sessions: [],
      pending: [],
    };
    await bridge.emit({ kind: "lifecycle", state: "active" });
    expect(aggregator.getSnapshot()).toMatchObject({ generation: 3, pending: [] });
    expect(aggregator.getSnapshot().sessions[0]?.runState).toBe("dormant");
    policy.stop();
    aggregator.stop();
  });
});

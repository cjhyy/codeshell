import { beforeEach, describe, expect, it } from "bun:test";

import { asyncAgentRegistry, type DirectionAck, type LiveChildControl } from "./agent-registry.js";
import { notificationQueue } from "./agent-notifications.js";

function control(generation: number, seen: unknown[]): LiveChildControl {
  return {
    childSessionId: "child-session",
    runtimeGeneration: generation,
    getState: () => "model",
    routeDirection: (draft): DirectionAck => {
      seen.push(draft);
      const envelope = notificationQueue.enqueue(draft)!;
      return {
        status: "queued",
        envelopeId: envelope.id,
        sequence: envelope.sequence,
        correlationId: envelope.correlationId,
        target: envelope.to,
        acceptedAt: envelope.createdAt,
      };
    },
  };
}

describe("Phase 0 live child registry routing", () => {
  beforeEach(() => {
    asyncAgentRegistry.reset();
    notificationQueue.reset();
  });

  function register(): void {
    asyncAgentRegistry.register({
      agentId: "worker",
      description: "inspect",
      sessionId: "parent-session",
      childSessionId: "child-session",
      runtimeGeneration: 7,
      status: "running",
      startedAt: 0,
      abort: () => {},
    });
  }

  it("enforces one writer lease per child session and generation", () => {
    register();
    const first = asyncAgentRegistry.acquireWriterLease("child-session", 7, "owner-a");
    const duplicate = asyncAgentRegistry.acquireWriterLease("child-session", 7, "owner-b");
    expect(first).toMatchObject({
      childSessionId: "child-session",
      runtimeGeneration: 7,
      ownerToken: "owner-a",
    });
    expect(duplicate).toBeUndefined();
  });

  it("binds only a matching live control and routes direct-parent direction as agent authority", async () => {
    register();
    const seen: unknown[] = [];
    const lease = asyncAgentRegistry.acquireWriterLease("child-session", 7, "owner-a")!;
    expect(asyncAgentRegistry.bindLiveControl("worker", control(7, seen), lease)).toBe(true);

    const ack = await asyncAgentRegistry.routeDirection({
      callerSessionId: "parent-session",
      callerIsSubAgent: false,
      agentId: "worker",
      prompt: "focus on the failing test",
      delivery: "next-safe-point",
    });

    expect(ack.status).toBe("queued");
    expect(seen).toEqual([
      expect.objectContaining({
        kind: "direction",
        from: { sessionId: "parent-session", authority: "agent" },
        to: { sessionId: "child-session", agentId: "worker", authority: "agent" },
        payload: { prompt: "focus on the failing test", origin: "agent_send_input" },
      }),
    ]);
  });

  it("fails closed for sibling/other-session, sub-agent caller, and stale generation", () => {
    register();
    const seen: unknown[] = [];
    const lease = asyncAgentRegistry.acquireWriterLease("child-session", 7, "owner-a")!;
    expect(asyncAgentRegistry.bindLiveControl("worker", control(6, seen), lease)).toBe(false);
    expect(asyncAgentRegistry.bindLiveControl("worker", control(7, seen), lease)).toBe(true);

    const sibling = asyncAgentRegistry.routeDirection({
      callerSessionId: "sibling-session",
      callerIsSubAgent: false,
      agentId: "worker",
      prompt: "mesh",
      delivery: "next-safe-point",
    });
    const childCaller = asyncAgentRegistry.routeDirection({
      callerSessionId: "parent-session",
      callerIsSubAgent: true,
      agentId: "worker",
      prompt: "mesh",
      delivery: "next-safe-point",
    });

    expect(sibling).toMatchObject({ status: "rejected", reason: "not-direct-parent" });
    expect(childCaller).toMatchObject({ status: "rejected", reason: "not-direct-parent" });
    expect(notificationQueue.getSnapshot("child-session")).toHaveLength(0);
  });

  it("closing intake rejects without leaving an orphan direction", () => {
    register();
    const seen: unknown[] = [];
    const lease = asyncAgentRegistry.acquireWriterLease("child-session", 7, "owner-a")!;
    asyncAgentRegistry.bindLiveControl("worker", control(7, seen), lease);
    expect(asyncAgentRegistry.closeDirectionIntake("worker", lease)).toBe(true);

    const ack = asyncAgentRegistry.routeDirection({
      callerSessionId: "parent-session",
      callerIsSubAgent: false,
      agentId: "worker",
      prompt: "too late",
      delivery: "next-safe-point",
    });
    expect(ack).toMatchObject({ status: "rejected", reason: "intake-closed" });
    expect(notificationQueue.getSnapshot("child-session")).toHaveLength(0);
  });

  it("keeps the fenced writer lease while cancellation is still settling", () => {
    register();
    let aborts = 0;
    asyncAgentRegistry.get("worker")!.abort = () => aborts++;
    const lease = asyncAgentRegistry.acquireWriterLease("child-session", 7, "owner-a")!;
    asyncAgentRegistry.bindLiveControl("worker", control(7, []), lease);
    notificationQueue.enqueue({
      kind: "progress",
      from: { sessionId: "child-session", agentId: "worker", authority: "agent" },
      to: { sessionId: "parent-session", authority: "agent" },
      delivery: "observe-only",
      runtimeGeneration: 7,
      payload: {
        phase: "model",
        tokens: { prompt: 1, completion: 1, total: 2 },
        summary: "模型处理中",
        observedAt: 1,
      },
    });

    expect(asyncAgentRegistry.cancel("worker")).toBe(true);
    expect(aborts).toBe(1);
    expect(asyncAgentRegistry.get("worker")?.status).toBe("cancelling");
    expect(asyncAgentRegistry.getWriterLease("child-session")).toEqual(lease);
    expect(notificationQueue.getSnapshot("parent-session")).toHaveLength(0);

    const nextGeneration = asyncAgentRegistry.allocateRuntimeGeneration("child-session");
    expect(
      asyncAgentRegistry.acquireWriterLease("child-session", nextGeneration, "owner-b"),
    ).toBeUndefined();

    expect(asyncAgentRegistry.completeTerminal("worker", "cancelled", lease)).toBe(true);
    expect(asyncAgentRegistry.getWriterLease("child-session")).toBeUndefined();
    expect(
      asyncAgentRegistry.acquireWriterLease("child-session", nextGeneration, "owner-b"),
    ).toBeDefined();
  });

  it("ignores a stale terminal callback from an older runtime generation", () => {
    register();
    const oldLease = asyncAgentRegistry.acquireWriterLease("child-session", 7, "owner-a")!;
    asyncAgentRegistry.bindLiveControl("worker", control(7, []), oldLease);
    expect(asyncAgentRegistry.completeTerminal("worker", "completed", oldLease)).toBe(true);

    asyncAgentRegistry.register({
      agentId: "worker",
      description: "new generation",
      sessionId: "parent-session",
      childSessionId: "child-session",
      runtimeGeneration: 8,
      status: "running",
      startedAt: 1,
      abort: () => {},
    });
    const newLease = asyncAgentRegistry.acquireWriterLease("child-session", 8, "owner-b")!;
    asyncAgentRegistry.bindLiveControl("worker", control(8, []), newLease);

    expect(asyncAgentRegistry.completeTerminal("worker", "failed", oldLease)).toBe(false);
    expect(asyncAgentRegistry.get("worker")?.status).toBe("running");
    expect(asyncAgentRegistry.getWriterLease("child-session")).toEqual(newLease);
  });
});

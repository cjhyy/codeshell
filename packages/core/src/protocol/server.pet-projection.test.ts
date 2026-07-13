import { describe, expect, test } from "bun:test";
import type { Engine, EngineResult } from "../engine/engine.js";
import { PendingDecisionIndex } from "../pet/pending-decision-index.js";
import { SessionIndex } from "../pet/session-index.js";
import { AgentClient } from "./client.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";
import { createInProcessTransport } from "./transport.js";
import type { PetProjectionDelta } from "./types.js";

function makeEngine(sessionId: string, kind: "work" | "pet" = "work"): Engine {
  return {
    setPlanMode() {},
    setAskUser() {},
    setBrowserBridge() {},
    setInjectCredential() {},
    isHeadless: () => false,
    getSessionManager: () => ({ readSessionKind: () => kind }),
    async run(_task: string, options?: any): Promise<EngineResult> {
      options?.onStream?.({ type: "stream_request_start", turnNumber: 1 });
      options?.onStream?.({
        type: "tool_use_start",
        toolCall: {
          id: "tool-1",
          toolName: "Bash",
          args: { command: "echo sk-secret-must-not-leak" },
        },
      });
      options?.onStream?.({ type: "turn_complete", reason: "completed" });
      return {
        text: "done",
        reason: "completed",
        sessionId,
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
}

function makePair(
  generation: number,
  sessionIds = ["session-a", "session-b"],
  kind: "work" | "pet" = "work",
) {
  const engines = sessionIds.map((sessionId) => makeEngine(sessionId, kind));
  const manager = new ChatSessionManager({
    runtime: {} as never,
    engineFactory: () => engines.shift() ?? makeEngine("fallback"),
    projectionGeneration: generation,
  });
  const [clientTransport, serverTransport] = createInProcessTransport();
  const server = new AgentServer({ transport: serverTransport, chatManager: manager });
  const client = new AgentClient({ transport: clientTransport });
  return { client, manager, server };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Pet projection protocol", () => {
  test("returns a bounded snapshot and monotonic session-isolated deltas", async () => {
    const { client, server } = makePair(7);
    const deltas: PetProjectionDelta[] = [];
    client.onPetProjectionDelta((delta) => deltas.push(delta));

    const initial = await client.getPetProjectionSnapshot();
    expect(initial).toMatchObject({
      workerGeneration: 7,
      snapshotVersion: 0,
      sessions: [],
      pending: [],
    });

    await Promise.all([
      client.run({ sessionId: "session-a", task: "run a" }),
      client.run({ sessionId: "session-b", task: "run b" }),
    ]);
    await tick();

    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((delta) => delta.version)).toEqual(
      [...deltas.map((delta) => delta.version)].sort((a, b) => a - b),
    );
    expect(new Set(deltas.map((delta) => delta.version)).size).toBe(deltas.length);
    expect(deltas.every((delta) => delta.workerGeneration === 7)).toBe(true);
    const sessionDeltas = deltas.filter((delta) => delta.kind === "session-upsert");
    expect(sessionDeltas.some((delta) => delta.session.agentSessionId === "session-a")).toBe(true);
    expect(sessionDeltas.some((delta) => delta.session.agentSessionId === "session-b")).toBe(true);

    const snapshot = await client.getPetProjectionSnapshot();
    expect(snapshot.sessions.map((session) => session.agentSessionId).sort()).toEqual([
      "session-a",
      "session-b",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("sk-secret");
    expect(JSON.stringify(snapshot)).not.toContain("command");
    expect(JSON.stringify(snapshot)).not.toContain("resolver");

    const legacy = await client.query("sessions");
    expect((legacy as any).data).toHaveLength(2);
    server.close();
    client.close();
  });

  test("snapshot cursor handshake applies only later deltas without duplication", async () => {
    const { client, server } = makePair(3, ["session-a"]);
    const received: PetProjectionDelta[] = [];
    client.onPetProjectionDelta((delta) => received.push(delta));
    await client.run({ sessionId: "session-a", task: "first" });
    const snapshot = await client.getPetProjectionSnapshot();
    const beforeSecondRun = received.length;

    await client.run({ sessionId: "session-a", task: "second" });
    await tick();
    const applicable = received.filter(
      (delta) =>
        delta.workerGeneration === snapshot.workerGeneration &&
        delta.version > snapshot.snapshotVersion,
    );
    expect(applicable).toEqual(received.slice(beforeSecondRun));
    expect(applicable[0]?.version).toBe(snapshot.snapshotVersion + 1);
    server.close();
    client.close();
  });

  test("new generation snapshot reconciles ghosts and rejects old generation events", async () => {
    const old = makePair(1, ["session-a"]);
    await old.client.run({ sessionId: "session-a", task: "old" });
    const oldSnapshot = await old.client.getPetProjectionSnapshot();
    expect(oldSnapshot.sessions).toHaveLength(1);

    const pending = new PendingDecisionIndex();
    pending.created({
      sessionId: "session-a",
      requestId: "old-request",
      workerGeneration: 1,
      kind: "ask_user",
      title: "old",
      createdAt: 1,
      surfaceable: true,
    });

    const fresh = makePair(2, []);
    const freshSnapshot = await fresh.client.getPetProjectionSnapshot();
    expect(freshSnapshot).toMatchObject({ workerGeneration: 2, sessions: [], pending: [] });
    pending.reconcileGeneration(
      freshSnapshot.workerGeneration,
      freshSnapshot.pending.map((entry) => ({
        sessionId: entry.agentSessionId,
        requestId: entry.requestId,
      })),
      freshSnapshot.observedAt,
    );
    expect(pending.get("session-a", "old-request")?.status).toBe("cancelled");

    const sessionIndex = new SessionIndex();
    sessionIndex.replaceCatalog({
      owner: "local-user",
      observedAt: 1,
      sessions: [{ sessionId: "session-a", updatedAt: 1 }],
    });
    sessionIndex.applyLiveSnapshot({
      generation: 2,
      version: 1,
      observedAt: 2,
      sessions: [],
    });
    expect(
      sessionIndex.applyStreamEvent({
        generation: 1,
        version: 99,
        observedAt: 3,
        sessionId: "session-a",
        event: { type: "stream_request_start", turnNumber: 1 },
      }),
    ).toBe(false);
    expect(sessionIndex.get("session-a")?.runState).toBe("dormant");

    old.server.close();
    old.client.close();
    fresh.server.close();
    fresh.client.close();
  });

  test("disconnect delta makes live state unknown and removes pending", async () => {
    const { client, manager, server } = makePair(4, ["session-a"]);
    await manager.getOrCreate("session-a", {} as never);
    const session = manager.get("session-a")!;
    void (server as any).requestAskUserForSession(session, "session-a", "choose");
    const deltas: PetProjectionDelta[] = [];
    client.onPetProjectionDelta((delta) => deltas.push(delta));
    const before = await client.getPetProjectionSnapshot();
    expect(before.pending).toHaveLength(1);

    server.close();
    await tick();
    expect(deltas).toContainEqual(
      expect.objectContaining({ kind: "worker-state", state: "disconnected" }),
    );
    expect(deltas).toContainEqual(
      expect.objectContaining({ kind: "pending-remove", requestId: before.pending[0]!.requestId }),
    );
    client.close();
  });

  test("real AskUser registration never exposes multiline question text in the Pet snapshot", async () => {
    const { client, manager, server } = makePair(4, ["session-sensitive"]);
    const session = await manager.getOrCreate("session-sensitive", {} as never);
    const question = [
      "联系人 Bob bob@example.com",
      "middle token-middle-123456789",
      "末尾 secret-tail-987654321",
    ].join("\n");

    void (server as any).requestAskUserForSession(session, "session-sensitive", question);
    const snapshot = await client.getPetProjectionSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.pending[0]?.title).toBe("需要用户回答");
    expect(serialized).not.toContain("Bob");
    expect(serialized).not.toContain("bob@example.com");
    expect(serialized).not.toContain("token-middle-123456789");
    expect(serialized).not.toContain("secret-tail-987654321");

    server.close();
    client.close();
  });

  test("never exposes the durable pet session as a work session or work pending", async () => {
    const { client, manager, server } = makePair(9, ["local-pet"], "pet");
    const session = await manager.getOrCreate("local-pet", {} as never);
    void (server as any).requestAskUserForSession(session, "local-pet", "pet-only question");

    const snapshot = await client.getPetProjectionSnapshot();
    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.pending).toEqual([]);

    server.close();
    client.close();
  });
});

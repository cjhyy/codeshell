import { describe, expect, test } from "bun:test";
import { SessionIndex } from "./session-index.js";

const catalog = [
  {
    sessionId: "work-a",
    title: "Work A",
    workspaceDisplayName: "alpha",
    updatedAt: 100,
    origin: "desktop" as const,
    kind: "work" as const,
  },
];

describe("SessionIndex", () => {
  test("projects disk-only work sessions without creating a live session", () => {
    const index = new SessionIndex();
    index.replaceCatalog({ owner: "local-user", sessions: catalog, observedAt: 110 });

    expect(index.list()).toEqual([
      expect.objectContaining({
        agentSessionId: "work-a",
        runState: "dormant",
        queueDepth: 0,
        title: "Work A",
        freshness: { source: "disk", observedAt: 110, workerState: "unknown" },
      }),
    ]);
  });

  test("maps live idle, queued, running and pending decision state", () => {
    const index = new SessionIndex();
    index.replaceCatalog({ owner: "local-user", sessions: catalog, observedAt: 100 });

    index.applyLiveSnapshot({
      generation: 1,
      version: 1,
      observedAt: 200,
      sessions: [{ sessionId: "work-a", busy: false, queueDepth: 0, lastActivityAt: 190 }],
    });
    expect(index.get("work-a")?.runState).toBe("idle");

    index.applyLiveSnapshot({
      generation: 1,
      version: 2,
      observedAt: 210,
      sessions: [{ sessionId: "work-a", busy: false, queueDepth: 2, lastActivityAt: 205 }],
    });
    expect(index.get("work-a")?.runState).toBe("queued");

    index.applyLiveSnapshot({
      generation: 1,
      version: 3,
      observedAt: 220,
      sessions: [{ sessionId: "work-a", busy: true, queueDepth: 1, lastActivityAt: 215 }],
    });
    expect(index.get("work-a")?.runState).toBe("running");

    index.setPendingDecisionCount("work-a", 1, {
      generation: 1,
      version: 4,
      observedAt: 230,
    });
    expect(index.get("work-a")).toMatchObject({
      runState: "running",
      phase: "waiting-decision",
      pendingDecisionCount: 1,
    });

    index.setPendingDecisionCount("work-a", 0, {
      generation: 1,
      version: 5,
      observedAt: 240,
    });
    expect(index.get("work-a")).toMatchObject({
      runState: "running",
      pendingDecisionCount: 0,
    });
    expect(index.get("work-a")?.phase).not.toBe("waiting-decision");
    expect(index.get("work-a")?.summary).not.toContain("等待用户决定");
  });

  test("waiting is a display phase and does not turn a dormant session into running", () => {
    const index = new SessionIndex();
    index.replaceCatalog({ owner: "local-user", sessions: catalog, observedAt: 100 });

    index.setPendingDecisionCount("work-a", 1, {
      generation: 1,
      version: 1,
      observedAt: 200,
    });

    expect(index.get("work-a")).toMatchObject({
      runState: "dormant",
      phase: "waiting-decision",
      pendingDecisionCount: 1,
    });
  });

  test("reduces ordered stream events and rejects stale versions", () => {
    const index = new SessionIndex();
    index.replaceCatalog({ owner: "local-user", sessions: catalog, observedAt: 100 });
    const event = (
      version: number,
      value: Parameters<SessionIndex["applyStreamEvent"]>[0]["event"],
    ) =>
      index.applyStreamEvent({
        sessionId: "work-a",
        generation: 2,
        version,
        observedAt: 300 + version,
        event: value,
      });

    event(1, { type: "stream_request_start", turnNumber: 1 });
    expect(index.get("work-a")).toMatchObject({
      runState: "running",
      phase: "model",
      summary: "模型处理中",
    });

    event(2, { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
    expect(index.get("work-a")).toMatchObject({ phase: "tool", summary: "正在运行 Bash" });

    event(3, { type: "context_compact", strategy: "summary", before: 20, after: 5 });
    expect(index.get("work-a")).toMatchObject({
      phase: "compacting",
      summary: "正在整理上下文",
    });

    event(4, { type: "turn_complete", reason: "completed" });
    expect(index.get("work-a")).toMatchObject({
      runState: "terminal",
      terminal: { status: "completed", at: 304 },
    });

    event(3, { type: "error", error: "stale secret" });
    expect(index.get("work-a")?.terminal?.status).toBe("completed");

    index.applyLiveSnapshot({
      generation: 2,
      version: 5,
      observedAt: 305,
      sessions: [{ sessionId: "work-a", busy: false, queueDepth: 2, lastActivityAt: 305 }],
    });
    expect(index.get("work-a")?.runState).toBe("queued");

    event(6, { type: "error", error: "token sk-test-secret" });
    expect(index.get("work-a")).toMatchObject({
      runState: "terminal",
      summary: "运行失败",
      terminal: { status: "failed", at: 306 },
    });
  });

  test("builds safe bounded summaries without copying event payloads", () => {
    const index = new SessionIndex();
    index.replaceCatalog({ owner: "local-user", sessions: catalog, observedAt: 100 });
    index.applyStreamEvent({
      sessionId: "work-a",
      generation: 1,
      version: 1,
      observedAt: 200,
      event: {
        type: "tool_use_start",
        toolCall: {
          id: "t1",
          toolName: "Bash\nsk-secret-that-must-not-leak-and-is-intentionally-very-long",
          args: { command: "rm -rf /", token: "sk-another-secret" },
        },
      },
    });

    const summary = index.get("work-a")?.summary ?? "";
    expect(summary).not.toContain("\n");
    expect(summary).not.toContain("rm -rf");
    expect(summary).not.toContain("another-secret");
    expect(summary.length).toBeLessThanOrEqual(64);
  });

  test("distinguishes abnormal disconnect from normal worker reclaim", () => {
    const makeRunning = () => {
      const index = new SessionIndex();
      index.replaceCatalog({ owner: "local-user", sessions: catalog, observedAt: 100 });
      index.applyLiveSnapshot({
        generation: 1,
        version: 1,
        observedAt: 200,
        sessions: [{ sessionId: "work-a", busy: true, queueDepth: 0, lastActivityAt: 200 }],
      });
      return index;
    };

    const disconnected = makeRunning();
    disconnected.applyWorkerLifecycle({
      state: "disconnected",
      generation: 1,
      version: 2,
      observedAt: 210,
    });
    expect(disconnected.get("work-a")).toMatchObject({
      runState: "unknown",
      title: "Work A",
      freshness: { workerState: "disconnected" },
    });

    const reclaimed = makeRunning();
    reclaimed.applyWorkerLifecycle({
      state: "reclaimed",
      generation: 1,
      version: 2,
      observedAt: 210,
    });
    expect(reclaimed.get("work-a")).toMatchObject({
      runState: "dormant",
      title: "Work A",
      freshness: { source: "disk", workerState: "reclaimed" },
    });
  });

  test("filters non-local, pet, ephemeral and sub-agent catalog entries", () => {
    const index = new SessionIndex();
    index.replaceCatalog({
      owner: "another-user" as "local-user",
      observedAt: 100,
      sessions: catalog,
    });
    expect(index.list()).toEqual([]);

    index.replaceCatalog({
      owner: "local-user",
      observedAt: 110,
      sessions: [
        ...catalog,
        { sessionId: "pet", updatedAt: 1, kind: "pet" },
        { sessionId: "quick", updatedAt: 2, ephemeral: true },
        { sessionId: "child", updatedAt: 3, origin: "subagent" },
        { sessionId: "owned-child", updatedAt: 4, parentSessionId: "work-a" },
      ],
    });
    expect(index.list().map((session) => session.agentSessionId)).toEqual(["work-a"]);
  });
});

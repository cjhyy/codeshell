import { describe, expect, test } from "bun:test";
import type { Engine, EngineResult } from "../engine/engine.js";
import type { EngineRunOptions } from "../engine/run-types.js";
import { NotificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { createWorkspaceContext } from "../workspace/workspace-context.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { wakeSessionForBackgroundResults } from "./background-result-wakeup.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const runs: Array<{ task: string; options: EngineRunOptions }> = [];
  const manual = deferred<void>();
  const engine = {
    isHeadless: () => false,
    resolveSessionRunWorkspace: () => {
      throw new Error("cold Engine has no WorkspaceContext");
    },
    async run(task: string, options: EngineRunOptions): Promise<EngineResult> {
      runs.push({ task, options });
      if (task === "manual") await manual.promise;
      return {
        text: "done",
        reason: "completed",
        sessionId: "source",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  const manager = new ChatSessionManager({ runtime: {} as never, engineFactory: () => engine });
  const session = await manager.getOrCreate("source", { cwd: "/project" });
  const notificationMailbox = new NotificationQueue();
  notificationMailbox.enqueue(
    {
      agentId: "target-result",
      name: "target",
      description: "saved target reply",
      finalText: "Facts already collected",
      status: "completed",
      enqueuedAt: 1,
    },
    "source",
  );
  const options = {
    sessionId: "source",
    manager,
    rehydrate: async () => session,
    approvalRouter: {} as never,
    onStream() {},
    notificationMailbox,
  };
  return { manager, session, notificationMailbox, runs, options, manual };
}

describe("asynchronous authority for background-result wakeups", () => {
  test("a goal waiting for the user keeps results until the user resumes it", async () => {
    const f = await fixture();
    const original = f.notificationMailbox.getSnapshot("source")[0]!;
    let blocked = true;
    f.session.engine.isGoalContinuationBlocked = () => blocked;
    const options = { ...f.options, resolveWorkspace: async () => ({}) };
    expect(await wakeSessionForBackgroundResults(options)).toBe(false);
    expect(f.runs).toHaveLength(0);
    expect(f.notificationMailbox.getSnapshot("source")).toEqual([original]);
    blocked = false; // A real answer re-arms the persisted lifecycle.
    expect(await wakeSessionForBackgroundResults(options)).toBe(true);
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]?.task).toContain("Facts already collected");
    expect(f.notificationMailbox.getSnapshot("source")).toHaveLength(0);
  });

  test("a question asked during workspace resolution holds the queued result", async () => {
    const f = await fixture();
    let blocked = false;
    f.session.engine.isGoalContinuationBlocked = () => blocked;
    const gate = deferred<{ cwd: string }>();
    const waking = wakeSessionForBackgroundResults({
      ...f.options,
      resolveWorkspace: () => gate.promise,
    });
    blocked = true;
    gate.resolve({ cwd: "/project" });
    expect(await waking).toBe(false);
    expect(f.runs).toHaveLength(0);
    expect(f.notificationMailbox.getSnapshot("source")).toHaveLength(1);
  });

  test("a user-wait transition while reserving restores the notification", async () => {
    const f = await fixture();
    const original = f.notificationMailbox.getSnapshot("source")[0]!;
    let blocked = false;
    f.session.engine.isGoalContinuationBlocked = () => blocked;
    const unsubscribe = f.notificationMailbox.subscribe(() => {
      blocked = true;
    });
    try {
      expect(
        await wakeSessionForBackgroundResults({
          ...f.options,
          resolveWorkspace: async () => ({}),
        }),
      ).toBe(false);
      expect(f.runs).toHaveLength(0);
      expect(f.notificationMailbox.getSnapshot("source")).toEqual([original]);
    } finally {
      unsubscribe();
    }
  });

  test.each([false, true])(
    "Stop after a turn with Goal=%s holds the completion",
    async (withGoal) => {
      const f = await fixture();
      const original = f.notificationMailbox.getSnapshot("source")[0]!;
      const manual = f.session.enqueueTurn(
        "manual",
        withGoal ? { goal: "finish background work" } : {},
      );
      f.session.cancel();
      f.manual.resolve();
      await manual;
      expect(
        await wakeSessionForBackgroundResults({ ...f.options, resolveWorkspace: async () => ({}) }),
      ).toBe(false);
      expect(f.runs).toHaveLength(1);
      expect(f.notificationMailbox.getSnapshot("source")).toEqual([original]);
    },
  );

  test.each([false, true])(
    "provider failure after output=%s only restores an unaccepted result",
    async (output) => {
      const f = await fixture();
      const original = f.notificationMailbox.getSnapshot("source")[0]!;
      f.session.engine.run = async (_task, options) => {
        if (output)
          options?.onStream?.({ type: "text_delta", text: "Already acted on the result" });
        throw new Error("provider failed");
      };
      expect(
        await wakeSessionForBackgroundResults({ ...f.options, resolveWorkspace: async () => ({}) }),
      ).toBe(false);
      expect(f.notificationMailbox.getSnapshot("source")).toEqual(output ? [] : [original]);
    },
  );

  test.each([false, true])(
    "a returned model error with attempted turnCount=1 and output=%s uses provider evidence",
    async (output) => {
      const f = await fixture();
      const original = f.notificationMailbox.getSnapshot("source")[0]!;
      f.session.engine.run = async (_task, options) => {
        options?.onStream?.({ type: "stream_request_start", turnNumber: 1 });
        if (output) options?.onStream?.({ type: "text_delta", text: "provider accepted" });
        options?.onStream?.({ type: "usage_update", promptTokens: 0 });
        options?.onStream?.({ type: "turn_complete", reason: "model_error" });
        return {
          text: "failed",
          reason: "model_error",
          sessionId: "source",
          turnCount: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      };
      expect(
        await wakeSessionForBackgroundResults({ ...f.options, resolveWorkspace: async () => ({}) }),
      ).toBe(output);
      expect(f.notificationMailbox.getSnapshot("source")).toEqual(output ? [] : [original]);
    },
  );

  test("a mailbox reset prevents a rejected old run from restoring into its successor", async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    f.session.engine.run = async () => {
      entered.resolve();
      await release.promise;
      throw new Error("old launch failed");
    };
    const waking = wakeSessionForBackgroundResults({
      ...f.options,
      resolveWorkspace: async () => ({}),
    });
    await entered.promise;
    f.notificationMailbox.reset("source");
    const successor = f.notificationMailbox.enqueue(
      {
        agentId: "new",
        description: "new work",
        finalText: "new result",
        status: "completed",
        enqueuedAt: 2,
      },
      "source",
    );
    release.resolve();
    expect(await waking).toBe(false);
    expect(f.notificationMailbox.getSnapshot("source")).toEqual([successor]);
  });

  test("a host completion without a model turn cannot acknowledge the result", async () => {
    const f = await fixture();
    const original = f.notificationMailbox.getSnapshot("source")[0]!;
    f.session.engine.run = async (_task, options) => {
      options?.onStream?.({ type: "turn_complete", reason: "completed" });
      return {
        text: "input skipped",
        reason: "completed",
        sessionId: "source",
        turnCount: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    };
    expect(
      await wakeSessionForBackgroundResults({ ...f.options, resolveWorkspace: async () => ({}) }),
    ).toBe(false);
    expect(f.notificationMailbox.getSnapshot("source")).toEqual([original]);
  });

  test("a completion arriving during delivery stays available for the next continuation", async () => {
    const f = await fixture();
    const run = f.session.engine.run.bind(f.session.engine);
    const entered = deferred<void>();
    const release = deferred<void>();
    f.session.engine.run = async (task, options) => {
      entered.resolve();
      await release.promise;
      return run(task, options);
    };
    const waking = wakeSessionForBackgroundResults({
      ...f.options,
      resolveWorkspace: async () => ({}),
    });
    await entered.promise;
    const next = f.notificationMailbox.enqueue(
      {
        agentId: "next",
        description: "next work",
        finalText: "queued completion",
        status: "completed",
        enqueuedAt: 2,
      },
      "source",
    );
    release.resolve();
    expect(await waking).toBe(true);
    expect(f.notificationMailbox.getSnapshot("source")).toEqual([next]);
    expect(
      await wakeSessionForBackgroundResults({ ...f.options, resolveWorkspace: async () => ({}) }),
    ).toBe(true);
    expect(f.runs).toHaveLength(2);
    expect(f.runs[0]!.task).not.toContain("queued completion");
    expect(f.runs[1]!.task).toContain("queued completion");
    expect(f.notificationMailbox.getSnapshot("source")).toEqual([]);
  });

  test("host context lets a cold bound Session consume its saved result", async () => {
    const f = await fixture();
    const workspaceContext = createWorkspaceContext({
      projectId: "project",
      projectRevision: 2,
      sessionMainRootId: "root",
      roots: [{ id: "root", path: "/current-worktree", role: "primary" }],
    });
    const gate = deferred<{ cwd: string; workspaceContext: typeof workspaceContext }>();
    const waking = wakeSessionForBackgroundResults({
      ...f.options,
      resolveWorkspace: () => gate.promise,
    });
    expect(f.runs).toHaveLength(0);
    expect(f.notificationMailbox.getSnapshot("source")).toHaveLength(1);
    gate.resolve({ cwd: "/current-worktree", workspaceContext });
    expect(await waking).toBe(true);
    expect(f.runs[0]?.options).toMatchObject({
      cwd: "/current-worktree",
      workspaceContext,
      injected: true,
    });
    expect(f.runs[0]?.task).toContain("Facts already collected");
    expect(f.notificationMailbox.getSnapshot("source")).toHaveLength(0);
  });

  test("host failure leaves the result available for a later attempt", async () => {
    const f = await fixture();
    expect(
      await wakeSessionForBackgroundResults({
        ...f.options,
        resolveWorkspace: async () => {
          throw new Error("project root is unavailable");
        },
      }),
    ).toBe(false);
    expect(f.runs).toHaveLength(0);
    expect(f.notificationMailbox.getSnapshot("source")).toHaveLength(1);
  });

  test("Stop during authority resolution prevents a wake without draining the result", async () => {
    const f = await fixture();
    const gate = deferred<{ cwd: string }>();
    const waking = wakeSessionForBackgroundResults({
      ...f.options,
      resolveWorkspace: () => gate.promise,
    });
    f.session.cancel();
    gate.resolve({ cwd: "/project" });
    expect(await waking).toBe(false);
    expect(f.runs).toHaveLength(0);
    expect(f.notificationMailbox.getSnapshot("source")).toHaveLength(1);
  });

  test("a Session closed during resolution is never recreated by the wake", async () => {
    const f = await fixture();
    const gate = deferred<{ cwd: string }>();
    const waking = wakeSessionForBackgroundResults({
      ...f.options,
      resolveWorkspace: () => gate.promise,
    });
    await f.manager.close("source");
    gate.resolve({ cwd: "/project" });
    expect(await waking).toBe(false);
    expect(f.manager.get("source")).toBeUndefined();
    expect(f.runs).toHaveLength(0);
    expect(f.notificationMailbox.getSnapshot("source")).toHaveLength(1);
  });

  test("an intervening user turn is awaited and workspace authority is resolved again", async () => {
    const f = await fixture();
    const gate = deferred<{ cwd: string }>();
    let resolutions = 0;
    const waking = wakeSessionForBackgroundResults({
      ...f.options,
      resolveWorkspace: async () => {
        resolutions++;
        return resolutions === 1 ? gate.promise : { cwd: "/fresh-worktree" };
      },
    });
    const manual = f.session.enqueueTurn("manual", {});
    gate.resolve({ cwd: "/stale-worktree" });
    await Promise.resolve();
    expect(f.runs).toHaveLength(1);
    expect(f.notificationMailbox.getSnapshot("source")).toHaveLength(1);
    f.manual.resolve();
    await manual;
    expect(await waking).toBe(true);
    expect(resolutions).toBe(2);
    expect(f.runs[1]?.options.cwd).toBe("/fresh-worktree");
  });

  test("empty mailboxes do not rehydrate or request host context", async () => {
    const f = await fixture();
    f.notificationMailbox.drainAll("source");
    let resolutions = 0;
    expect(
      await wakeSessionForBackgroundResults({
        ...f.options,
        resolveWorkspace: async () => {
          resolutions++;
          return {};
        },
      }),
    ).toBe(false);
    expect(resolutions).toBe(0);
    expect(f.runs).toHaveLength(0);
  });
});

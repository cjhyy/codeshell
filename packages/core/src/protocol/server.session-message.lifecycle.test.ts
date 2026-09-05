import { describe, expect, test } from "bun:test";
import type { Engine, EngineResult } from "../engine/engine.js";
import type { EngineRunOptions } from "../engine/run-types.js";
import type {
  RouteSessionMessageInput,
  SessionMessageReceipt,
} from "../session/session-message.js";
import { NotificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const completed = (sessionId = "message-target"): EngineResult => ({
  sessionId,
  text: "existing facts",
  reason: "completed",
  turnCount: 1,
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

async function fixture(
  targetRun: (task: string, options: EngineRunOptions) => Promise<EngineResult>,
  wakeSource = false,
) {
  const sourceRan = deferred<string>();
  const mailbox = new NotificationQueue();
  const sent: any[] = [];
  const sourceRuns: string[] = [];
  const manager = new ChatSessionManager({
    runtime: {} as never,
    engineFactory: () =>
      ({
        isHeadless: () => !wakeSource,
        sessionExistsOnDisk: () => false,
        getSessionManager: () => ({
          readSessionMainRoot: () => "/message-project",
          readSessionProjectBinding: () => undefined,
          getSessionWorkspace: () => ({ root: "/message-project", kind: "main" }),
        }),
        setAskUser() {},
        setBrowserBridge() {},
        setInjectCredential() {},
        setSessionMessageRouter() {},
        run: async (task: string, options: EngineRunOptions) => {
          if (options.sessionId === "message-source") {
            sourceRuns.push(task);
            sourceRan.resolve(task);
            return completed("message-source");
          }
          return targetRun(task, options);
        },
      }) as unknown as Engine,
  });
  // Avoid production closeAll's process-wide background work cleanup.
  manager.closeAll = () => {};
  await manager.getOrCreate("message-source", { cwd: "/message-project" });
  const server = new AgentServer({
    chatManager: manager,
    notificationMailbox: mailbox,
    ownsBackgroundWakeups: wakeSource,
    transport: { send: (event: unknown) => sent.push(event), onMessage() {}, close() {} } as never,
  });
  const input: RouteSessionMessageInput = {
    sourceSessionId: "message-source",
    target: { sessionId: "message-target", title: "Target", workspaceRoot: "/message-project" },
    message: "report existing facts",
    catalog: [],
  };
  return {
    manager,
    mailbox,
    sent,
    sourceRuns,
    sourceRan,
    input,
    route: (value = input) =>
      (
        server as unknown as {
          routeSessionMessage(input: RouteSessionMessageInput): Promise<SessionMessageReceipt>;
        }
      ).routeSessionMessage(value),
    async close() {
      server.close();
      await Promise.all([manager.close("message-source"), manager.close("message-target")]);
    },
  };
}

describe("cross-Session dispatch lifecycle", () => {
  test("returns a fast result directly without also posting a duplicate reply", async () => {
    const f = await fixture(async () => completed());
    try {
      expect(await f.route()).toMatchObject({
        status: "completed",
        result: { text: "existing facts" },
      });
      expect(f.mailbox.getSnapshot("message-source")).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  test("rejects a resolved zero-turn failure instead of treating it as a completed dispatch", async () => {
    const f = await fixture(async () => ({
      ...completed(),
      reason: "model_error",
      turnCount: 0,
      text: "missing workspace",
    }));
    try {
      await expect(f.route()).rejects.toThrow("missing workspace");
      expect(f.mailbox.getSnapshot("message-source")).toHaveLength(0);
      expect(
        f.sent.some((message) => message.params?.event?.error?.includes("missing workspace")),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

  test("a late setup rejection is reported once to the sender after acknowledgement", async () => {
    const gate = deferred<EngineResult>();
    const f = await fixture(() => gate.promise);
    try {
      const receipt = await f.route();
      expect(receipt.status).toBe("queued");
      gate.reject(new Error("profile unavailable after async setup"));
      await f.manager.get("message-target")!.settled;
      expect(f.mailbox.getSnapshot("message-source")).toHaveLength(1);
      expect(f.mailbox.getSnapshot("message-source")[0]).toMatchObject({
        correlationId: receipt.messageId,
        payload: { status: "failed", error: "profile unavailable after async setup" },
      });
    } finally {
      gate.resolve(completed());
      await f.close();
    }
  });

  test("a started target posts its answer and wakes the source exactly once", async () => {
    const gate = deferred<EngineResult>();
    const f = await fixture(async (_task, options) => {
      options.onStream?.({ type: "session_started", sessionId: "message-target", promptTokens: 0 });
      return gate.promise;
    }, true);
    try {
      expect((await f.route()).status).toBe("started");
      gate.resolve(completed());
      expect(await f.sourceRan.promise).toContain("existing facts");
      await f.manager.get("message-source")!.settled;
      expect(f.sourceRuns).toHaveLength(1);
      expect(f.mailbox.getSnapshot("message-source")).toHaveLength(0);
      expect(f.mailbox.getSnapshot("message-target")).toHaveLength(0);
    } finally {
      gate.resolve(completed());
      await f.close();
    }
  });

  test("cancelling a busy target reports its queued message as cancelled without running it", async () => {
    const busy = deferred<EngineResult>();
    const tasks: string[] = [];
    const f = await fixture(async (task) => {
      tasks.push(task);
      return busy.promise;
    });
    try {
      const target = await f.manager.getOrCreate("message-target", { cwd: "/message-project" });
      const first = target.enqueueTurn("earlier work", {});
      const receipt = await f.route();
      expect(receipt.status).toBe("queued");
      target.cancel();
      busy.resolve(completed());
      await first;
      await target.settled;
      expect(tasks).toEqual(["earlier work"]);
      expect(f.mailbox.getSnapshot("message-source")).toHaveLength(1);
      expect(f.mailbox.getSnapshot("message-source")[0]).toMatchObject({
        correlationId: receipt.messageId,
        payload: { status: "cancelled" },
      });
    } finally {
      busy.resolve(completed());
      await f.close();
    }
  });

  test("a cancelled sender cannot dispatch work", async () => {
    const tasks: string[] = [];
    const f = await fixture(async (task) => {
      tasks.push(task);
      return completed();
    });
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(f.route({ ...f.input, signal: controller.signal })).rejects.toThrow();
      expect(tasks).toEqual([]);
      expect(f.manager.get("message-target")).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});

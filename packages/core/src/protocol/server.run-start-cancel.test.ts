import { afterEach, expect, test } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { ApprovalRouter } from "../tool-system/permission.js";
import type { Engine, EngineResult } from "../engine/engine.js";
import type { Transport } from "./transport.js";
import { ErrorCodes } from "./types.js";

const servers: AgentServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function managerFixture() {
  const runs: Array<{ task: string; sessionId: string; signal: AbortSignal }> = [];
  const manager = new ChatSessionManager({
    runtime: {} as never,
    engineFactory: () =>
      ({
        setAskUser() {},
        setBrowserBridge() {},
        setInjectCredential() {},
        setSessionMessageRouter() {},
        setPlanMode() {},
        isHeadless: () => false,
        async run(
          task: string,
          options: { sessionId: string; signal: AbortSignal },
        ): Promise<EngineResult> {
          runs.push({ task, ...options });
          if (task === "hold") {
            await new Promise<void>((_resolve, reject) => {
              const cancel = () => reject(new DOMException("Stopped", "AbortError"));
              if (options.signal.aborted) cancel();
              else options.signal.addEventListener("abort", cancel, { once: true });
            });
          }
          return {
            text: task,
            reason: "completed",
            sessionId: options.sessionId,
            turnCount: 1,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
      }) as unknown as Engine,
  });
  return { manager, runs, router: new ApprovalRouter() };
}

function connect(fixture: ReturnType<typeof managerFixture>, connectionId = "run-start-test") {
  const sent: any[] = [];
  let receive: (message: unknown) => void = () => {};
  const transport: Transport = {
    send: (message) => {
      sent.push(message);
    },
    onMessage: (callback) => {
      receive = callback;
    },
    close() {},
  };
  const server = new AgentServer({
    transport,
    chatManager: fixture.manager,
    connectionId,
    approvalRouter: fixture.router,
    ownsBackgroundWakeups: false,
  });
  servers.push(server);
  const send = (id: number, method: string, params: unknown) =>
    receive({ jsonrpc: "2.0", id, method, params });
  const run = (id: number, sessionId = "session", task = "hello") =>
    send(id, "agent/run", { sessionId, task });
  const cancel = (id: number, sessionId = "session") => send(id, "agent/cancel", { sessionId });
  const reply = async (id: number) => {
    await until(() => sent.some((message) => message.id === id));
    return sent.find((message) => message.id === id);
  };
  const accepted = () => sent.filter((message) => message.method === "agent/runAccepted");
  return { server, sent, send, run, cancel, reply, accepted };
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Protocol fixture did not settle");
}

function aborted(reply: any, sessionId = "session") {
  expect(reply.error).toBeUndefined();
  expect(reply.result).toEqual({
    text: "",
    reason: "aborted_streaming",
    sessionId,
    turnCount: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
}

test("run followed synchronously by Stop never enters the newly created idle engine", async () => {
  const f = managerFixture();
  const client = connect(f);
  client.run(1);
  expect(f.manager.get("session")).toBeDefined();
  client.cancel(2);
  expect((await client.reply(2)).result).toEqual({ ok: true });
  aborted(await client.reply(1));
  expect(f.runs).toHaveLength(0);
  expect(client.accepted()).toHaveLength(0);
  expect(client.sent.some((message) => message.method === "agent/streamEvent")).toBe(false);
  expect(f.manager.get("session")!.isBusy()).toBe(false);
});

test("an intentional new run sent immediately after Stop is not cancelled by the old preparation", async () => {
  const f = managerFixture();
  const client = connect(f);
  client.run(1, "session", "old");
  client.run(2, "session", "old queued preparation");
  client.cancel(3);
  client.run(4, "session", "new");
  aborted(await client.reply(1));
  aborted(await client.reply(2));
  expect((await client.reply(4)).result.text).toBe("new");
  expect(f.runs.map((run) => run.task)).toEqual(["new"]);
  expect(client.accepted().map((message) => message.params.requestId)).toEqual([4]);
});

test("Stop settles lifecycle waiters without creating an engine or leaving a cancellation tombstone", async () => {
  const f = managerFixture();
  const client = connect(f);
  expect(f.manager.beginSessionMigration("session", "claim").status).toBe("not-resident");
  client.run(1, "session", "old one");
  client.run(2, "session", "old two");
  client.cancel(3);
  expect((await client.reply(3)).result).toEqual({ ok: true });
  aborted(await client.reply(1));
  aborted(await client.reply(2));
  expect(f.manager.get("session")).toBeUndefined();
  client.cancel(4);
  expect((await client.reply(4)).error.code).toBe(ErrorCodes.SessionClosed);
  client.run(5, "session", "fresh after Stop");
  expect(f.manager.completeSessionMigration("session", "claim")).toBe(true);
  expect((await client.reply(5)).result.text).toBe("fresh after Stop");
  expect(f.runs.map((run) => run.task)).toEqual(["fresh after Stop"]);
});

test("a second connection cancels pending starts in the same manager without crossing manager identity", async () => {
  const f = managerFixture();
  const a = connect(f, "connection-a");
  const b = connect(f, "connection-b");
  const separate = managerFixture();
  const c = connect(separate, "other-identity");
  a.run(1);
  c.run(1);
  b.cancel(2);
  aborted(await a.reply(1));
  expect((await b.reply(2)).result).toEqual({ ok: true });
  expect((await c.reply(1)).result.reason).toBe("completed");
  expect(f.runs).toHaveLength(0);
  expect(separate.runs).toHaveLength(1);
});

test("Stop drains active, queued and not-yet-queued requests while a newer task still runs once", async () => {
  const f = managerFixture();
  const client = connect(f);
  client.run(1, "session", "hold");
  await until(() => f.runs.length === 1);
  client.run(2, "session", "queued");
  await until(() => f.manager.get("session")!.queueDepth() === 1);
  client.run(3, "session", "still preparing");
  client.cancel(4);
  client.run(5, "session", "new");
  aborted(await client.reply(1));
  // Preserve the existing queued-turn error contract; the startup fence owns
  // only the requests which have not reached ChatSession.enqueueTurn yet.
  expect((await client.reply(2)).error.message).toContain("cancelled");
  aborted(await client.reply(3));
  expect((await client.reply(5)).result.text).toBe("new");
  expect(f.runs.map((run) => run.task)).toEqual(["hold", "new"]);
  expect(f.runs[0]!.signal.aborted).toBe(true);
  expect(f.runs[1]!.signal.aborted).toBe(false);
});

test("an approval request cannot cancel a run which is still preparing", async () => {
  const f = managerFixture();
  const client = connect(f);
  client.run(1);
  client.send(2, "agent/approve", {
    sessionId: "session",
    requestId: "missing",
    decision: { approved: true },
  });
  expect((await client.reply(2)).error).toBeDefined();
  expect((await client.reply(1)).result.reason).toBe("completed");
  expect(f.runs).toHaveLength(1);
});

test("disconnect cancels only that connection's pending preparation", async () => {
  const f = managerFixture();
  const a = connect(f, "disconnecting");
  const b = connect(f, "surviving");
  a.run(1, "session", "disconnected");
  a.server.disconnect();
  b.run(2, "session", "surviving");
  aborted(await a.reply(1));
  expect((await b.reply(2)).result.text).toBe("surviving");
  expect(f.runs.map((run) => run.task)).toEqual(["surviving"]);
});

test("explicit close fences an earlier lifecycle waiter before it can reopen the session", async () => {
  const f = managerFixture();
  const client = connect(f);
  f.manager.beginSessionMigration("session", "claim");
  client.run(1);
  client.send(2, "agent/closeSession", { sessionId: "session" });
  aborted(await client.reply(1));
  expect((await client.reply(2)).result).toEqual({ ok: true });
  f.manager.completeSessionMigration("session", "claim");
  expect(f.manager.get("session")).toBeUndefined();
  expect(f.runs).toHaveLength(0);
  client.run(3, "session", "explicit reopen");
  expect((await client.reply(3)).result.text).toBe("explicit reopen");
});

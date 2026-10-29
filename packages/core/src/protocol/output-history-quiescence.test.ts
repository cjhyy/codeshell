import { afterEach, expect, test } from "bun:test";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";
import { NotificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { backgroundJobRegistry } from "../tool-system/builtin/background-jobs.js";
import { closeIdleOutputHistorySession } from "./output-history-quiescence.js";
import type { Engine } from "../engine/engine.js";
import type { EngineRuntime } from "../engine/runtime.js";

afterEach(() => backgroundJobRegistry.reset());
async function fixture() {
  const manager = new ChatSessionManager({
    runtime: {} as EngineRuntime,
    engineFactory: () => ({}) as Engine,
  });
  const session = await manager.getOrCreate("synthetic-history", {});
  const mailbox = new NotificationQueue(),
    sent: any[] = [];
  let deliver!: (value: unknown) => void;
  new AgentServer({
    chatManager: manager,
    notificationMailbox: mailbox,
    ownsBackgroundWakeups: false,
    transport: {
      send: (value) => sent.push(value),
      onMessage(callback) {
        deliver = callback;
      },
      close() {},
    } as any,
  });
  return { manager, session, mailbox, sent, deliver };
}
test("actual closeSession idle RPC retains completed background history", async () => {
  const f = await fixture();
  backgroundJobRegistry.start("completed-history", f.session.id, "synthetic");
  backgroundJobRegistry.finish("completed-history");
  f.deliver({
    jsonrpc: "2.0",
    id: 1,
    method: "agent/closeSession",
    params: { sessionId: f.session.id, onlyIfIdle: true },
  });
  for (let n = 0; n < 50 && !f.sent.some((value) => value.id === 1); n++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(f.sent.find((value) => value.id === 1)?.result).toEqual({ ok: true });
  expect(f.manager.get(f.session.id)).toBeUndefined();
  expect(backgroundJobRegistry.listForSession(f.session.id)).toHaveLength(1);
});
test.each(["background", "approval", "pending start"])(
  "idle recovery never cancels %s",
  async (kind) => {
    const f = await fixture();
    if (kind === "background")
      backgroundJobRegistry.start("live-history", f.session.id, "synthetic");
    if (kind === "approval") f.session.pendingApprovals.set("old-request", {} as any);
    await closeIdleOutputHistorySession(
      { jsonrpc: "2.0", id: 1, method: "agent/closeSession", params: { sessionId: f.session.id } },
      { send: (value) => f.sent.push(value) },
      {
        manager: f.manager,
        mailbox: f.mailbox,
        pendingStarts: kind === "pending start",
        closed() {
          throw new Error("must not close");
        },
      },
    );
    expect(f.sent.find((value) => value.id === 1)?.error).toBeDefined();
    expect(f.manager.get(f.session.id)).toBe(f.session);
    if (kind === "background")
      expect(backgroundJobRegistry.listForSession(f.session.id)[0]?.status).toBe("running");
    f.session.pendingApprovals.clear();
    await f.manager.close(f.session.id);
  },
);

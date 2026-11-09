import { describe, expect, test } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { Methods } from "./types.js";
import { HOST_ACTION_TOOL_NAME } from "./host-action.js";
import { compileComposition } from "../composition/compiler.js";
import type { Engine } from "../engine/engine.js";
import type { ProtocolObserverHost } from "../tool-system/capability-module.js";

function makeTransport() {
  const sent: any[] = [];
  let onMsg: (msg: unknown) => void = () => {};
  return {
    sent,
    deliver: (msg: unknown) => onMsg(msg),
    transport: {
      send: (m: unknown) => sent.push(m),
      onMessage: (cb: (msg: unknown) => void) => {
        onMsg = cb;
      },
      close: () => {},
    } as any,
  };
}

async function waitFor<T>(read: () => T | undefined, message: string): Promise<T> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function fixture() {
  let host: ProtocolObserverHost | undefined;
  const composition = compileComposition({
    modules: [
      {
        id: "host-action-observer",
        protocol: {
          createObserver(ctx) {
            host = ctx;
            return {};
          },
        },
      },
    ],
  });
  const chatManager = new ChatSessionManager({
    runtime: {} as never,
    engineFactory: () =>
      ({
        setAskUser() {},
        setSessionMessageRouter() {},
        isHeadless: () => false,
        dispose() {},
      }) as unknown as Engine,
  });
  const t = makeTransport();
  const server = new AgentServer({ transport: t.transport, chatManager, composition });
  await (server as any).moduleReady;
  const session = await chatManager.getOrCreate("sess-host", {});
  const findRequest = () =>
    waitFor(
      () =>
        t.sent.find(
          (m) =>
            m.method === Methods.ApprovalRequest &&
            m.params?.request?.toolName === HOST_ACTION_TOOL_NAME,
        ),
      "host action request should be emitted",
    );
  const answer = (requestId: string, payload: unknown) =>
    t.deliver({
      jsonrpc: "2.0",
      id: 99,
      method: Methods.Approve,
      params: {
        sessionId: "sess-host",
        requestId,
        decision: {
          approved: true,
          answer: typeof payload === "string" ? payload : JSON.stringify(payload),
        },
      },
    });
  return { host: host!, server, session, chatManager, t, findRequest, answer };
}

describe("AgentServer host action loopback", () => {
  test("observer host exposes requestHostAction and emits a __host_action__ request", async () => {
    const f = await fixture();
    expect(typeof f.host.requestHostAction).toBe("function");
    const pending = f.host.requestHostAction!("sess-host", "notice.create", { title: "x" });
    const request = await f.findRequest();
    expect(request.params.sessionId).toBe("sess-host");
    expect(request.params.request.args).toEqual({
      action: "notice.create",
      args: { title: "x" },
    });
    expect(f.session.pendingApprovals.has(request.params.requestId)).toBe(true);
    expect(f.session.pendingApprovals.get(request.params.requestId)?.metadata.surfaceable).toBe(
      false,
    );
    f.answer(request.params.requestId, { ok: true, id: "rule-1" });
    expect(await pending).toEqual({ ok: true, id: "rule-1" });
    expect(f.session.pendingApprovals.size).toBe(0);
    expect((f.server as any).approvalTimers.size).toBe(0);
    await f.server.close();
  });

  test("rejects with the host error when the reply is ok:false", async () => {
    const f = await fixture();
    const pending = f.host.requestHostAction!("sess-host", "notice.create", {});
    const request = await f.findRequest();
    f.answer(request.params.requestId, { ok: false, error: "unknown host action: notice.create" });
    await expect(pending).rejects.toThrow("unknown host action: notice.create");
    await f.server.close();
  });

  test("rejects a non-object reply as malformed", async () => {
    const f = await fixture();
    const pending = f.host.requestHostAction!("sess-host", "notice.create", {});
    const request = await f.findRequest();
    f.answer(request.params.requestId, "42");
    await expect(pending).rejects.toThrow(/malformed|invalid/i);
    await f.server.close();
  });

  test("rejects when the session is not live without emitting a request", async () => {
    const f = await fixture();
    await expect(f.host.requestHostAction!("missing-session", "notice.create", {})).rejects.toThrow(
      "session not live",
    );
    expect(
      f.t.sent.some(
        (m) =>
          m.method === Methods.ApprovalRequest &&
          m.params?.request?.toolName === HOST_ACTION_TOOL_NAME,
      ),
    ).toBe(false);
    await f.server.close();
  });
});

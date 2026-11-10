import { createFakeEngine } from "../testing/create-fake-engine.js";
import { describe, expect, test } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { Methods } from "./types.js";
import { HOST_ACTION_TOOL_NAME } from "./host-action.js";
import { compileComposition } from "../composition/compiler.js";

import type { ProtocolObserverHost } from "../tool-system/capability-module.js";

function makeTransport(failSend?: (m: any) => boolean) {
  const sent: any[] = [];
  let onMsg: (msg: unknown) => void = () => {};
  return {
    sent,
    deliver: (msg: unknown) => onMsg(msg),
    transport: {
      send: (m: unknown) => {
        if (failSend?.(m)) throw new TypeError("Do not know how to serialize a BigInt");
        sent.push(m);
      },
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

const isHostActionRequest = (m: any) =>
  m?.method === Methods.ApprovalRequest && m.params?.request?.toolName === HOST_ACTION_TOOL_NAME;

async function fixture(failSend?: (m: any) => boolean) {
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
      createFakeEngine({
        isHeadless: () => false,
        dispose() {},
      }),
  });
  const t = makeTransport(failSend);
  const server = new AgentServer({ transport: t.transport, chatManager, composition });
  await (server as any).moduleReady;
  const session = await chatManager.getOrCreate("sess-host", {});
  const findRequest = () =>
    waitFor(() => t.sent.find(isHostActionRequest), "host action request should be emitted");
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
    expect(f.t.sent.some(isHostActionRequest)).toBe(false);
    await f.server.close();
  });

  test("rejects an invalid action or non-plain args before registering anything", async () => {
    const f = await fixture();
    const call = f.host.requestHostAction! as (
      s: string,
      a: unknown,
      b: unknown,
    ) => Promise<unknown>;
    for (const [action, args] of [
      ["", {}],
      [42, {}],
      ["notice.create", null],
      ["notice.create", [1]],
      ["notice.create", "x"],
      ["notice.create", new Date()],
    ] as const) {
      await expect(call("sess-host", action, args)).rejects.toThrow(/host action/);
    }
    expect(f.t.sent.some(isHostActionRequest)).toBe(false);
    expect(f.session.pendingApprovals.size).toBe(0);
    expect((f.server as any).approvalTimers.size).toBe(0);
    await f.server.close();
  });

  test("retires the pending wait at once when the request cannot be sent", async () => {
    const f = await fixture(isHostActionRequest);
    await expect(f.host.requestHostAction!("sess-host", "notice.create", {})).rejects.toThrow(
      "serialize",
    );
    expect(f.session.pendingApprovals.size).toBe(0);
    expect((f.server as any).approvalTimers.size).toBe(0);
    expect((f.server as any).pendingApprovalTargets.size).toBe(0);
    await f.server.close();
  });

  test("times out like a workspace action and clears the pending wait", async () => {
    const original = (AgentServer as any).APPROVAL_TIMEOUT_MS;
    (AgentServer as any).APPROVAL_TIMEOUT_MS = 20;
    try {
      const f = await fixture();
      const pending = f.host.requestHostAction!("sess-host", "notice.create", {});
      await f.findRequest();
      await expect(pending).rejects.toThrow(
        "host action notice.create timed out waiting for the host",
      );
      expect(f.session.pendingApprovals.size).toBe(0);
      expect((f.server as any).approvalTimers.size).toBe(0);
      await f.server.close();
    } finally {
      (AgentServer as any).APPROVAL_TIMEOUT_MS = original;
    }
  });
});

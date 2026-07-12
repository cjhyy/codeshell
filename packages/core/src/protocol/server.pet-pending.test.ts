import { describe, expect, spyOn, test } from "bun:test";
import type { Engine } from "../engine/engine.js";
import { ApprovalRouter } from "../tool-system/permission.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";
import { Methods } from "./types.js";

function makeTransport() {
  const sent: any[] = [];
  let receive: (message: unknown) => void = () => {};
  return {
    sent,
    deliver(message: unknown) {
      receive(message);
    },
    transport: {
      send(message: unknown) {
        sent.push(message);
      },
      onMessage(listener: (message: unknown) => void) {
        receive = listener;
      },
      close() {},
    } as any,
  };
}

function makeEngine(): Engine {
  return {
    setPlanMode() {},
    setAskUser() {},
    setBrowserBridge() {},
    setInjectCredential() {},
    isHeadless: () => false,
  } as unknown as Engine;
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AgentServer Pet pending projection", () => {
  test("stores resolver separately from safe tool metadata and resolves once", async () => {
    const engine = makeEngine();
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const session = await manager.getOrCreate("session-a", {} as never);
    const t = makeTransport();
    const server = new AgentServer({ transport: t.transport, chatManager: manager });

    const decision = (server as any).requestApprovalFromClient({
      sessionId: "session-a",
      toolName: "Write",
      args: { file_path: "/secret", content: "sk-private-token" },
      description: "write /secret with sk-private-token",
      riskLevel: "high",
    });
    await tick();

    const notification = t.sent.find((message) => message.method === Methods.ApprovalRequest);
    const requestId = notification.params.requestId as string;
    const entry = session.pendingApprovals.get(requestId)!;
    expect(typeof entry.resolve).toBe("function");
    expect(entry.metadata).toMatchObject({
      sessionId: "session-a",
      requestId,
      kind: "tool_approval",
      title: "等待批准 Write",
      toolName: "Write",
      riskLevel: "high",
      surfaceable: true,
    });
    expect(JSON.stringify(entry.metadata)).not.toContain("/secret");
    expect(JSON.stringify(entry.metadata)).not.toContain("private-token");
    expect(JSON.stringify(server.getPendingDecisionSnapshot())).not.toContain("resolve");

    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.Approve,
      params: {
        sessionId: "session-a",
        requestId,
        decision: { approved: true },
      },
    });
    await expect(decision).resolves.toEqual({ approved: true });
    expect(server.getPendingDecisionSnapshot()).toContainEqual(
      expect.objectContaining({ requestId, status: "resolved" }),
    );

    t.deliver({
      jsonrpc: "2.0",
      id: 3,
      method: Methods.Approve,
      params: {
        sessionId: "session-a",
        requestId,
        decision: { approved: false },
      },
    });
    await tick();
    expect(server.getPendingDecisionSnapshot()).toContainEqual(
      expect.objectContaining({ requestId, status: "resolved" }),
    );
    server.close();
  });

  test("classifies AskUser explicitly and excludes internal browser waits", async () => {
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => makeEngine(),
    });
    const session = await manager.getOrCreate("session-a", {} as never);
    const t = makeTransport();
    const server = new AgentServer({ transport: t.transport, chatManager: manager });

    void (server as any).requestAskUserForSession(
      session,
      "session-a",
      "选择实现方案\nsecret-token-123456",
      { options: [{ label: "raw option", description: "private" }] },
    );
    void (server as any).requestBrowserActionForSession(session, "session-a", "click", {
      ref: "secret-ref",
    });
    await tick();

    const pending = server.getPendingDecisionSnapshot();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "ask_user", agentSessionId: "session-a" });
    expect(JSON.stringify(pending)).not.toContain("raw option");
    expect(JSON.stringify(pending)).not.toContain("secret-token");

    t.deliver({
      jsonrpc: "2.0",
      id: 4,
      method: Methods.Cancel,
      params: { sessionId: "session-a" },
    });
    await tick();
    expect(server.getPendingDecisionSnapshot()[0]?.status).toBe("cancelled");
    server.close();
  });

  test("records timeout, explicit close, server close and owner disconnect terminal states", async () => {
    const scheduled: Array<() => void> = [];
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: (...args: any[]) => void,
      _timeout?: number,
      ...args: any[]
    ) => {
      scheduled.push(() => handler(...args));
      return 1 as any;
    }) as unknown as typeof setTimeout);
    try {
      const manager = new ChatSessionManager({
        runtime: {} as never,
        engineFactory: () => makeEngine(),
      });
      await manager.getOrCreate("timeout", {} as never);
      await manager.getOrCreate("closed", {} as never);
      await manager.getOrCreate("shutdown", {} as never);
      const t = makeTransport();
      const server = new AgentServer({ transport: t.transport, chatManager: manager });

      void (server as any).requestApprovalFromClient({
        sessionId: "timeout",
        toolName: "Bash",
        args: { command: "secret" },
        description: "secret",
        riskLevel: "medium",
      });
      const timeoutRequest = t.sent.at(-1).params.requestId as string;
      scheduled.shift()?.();
      expect(server.getPendingDecisionSnapshot()).toContainEqual(
        expect.objectContaining({ requestId: timeoutRequest, status: "expired" }),
      );

      void (server as any).requestAskUserForSession(manager.get("closed")!, "closed", "close me");
      const closeRequest = t.sent.at(-1).params.requestId as string;
      t.deliver({
        jsonrpc: "2.0",
        id: 10,
        method: Methods.CloseSession,
        params: { sessionId: "closed" },
      });
      await tick();
      expect(server.getPendingDecisionSnapshot()).toContainEqual(
        expect.objectContaining({ requestId: closeRequest, status: "cancelled" }),
      );

      void (server as any).requestAskUserForSession(
        manager.get("shutdown")!,
        "shutdown",
        "shutdown me",
      );
      const shutdownRequest = t.sent.at(-1).params.requestId as string;
      server.close();
      expect(server.getPendingDecisionSnapshot()).toContainEqual(
        expect.objectContaining({ requestId: shutdownRequest, status: "cancelled" }),
      );
    } finally {
      timeoutSpy.mockRestore();
    }

    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => makeEngine(),
    });
    await manager.getOrCreate("disconnect", {} as never);
    const router = new ApprovalRouter();
    const t = makeTransport();
    const server = new AgentServer({
      transport: t.transport,
      chatManager: manager,
      approvalRouter: router,
      connectionId: "owner-connection",
    });
    const registration = router.register("disconnect", "owner-connection");
    if (!registration.ok) throw new Error("unexpected approval registration conflict");
    void (server as any).requestApprovalFromClient(
      {
        sessionId: "disconnect",
        toolName: "Write",
        args: {},
        description: "write",
        riskLevel: "high",
      },
      registration.target,
    );
    const disconnectRequest = t.sent.at(-1).params.requestId as string;
    server.disconnect();
    expect(server.getPendingDecisionSnapshot()).toContainEqual(
      expect.objectContaining({ requestId: disconnectRequest, status: "owner-lost" }),
    );
    server.close();
  });
});

import { describe, expect, test } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { Methods } from "./types.js";
import type { Engine, EngineResult } from "../engine/engine.js";
import type { PanelHostBridge } from "../tool-system/panel-bridge.js";

function makeTransport() {
  const sent: any[] = [];
  let onMessage: (message: unknown) => void = () => {};
  return {
    sent,
    deliver: (message: unknown) => onMessage(message),
    transport: {
      send: (message: unknown) => sent.push(message),
      onMessage: (handler: (message: unknown) => void) => {
        onMessage = handler;
      },
      close: () => {},
    } as any,
  };
}

async function waitFor<T>(read: () => T | undefined, message: string): Promise<T> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

describe("AgentServer panel bridge", () => {
  test("routes list/open through hidden panel actions", async () => {
    let panelBridge: PanelHostBridge | undefined;
    const engine = {
      setAskUser() {},
      setPlanMode() {},
      setBrowserBridge() {},
      setInjectCredential() {},
      setSessionMessageRouter() {},
      setPanelBridge(bridge: PanelHostBridge | undefined) {
        panelBridge = bridge;
      },
      isHeadless: () => false,
      async run(_task: string, options: { sessionId: string }): Promise<EngineResult> {
        const panels = await panelBridge!.list();
        const opened = await panelBridge!.open(panels[0]!.id);
        return {
          text: `${panels[0]!.title}:${opened.panelId}`,
          reason: "completed",
          sessionId: options.sessionId,
          turnCount: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    } as unknown as Engine;
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager, panelBridge: true });

    transport.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.Run,
      params: { sessionId: "panel-session", task: "show quick chat" },
    });
    const listRequest = await waitFor(
      () =>
        transport.sent.find(
          (message) =>
            message.method === Methods.ApprovalRequest &&
            message.params?.request?.toolName === "__panel_action__" &&
            message.params?.request?.args?.action === "list",
        ),
      "panel list action should be emitted",
    );
    transport.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.Approve,
      params: {
        sessionId: "panel-session",
        requestId: listRequest.params.requestId,
        decision: {
          approved: true,
          answer: JSON.stringify({
            ok: true,
            panels: [{ id: "quickChat", title: "Quick chat", source: "code" }],
          }),
        },
      },
    });

    const openRequest = await waitFor(
      () =>
        transport.sent.find(
          (message) =>
            message.method === Methods.ApprovalRequest &&
            message.params?.request?.toolName === "__panel_action__" &&
            message.params?.request?.args?.action === "open",
        ),
      "panel open action should be emitted",
    );
    expect(openRequest.params.request.args.panelId).toBe("quickChat");
    transport.deliver({
      jsonrpc: "2.0",
      id: 3,
      method: Methods.Approve,
      params: {
        sessionId: "panel-session",
        requestId: openRequest.params.requestId,
        decision: {
          approved: true,
          answer: JSON.stringify({ ok: true, panelId: "quickChat" }),
        },
      },
    });

    const response = await waitFor(
      () => transport.sent.find((message) => message.id === 1 && message.result),
      "run should finish after panel open",
    );
    expect(response.result.text).toBe("Quick chat:quickChat");
  });
});

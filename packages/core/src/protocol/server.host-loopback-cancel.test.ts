/**
 * Host-loopback tools (Panel / Browser / SwitchSessionWorkspace /
 * InjectCredential) reach the Desktop renderer by riding the SAME
 * `session.pendingApprovals` map as real permission approvals, registered as
 * `kind: "internal"` entries (see internalPendingMetadata).
 *
 * cancelSessionApprovals() used to drain that map indiscriminately with
 * `{approved: false, reason}` — the exact shape a USER DENIAL takes. So pressing
 * Stop resolved an in-flight `__panel_action__` as "declined", and the model was
 * told the user had refused a Panel operation when they had only stopped the turn.
 *
 * These tests pin the distinction: an internal host request must settle with a
 * CANCELLED outcome carrying the real cause, and a genuine denial must still
 * report as denied.
 */
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

type SettleOutcome = {
  ok?: boolean;
  failure?: string;
  cancelled?: boolean;
  reason?: string;
  error?: string;
  detail?: string;
};

/**
 * Boot a server whose engine run parks on one `Panel.invoke` host request and
 * records how it settled. `invoke` is used because it forwards the host payload
 * through (list/tools normalize failures into an empty array), so the terminal
 * classification stays observable at the bridge surface the tools actually see.
 */
function bootPanelProbe(sessionId: string) {
  let panelBridge: PanelHostBridge | undefined;
  let outcome: SettleOutcome | undefined;
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
      outcome = (await panelBridge!.invoke!("designStudio", "audit", {})) as SettleOutcome;
      return {
        text: "done",
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
    params: { sessionId, task: "probe panel" },
  });

  return { transport, readOutcome: () => outcome };
}

function awaitPanelRequest(probe: ReturnType<typeof bootPanelProbe>) {
  return waitFor(
    () =>
      probe.transport.sent.find(
        (message) =>
          message.method === Methods.ApprovalRequest &&
          message.params?.request?.toolName === "__panel_action__",
      ),
    "panel action should be emitted",
  );
}

describe("host-loopback cancel semantics", () => {
  test("Stop settles an in-flight host request as cancelled, not as a user denial", async () => {
    const probe = bootPanelProbe("cancel-session");
    const request = await awaitPanelRequest(probe);
    expect(request.params.requestId).toBeTruthy();

    // User presses Stop while the host request is still in flight.
    probe.transport.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.Cancel,
      params: { sessionId: "cancel-session" },
    });

    const outcome = await waitFor(
      () => probe.readOutcome(),
      "host request should settle after cancel",
    );

    expect(outcome.ok).toBe(false);
    // The defect being fixed: this used to be indistinguishable from the user
    // clicking Deny on a permission prompt.
    expect(outcome.detail).toContain("turn was stopped");
    expect(outcome.detail ?? "").not.toContain("declined");
  });

  test("an explicit deny still reports as declined", async () => {
    const probe = bootPanelProbe("deny-session");
    const request = await awaitPanelRequest(probe);

    probe.transport.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.Approve,
      params: {
        sessionId: "deny-session",
        requestId: request.params.requestId,
        decision: { approved: false, reason: "user said no" },
      },
    });

    const outcome = await waitFor(
      () => probe.readOutcome(),
      "host request should settle after deny",
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("declined");
    expect(outcome.detail ?? "").not.toContain("stopped");
  });

  test("a successful host reply is still forwarded unchanged", async () => {
    const probe = bootPanelProbe("ok-session");
    const request = await awaitPanelRequest(probe);

    probe.transport.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.Approve,
      params: {
        sessionId: "ok-session",
        requestId: request.params.requestId,
        decision: {
          approved: true,
          answer: JSON.stringify({
            ok: true,
            panelId: "designStudio",
            toolName: "audit",
            result: { issues: 0 },
          }),
        },
      },
    });

    const outcome = (await waitFor(
      () => probe.readOutcome(),
      "host request should settle after reply",
    )) as SettleOutcome & { result?: unknown };

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({ issues: 0 });
  });
});

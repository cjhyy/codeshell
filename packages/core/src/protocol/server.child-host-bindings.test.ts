import { afterEach, describe, expect, test } from "bun:test";
import type { Engine } from "../engine/engine.js";
import type { ChildHostBindings, ChildHostBindingsFactory } from "../engine/types.js";
import type { ApprovalRequest } from "../types.js";
import { ApprovalRouter } from "../tool-system/permission.js";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { Methods } from "./types.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function setup() {
  const sent: any[] = [];
  let factory!: ChildHostBindingsFactory;
  let receive!: (message: any) => void;
  const engine = {
    isHeadless: () => false,
    setAskUser() {},
    setBrowserBridge() {},
    setInjectCredential() {},
    setSessionMessageRouter() {},
    dispose() {},
    setChildHostBindings(fn: ChildHostBindingsFactory) {
      factory = fn;
    },
  } as unknown as Engine;
  const manager = new ChatSessionManager({ runtime: {} as never, engineFactory: () => engine });
  const router = new ApprovalRouter();
  const server = new AgentServer({
    chatManager: manager,
    approvalRouter: router,
    connectionId: "host-a",
    transport: {
      send(message) {
        sent.push(message);
      },
      onMessage(fn) {
        receive = fn;
      },
      close() {},
    } as any,
  });
  cleanup.push(async () => {
    // disconnect only releases approval ownership; close also unsubscribes the
    // process-wide background mailbox and closes the resident parent session.
    server.close();
    await manager.closeAllAsync();
    expect(manager.sessionCount()).toBe(0);
  });
  const session = await manager.getOrCreate("child-host-parent", {});
  router.register("child-host-parent", "host-a");
  (server as any).wireInteractiveSession(session, "child-host-parent");
  function child(id: string, signal?: AbortSignal) {
    const binding = factory({ parentSessionId: "child-host-parent", sessionId: id, signal });
    binding.activate?.();
    cleanup.push(() => binding.dispose());
    return binding;
  }
  function approve(message: any, decision: any = { approved: true }, overrides = {}) {
    receive({
      jsonrpc: "2.0",
      id: `approve-${sent.length}`,
      method: Methods.Approve,
      params: {
        connectionId: message.params.connectionId,
        sessionId: message.params.sessionId,
        generation: message.params.generation,
        requestId: message.params.requestId,
        decision,
        ...overrides,
      },
    });
  }
  function requests(toolName: string) {
    return sent.filter(
      (m) =>
        m.method === Methods.ApprovalRequest &&
        m.params.request.toolName === toolName &&
        !m.params.childHost?.activate,
    );
  }
  return { child, factory, manager, router, session, server, sent, approve, requests };
}
function permission(child: ChildHostBindings, sessionId: string, toolName = "Bash") {
  return child.approvalBackend!.requestApproval({
    sessionId,
    toolName,
    args: { command: "rm protected.txt" },
    description: "child request",
    riskLevel: "high",
  } satisfies ApprovalRequest);
}

describe("child host bindings", () => {
  test("routes child approvals through the parent owner, keeps caches isolated, rejects stale replies", async () => {
    const p = await setup();
    const a = p.child("child-a");
    const b = p.child("child-b");
    const first = permission(a, "child-a");
    await tick();
    const req = p.requests("Bash")[0];
    expect(req.params).toMatchObject({ sessionId: "child-host-parent", connectionId: "host-a" });
    expect(req.params.request.sessionId).toBe("child-a");
    expect(p.session.pendingApprovals.get(req.params.requestId)?.metadata.sourceSessionId).toBe(
      "child-a",
    );
    expect(p.manager.get("child-a")).toBeUndefined();
    p.approve(req, { approved: true }, { generation: req.params.generation + 1 });
    await tick();
    expect(p.session.pendingApprovals.size).toBe(1);
    p.approve(req, { approved: true, always: true, scope: "session" });
    expect((await first).approved).toBe(true);
    expect((await permission(a, "child-a")).approved).toBe(true);
    expect(p.requests("Bash")).toHaveLength(1);
    const sibling = permission(b, "child-b");
    await tick();
    expect(p.requests("Bash")).toHaveLength(2);
    p.approve(p.requests("Bash")[1], { approved: false });
    expect((await sibling).approved).toBe(false);
    p.router.release("child-host-parent", "host-a");
    p.router.register("child-host-parent", "host-a");
    expect(await permission(a, "child-a")).toMatchObject({
      approved: false,
      failure: "owner_lost",
    });
    expect(p.requests("Bash")).toHaveLength(2);
  });

  test("provides a child browser target and cancels only that child's pending host requests", async () => {
    const p = await setup();
    const controller = new AbortController();
    const a = p.child("child-a", controller.signal);
    const b = p.child("child-b");
    const page = a.browserBridge!.navigate("https://example.com");
    const siblingQuestion = b.askUser!("continue?");
    const action = p.requests("__browser_action__")[0];
    expect(action.params.childHost).toMatchObject({ sourceSessionId: "child-a" });
    expect(action.params.childHost.bindingId).toBeTruthy();
    expect(action.params.request.args).toEqual({ action: "navigate", url: "https://example.com" });
    expect(p.session.pendingApprovals.size).toBe(2);
    controller.abort();
    expect(await page).toMatchObject({ ok: false, failure: "cancelled" });
    expect(p.session.pendingApprovals.size).toBe(1);
    const release = p.requests("__browser_action__")[1];
    expect(release.params.childHost).toEqual({ ...action.params.childHost, release: true });
    p.approve(p.requests("__ask_user__")[0], { approved: true, answer: "yes" });
    expect(await siblingQuestion).toBe("yes");
    expect(await a.browserBridge!.navigate("https://example.com/late")).toMatchObject({
      ok: false,
      failure: "cancelled",
    });
    const resumed = p.child("child-a");
    const resumedPage = resumed.browserBridge!.navigate("https://example.com/resumed");
    const resumedAction = p.requests("__browser_action__")[2];
    expect(resumedAction.params.childHost.bindingId).not.toBe(action.params.childHost.bindingId);
    p.approve(resumedAction, { approved: true, answer: JSON.stringify({ ok: true }) });
    expect(await resumedPage).toMatchObject({ ok: true });
  });

  test("a legacy child owner cannot hijack restored approvals and activation precedes browser actions", async () => {
    const p = await setup();
    p.router.register("restored-child", "host-a");
    const child = p.child("restored-child");
    const activation = p.sent.find((m) => m.params?.childHost?.activate);
    expect(activation.params.childHost.sourceSessionId).toBe("restored-child");
    const pending = permission(child, "restored-child");
    await tick();
    const req = p.requests("Bash")[0];
    expect(req.params.sessionId).toBe("child-host-parent");
    p.approve(req);
    expect((await pending).approved).toBe(true);
    expect(p.manager.get("restored-child")).toBeUndefined();
  });

  test("aborts queued approvals without another prompt and reports host loss truthfully", async () => {
    const p = await setup();
    const child = p.child("child-a");
    const first = permission(child, "child-a");
    const second = permission(child, "child-a", "mcp__browser__list_pages");
    await tick();
    p.router.release("child-host-parent", "host-a", "connection disconnected");
    expect(await first).toMatchObject({ approved: false, failure: "owner_lost" });
    expect(await second).toMatchObject({ approved: false, failure: "owner_lost" });
    expect(p.requests("mcp__browser__list_pages")).toHaveLength(0);
    expect(p.session.pendingApprovals.size).toBe(0);
  });

  test("cleans up expired child tool approvals and preserves the timeout reason", async () => {
    const p = await setup();
    const oldTimeout = (AgentServer as any).APPROVAL_TIMEOUT_MS;
    (AgentServer as any).APPROVAL_TIMEOUT_MS = 5;
    try {
      expect(await permission(p.child("child-a"), "child-a")).toMatchObject({
        approved: false,
        failure: "timed_out",
      });
      expect(p.session.pendingApprovals.size).toBe(0);
      expect((p.server as any).approvalTimers.size).toBe(0);
    } finally {
      (AgentServer as any).APPROVAL_TIMEOUT_MS = oldTimeout;
    }
  });
});

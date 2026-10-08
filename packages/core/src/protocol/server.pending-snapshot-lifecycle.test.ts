import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { ApprovalRouter } from "../tool-system/permission.js";
import { compileComposition } from "../composition/compiler.js";
import type { AgentModule } from "../composition/types.js";
import type { Engine } from "../engine/engine.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

async function fixture(modules: AgentModule[], onTransportClose?: () => void) {
  const root = mkdtempSync(join(tmpdir(), "pending-snapshot-"));
  const manager = new ChatSessionManager({
    runtime: {} as never,
    dataRoot: root,
    engineFactory: () =>
      ({
        setAskUser() {},
        setSessionMessageRouter() {},
        isHeadless: () => false,
        dispose() {},
      }) as unknown as Engine,
  });
  const session = await manager.getOrCreate("session", {});
  const router = new ApprovalRouter();
  const sent: any[] = [];
  let transportClosed = false;
  const server = new AgentServer({
    composition: compileComposition({ modules }),
    chatManager: manager,
    approvalRouter: router,
    connectionId: "owner",
    sessionDiskRoot: join(root, "sessions"),
    transport: {
      send(message) {
        if (transportClosed) throw new Error("Cannot notify a closed fixture transport");
        sent.push(message);
      },
      onMessage() {},
      close() {
        onTransportClose?.();
        transportClosed = true;
      },
    },
  });
  cleanup.push(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  await (server as any).moduleReady;
  return { server, session, router, sent };
}

function projection(events: string[], dispose?: () => Promise<void>) {
  const entries: Array<{ requestId: string; status: string; detail: { label: string } }> = [];
  let timerReleased = false;
  let isTransportDisconnected = () => false;
  const module: AgentModule = {
    id: "decision-fixture",
    protocol: {
      queries: { fixtureState: () => "active" },
      createObserver(host) {
        isTransportDisconnected = host.isTransportDisconnected;
        host.registerQuery("fixtureState", () => "active");
        return {
          onApprovalCreated(metadata) {
            events.push("created");
            entries.push({
              requestId: metadata.requestId,
              status: "pending",
              detail: { label: "original" },
            });
          },
          onApprovalTransition(metadata, status) {
            events.push(status);
            const entry = entries.find((entry) => entry.requestId === metadata.requestId);
            if (entry) entry.status = status;
            if (!host.isTransportDisconnected())
              host.notify("fixture/terminal", { requestId: metadata.requestId, status });
          },
          snapshotPendingDecisions() {
            events.push("snapshot");
            return entries;
          },
          onServerClose() {
            events.push("observer-close");
            entries.length = 0;
          },
        };
      },
    },
    activateHost(ctx) {
      const timer = setInterval(() => {}, 60_000);
      ctx.own(async () => {
        clearInterval(timer);
        timerReleased = true;
        events.push("module-dispose");
        await dispose?.();
      });
    },
  };
  return {
    module,
    timerReleased: () => timerReleased,
    transportDisconnected: () => isTransportDisconnected(),
  };
}

describe("AgentServer final pending-decision snapshots", () => {
  test("records owner loss before observer teardown and retains an isolated metadata snapshot", async () => {
    const events: string[] = [];
    const probe = projection(events);
    const { server, router, session, sent } = await fixture([probe.module]);
    const registration = router.register("session", "owner");
    if (!registration.ok) throw new Error("unexpected owner conflict");
    const decision = (server as any).requestApprovalFromClient(
      {
        sessionId: "session",
        toolName: "Write",
        args: {},
        description: "synthetic write",
        riskLevel: "high",
      },
      registration.target,
    );
    expect(session.pendingApprovals.size).toBe(1);
    expect((server as any).approvalTimers.size).toBe(1);
    server.disconnect("fixture owner disconnected");
    expect(events.slice(0, 4)).toEqual(["created", "owner-lost", "snapshot", "observer-close"]);
    await expect(decision).resolves.toMatchObject({ approved: false, failure: "owner_lost" });
    await (server as any).moduleScope.dispose();
    expect(sent.filter((message) => message.method === "fixture/terminal")).toEqual([]);
    expect(session.pendingApprovals.size).toBe(0);
    expect((server as any).approvalTimers.size).toBe(0);
    expect((server as any).protocolObservers).toHaveLength(0);
    expect((server as any).protocolQueryHandlers.size).toBe(0);
    expect(probe.timerReleased()).toBe(true);
    const snapshot = server.getPendingDecisionSnapshot() as any[];
    expect(snapshot).toEqual([
      { requestId: expect.any(String), status: "owner-lost", detail: { label: "original" } },
    ]);
    snapshot[0].detail.label = "caller mutation";
    snapshot.push({ status: "forged" });
    expect(server.getPendingDecisionSnapshot()).toEqual([
      { requestId: expect.any(String), status: "owner-lost", detail: { label: "original" } },
    ]);
    server.disconnect("duplicate disconnect");
    expect(events.filter((event) => event === "observer-close")).toHaveLength(1);
    expect(events.filter((event) => event === "owner-lost")).toHaveLength(1);
    await server.close();
    expect(server.getPendingDecisionSnapshot()).toEqual([]);
  });

  test("close captures cancellation before callbacks and releases its cache after async module cleanup", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = projection(events, () => gate);
    const transportCloseStates: boolean[] = [];
    const { server, session, sent } = await fixture([probe.module], () => {
      transportCloseStates.push(probe.transportDisconnected());
    });
    cleanup.push(async () => release());
    const decision = (server as any).requestApprovalFromClient({
      sessionId: "session",
      toolName: "Read",
      args: {},
      description: "synthetic read",
      riskLevel: "low",
    });
    const closing = server.close();
    expect(transportCloseStates).toEqual([true]);
    expect(events.slice(0, 4)).toEqual(["created", "cancelled", "snapshot", "observer-close"]);
    expect(server.getPendingDecisionSnapshot()).toEqual([
      { requestId: expect.any(String), status: "cancelled", detail: { label: "original" } },
    ]);
    expect(sent).toContainEqual(
      expect.objectContaining({
        method: "fixture/terminal",
        params: { requestId: expect.any(String), status: "cancelled" },
      }),
    );
    await expect(decision).resolves.toMatchObject({ approved: false, failure: "session_closed" });
    expect(session.pendingApprovals.size).toBe(0);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(probe.timerReleased()).toBe(true);
    expect(server.getPendingDecisionSnapshot()).toEqual([]);
    expect(events.filter((event) => event === "observer-close")).toHaveLength(1);
  });

  test("an uncloneable observer cannot retain a resolver or suppress a peer's snapshot", async () => {
    const { server } = await fixture([
      {
        id: "bad-snapshot",
        protocol: {
          createObserver: () => ({
            snapshotPendingDecisions: () => [{ resolve() {} }],
          }),
        },
      },
      {
        id: "safe-snapshot",
        protocol: {
          createObserver: () => ({
            snapshotPendingDecisions: () => [{ status: "resolved", detail: { label: "safe" } }],
          }),
        },
      },
    ]);
    const live = server.getPendingDecisionSnapshot() as any[];
    live[0].detail.label = "caller mutation";
    server.disconnect();
    expect(server.getPendingDecisionSnapshot()).toEqual([
      { status: "resolved", detail: { label: "safe" } },
    ]);
    await server.close();
    expect(server.getPendingDecisionSnapshot()).toEqual([]);
  });
});

/**
 * B2.2 — background-agent completion delivered as a protocol StreamEvent.
 *
 * Verifies the bus + server-forward + client-typed-handler pipeline that
 * makes `background_agent_completed` visible to Desktop / SDK / remote
 * AgentClients without going through TUI's polled queue.
 *
 * Layered coverage (cheap → expensive):
 *   a-e: the bus by itself (no protocol layer)
 *   f:   the bus → server → client envelope round-trip via in-process
 *        transport
 *   g:   status="failed" propagation through every layer
 *
 * We don't spin up real engines here — the agent-system invariants are
 * locked in `tests/agent-notifications.test.ts`. This file is strictly
 * about the new protocol surface.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  notificationQueue,
  agentNotificationBus,
  notificationItemToStreamEvent,
  type NotificationItem,
} from "../packages/core/src/tool-system/builtin/agent-notifications.ts";
import type {
  BackgroundAgentCompletedEvent,
  StreamEvent,
} from "../packages/core/src/types.ts";
import { AgentServer } from "../packages/core/src/protocol/server.ts";
import { AgentClient } from "../packages/core/src/protocol/client.ts";
import { createInProcessTransport } from "../packages/core/src/protocol/transport.ts";

const fixture = (overrides: Partial<NotificationItem> = {}): NotificationItem => ({
  agentId: "abc12345",
  name: "Explore",
  description: "调研 AI 公司新闻",
  status: "completed",
  finalText: "Found 3 stories.",
  enqueuedAt: 1_700_000_000_000,
  ...overrides,
});

beforeEach(() => {
  notificationQueue.reset();
});

describe("agentNotificationBus (B2.2)", () => {
  it("publishes when the queue enqueues (a)", () => {
    const received: Array<{ sid: string; ev: BackgroundAgentCompletedEvent }> = [];
    const unsub = agentNotificationBus.subscribe((sid, ev) => {
      received.push({ sid, ev });
    });

    notificationQueue.enqueue(fixture({ agentId: "a1" }), "sess-1");

    expect(received).toHaveLength(1);
    expect(received[0]!.sid).toBe("sess-1");
    expect(received[0]!.ev.type).toBe("background_agent_completed");
    expect(received[0]!.ev.agentId).toBe("a1");
    expect(received[0]!.ev.status).toBe("completed");
    expect(received[0]!.ev.finalText).toBe("Found 3 stories.");
    expect(received[0]!.ev.name).toBe("Explore");
    expect(received[0]!.ev.description).toBe("调研 AI 公司新闻");
    expect(received[0]!.ev.enqueuedAt).toBe(1_700_000_000_000);

    unsub();
  });

  it("fans out to multiple subscribers (b)", () => {
    let countA = 0;
    let countB = 0;
    const unsubA = agentNotificationBus.subscribe(() => {
      countA += 1;
    });
    const unsubB = agentNotificationBus.subscribe(() => {
      countB += 1;
    });

    notificationQueue.enqueue(fixture(), "sess-1");

    expect(countA).toBe(1);
    expect(countB).toBe(1);

    unsubA();
    unsubB();
  });

  it("unsubscribes cleanly (c)", () => {
    let count = 0;
    const unsub = agentNotificationBus.subscribe(() => {
      count += 1;
    });

    unsub();
    notificationQueue.enqueue(fixture(), "sess-1");

    expect(count).toBe(0);
  });

  it("rejects empty / undefined sessionId at runtime (d)", () => {
    // The static type now requires `sessionId: string`. A caller that
    // bypasses the type system via `as any` (or a stale JS-only
    // consumer) must NOT be able to silently push events through with
    // undefined / "" — the queue guards at the top of enqueue, so the
    // bus never fires. This locks in the runtime side of the contract
    // the type signature already advertises.
    let calls = 0;
    const unsub = agentNotificationBus.subscribe(() => {
      calls += 1;
    });

    notificationQueue.enqueue(fixture(), "" as string);
    expect(calls).toBe(0);

    notificationQueue.enqueue(fixture(), undefined as unknown as string);
    expect(calls).toBe(0);

    // Sanity: a real sessionId still publishes.
    notificationQueue.enqueue(fixture(), "sess-real");
    expect(calls).toBe(1);

    unsub();
  });

  it("isolates events per session when listeners filter (e)", () => {
    const seenByA: string[] = [];
    const seenByB: string[] = [];
    const unsubA = agentNotificationBus.subscribe((sid, ev) => {
      if (sid === "sess-A") seenByA.push(ev.agentId);
    });
    const unsubB = agentNotificationBus.subscribe((sid, ev) => {
      if (sid === "sess-B") seenByB.push(ev.agentId);
    });

    notificationQueue.enqueue(fixture({ agentId: "alpha" }), "sess-A");
    notificationQueue.enqueue(fixture({ agentId: "beta" }), "sess-B");

    expect(seenByA).toEqual(["alpha"]);
    expect(seenByB).toEqual(["beta"]);

    unsubA();
    unsubB();
  });

  it("notificationItemToStreamEvent preserves all populated fields", () => {
    const completed = notificationItemToStreamEvent(
      fixture({
        agentId: "ok-id",
        name: "Explore",
        description: "did stuff",
        status: "completed",
        finalText: "all good",
        enqueuedAt: 42,
      }),
    );
    expect(completed).toEqual({
      type: "background_agent_completed",
      agentId: "ok-id",
      name: "Explore",
      description: "did stuff",
      status: "completed",
      finalText: "all good",
      enqueuedAt: 42,
    });

    const failed = notificationItemToStreamEvent(
      fixture({
        agentId: "bad-id",
        name: undefined,
        description: "blew up",
        status: "failed",
        finalText: undefined,
        error: "boom",
        enqueuedAt: 43,
      }),
    );
    expect(failed).toEqual({
      type: "background_agent_completed",
      agentId: "bad-id",
      description: "blew up",
      status: "failed",
      error: "boom",
      enqueuedAt: 43,
    });
    // Optional fields that were undefined must not appear on the event.
    expect("name" in failed).toBe(false);
    expect("finalText" in failed).toBe(false);
  });
});

describe("AgentClient.onBackgroundAgentCompleted via in-process transport (B2.2)", () => {
  it("forwards a completed event from bus → server → client (f)", async () => {
    const [serverT, clientT] = createInProcessTransport();
    // Stub engine — we never call run(); we only need the constructor
    // to accept a non-null engine so the server constructs cleanly. The
    // legacy single-engine path is fine here because the bus-forwarding
    // wire is set up in the constructor regardless of mode.
    const stubEngine = {
      setPlanMode: () => {},
      setPermissionMode: () => {},
      setAskUser: () => {},
    } as unknown as import("../packages/core/src/engine/engine.ts").Engine;
    const server = new AgentServer({ transport: serverT, engine: stubEngine });
    const client = new AgentClient({ transport: clientT });

    const received: Array<{ sid: string; ev: BackgroundAgentCompletedEvent }> = [];
    client.onBackgroundAgentCompleted((sid, ev) => {
      received.push({ sid, ev });
    });

    notificationQueue.enqueue(
      fixture({ agentId: "round-trip", finalText: "hi" }),
      "sess-X",
    );

    // The in-process transport is synchronous — one microtask flush is
    // enough to drain the queue. Be defensive with a single awaited
    // setImmediate to allow any EventEmitter scheduling.
    await new Promise<void>((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    expect(received[0]!.sid).toBe("sess-X");
    expect(received[0]!.ev.agentId).toBe("round-trip");
    expect(received[0]!.ev.finalText).toBe("hi");
    expect(received[0]!.ev.status).toBe("completed");

    server.close();
    client.close();
  });

  it("offBackgroundAgentCompleted stops further deliveries", async () => {
    const [serverT, clientT] = createInProcessTransport();
    const stubEngine = {
      setPlanMode: () => {},
      setPermissionMode: () => {},
      setAskUser: () => {},
    } as unknown as import("../packages/core/src/engine/engine.ts").Engine;
    const server = new AgentServer({ transport: serverT, engine: stubEngine });
    const client = new AgentClient({ transport: clientT });

    let count = 0;
    const handler = () => {
      count += 1;
    };
    client.onBackgroundAgentCompleted(handler);
    notificationQueue.enqueue(fixture({ agentId: "first" }), "sess-X");
    await new Promise<void>((r) => setImmediate(r));
    expect(count).toBe(1);

    client.offBackgroundAgentCompleted(handler);
    notificationQueue.enqueue(fixture({ agentId: "second" }), "sess-X");
    await new Promise<void>((r) => setImmediate(r));
    expect(count).toBe(1); // unchanged

    server.close();
    client.close();
  });

  it("propagates a failed event with error message (g)", async () => {
    const [serverT, clientT] = createInProcessTransport();
    const stubEngine = {
      setPlanMode: () => {},
      setPermissionMode: () => {},
      setAskUser: () => {},
    } as unknown as import("../packages/core/src/engine/engine.ts").Engine;
    const server = new AgentServer({ transport: serverT, engine: stubEngine });
    const client = new AgentClient({ transport: clientT });

    const received: BackgroundAgentCompletedEvent[] = [];
    client.onBackgroundAgentCompleted((_sid, ev) => {
      received.push(ev);
    });
    // Also wire the catch-all onStreamEvent — the typed listener should
    // be additive, not a replacement.
    const catchAll: StreamEvent[] = [];
    client.onStreamEvent((env) => {
      catchAll.push(env.event);
    });

    notificationQueue.enqueue(
      fixture({
        agentId: "doomed",
        status: "failed",
        finalText: undefined,
        error: "boom",
      }),
      "sess-fail",
    );

    await new Promise<void>((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    expect(received[0]!.status).toBe("failed");
    expect(received[0]!.error).toBe("boom");
    expect(received[0]!.finalText).toBeUndefined();

    expect(catchAll).toHaveLength(1);
    expect(catchAll[0]!.type).toBe("background_agent_completed");

    server.close();
    client.close();
  });

  it("un-sessioned enqueue is dropped end-to-end (no protocol event reaches the client)", async () => {
    // The B2 `__legacy__` bucket and the server-side `sessionId ?? ""`
    // coercion are gone. An enqueue without a real sessionId should be
    // dropped by the queue's runtime guard — the bus never fires and the
    // client never sees a background_agent_completed event with an empty
    // sessionId. This is the inverse of the old "legacy-bucket → ''"
    // contract.
    const [serverT, clientT] = createInProcessTransport();
    const stubEngine = {
      setPlanMode: () => {},
      setPermissionMode: () => {},
      setAskUser: () => {},
    } as unknown as import("../packages/core/src/engine/engine.ts").Engine;
    const server = new AgentServer({ transport: serverT, engine: stubEngine });
    const client = new AgentClient({ transport: clientT });

    let calls = 0;
    client.onBackgroundAgentCompleted(() => {
      calls += 1;
    });

    notificationQueue.enqueue(
      fixture({ agentId: "no-session" }),
      undefined as unknown as string,
    );
    await new Promise<void>((r) => setImmediate(r));

    expect(calls).toBe(0);

    server.close();
    client.close();
  });

  it("server.close() unsubscribes from the bus", async () => {
    const [serverT, clientT] = createInProcessTransport();
    const stubEngine = {
      setPlanMode: () => {},
      setPermissionMode: () => {},
      setAskUser: () => {},
    } as unknown as import("../packages/core/src/engine/engine.ts").Engine;
    const server = new AgentServer({ transport: serverT, engine: stubEngine });
    const client = new AgentClient({ transport: clientT });

    let count = 0;
    client.onBackgroundAgentCompleted(() => {
      count += 1;
    });

    notificationQueue.enqueue(fixture({ agentId: "before-close" }), "sess-Y");
    await new Promise<void>((r) => setImmediate(r));
    expect(count).toBe(1);

    server.close();
    // After close, the server should have unsubscribed from the bus —
    // further enqueues won't push notifications down the transport
    // (the transport is closed too, but the bus listener teardown is
    // the load-bearing assertion).
    notificationQueue.enqueue(fixture({ agentId: "after-close" }), "sess-Y");
    await new Promise<void>((r) => setImmediate(r));
    expect(count).toBe(1);

    client.close();
  });
});

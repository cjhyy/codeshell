import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOUND_ROUTE_IDLE_EXPIRY_MS } from "@cjhyy/code-shell-pet";
import {
  createSessionBridgeWiring,
  type SessionBridgeWiringDeps,
  type BoundSessionTurnResult,
} from "./session-bridge-wiring.js";
import type { BoundSessionRunner } from "./session-conversation-bridge.js";
import type { PetReusableSessionCandidate } from "./pet-dispatch-service.js";

const NOW = 1_700_000_000_000;
const SELECTOR = "session-0123456789abcdef0123";

let dir: string;
let clock = NOW;

interface Published {
  deliveryKey: string;
  type: string;
  text: string;
  target: { channel: string; target: string };
}

function wiring(overrides: Partial<SessionBridgeWiringDeps> = {}) {
  const published: Published[] = [];
  const calls: string[] = [];
  const runner: BoundSessionRunner = {
    isRunning: async () => false,
    run: async () => {
      calls.push("run");
      return { started: true };
    },
    steer: async () => ({ accepted: false }),
    unsteer: async () => ({ removed: true }),
    wasInjected: () => false,
    runDone: async () => undefined,
    queueNextTurn: async () => {
      calls.push("queue");
    },
    supportsSteer: () => true,
  };
  let onTurn!: (turn: BoundSessionTurnResult) => Promise<void>;
  const built = createSessionBridgeWiring({
    routesFilePath: join(dir, "pet", "conversation-session-routes.json"),
    resolveSelector: async () =>
      ({
        sessionId: "s-login",
        workspacePath: "/repo",
        title: "修复登录问题",
        updatedAt: NOW,
      }) as PetReusableSessionCandidate,
    createRunner: (handler) => {
      onTurn = handler;
      return runner;
    },
    health: { check: async () => ({ ok: true }) },
    // The workspace check is real; these fixtures use a path that does not
    // exist on disk, so the seam stands in for a live worktree.
    directoryExists: async () => true,
    describeStatus: async (route) => `状态：${route.sessionTitle}`,
    publish: async (event) => {
      published.push(event);
    },
    now: () => clock,
    ...overrides,
  });
  return { ...built, published, calls, emitTurn: (turn: BoundSessionTurnResult) => onTurn(turn) };
}

const IM_CONTEXT = {
  completionTarget: { channel: "wechat", target: "owner-1" },
  senderId: "owner-1",
  isDirectMessage: true,
};

const INBOUND = {
  channel: "wechat",
  target: "owner-1",
  senderId: "owner-1",
  messageId: "m-1",
  text: "继续修那个 bug",
  isDirectMessage: true,
};

beforeEach(async () => {
  clock = NOW;
  dir = await mkdtemp(join(tmpdir(), "wiring-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the bind executor", () => {
  test("binds, then routes the next message into the Session", async () => {
    const w = wiring();
    const bound = await w.sessionBindExecutor(
      { action: "enter", sessionSelector: SELECTOR },
      IM_CONTEXT,
    );
    expect(bound.ok).toBe(true);
    expect(await w.routeInbound(INBOUND)).toMatchObject({ kind: "accepted" });
    expect(w.calls).toEqual(["run"]);
  });

  test("a turn with no authenticated route cannot bind", async () => {
    // The model supplies only a selector; identity must come from the host.
    const w = wiring();
    await expect(
      w.sessionBindExecutor({ action: "enter", sessionSelector: SELECTOR }, {}),
    ).rejects.toThrow();
    expect(await w.routeInbound(INBOUND)).toEqual({ kind: "not-bound" });
  });

  test("a conversation without private-chat metadata cannot bind", async () => {
    // Without an adapter signal a room cannot be proven private, so it fails
    // closed rather than binding one member's chat to everyone's replies.
    const w = wiring();
    const result = await w.sessionBindExecutor(
      { action: "enter", sessionSelector: SELECTOR },
      { completionTarget: { channel: "wechat", target: "room-9" }, senderId: "owner-1" },
    );
    expect(result.ok).toBe(false);
  });

  test("adapter-confirmed private chats bind even when conversation and sender ids differ", async () => {
    const w = wiring();
    const context = {
      completionTarget: { channel: "slack", target: "D012345" },
      senderId: "U012345",
      isDirectMessage: true,
    };
    const result = await w.sessionBindExecutor(
      { action: "enter", sessionSelector: SELECTOR },
      context,
    );
    expect(result.ok).toBe(true);
    expect(
      await w.routeInbound({
        ...INBOUND,
        channel: "slack",
        target: "D012345",
        senderId: "U012345",
      }),
    ).toMatchObject({ kind: "accepted" });
  });

  test("group and unknown metadata cannot bind even when target equals sender", async () => {
    const w = wiring();
    for (const isDirectMessage of [false, undefined]) {
      const result = await w.sessionBindExecutor(
        { action: "enter", sessionSelector: SELECTOR },
        { ...IM_CONTEXT, isDirectMessage },
      );
      expect(result.ok).toBe(false);
    }
    expect(await w.routeInbound(INBOUND)).toEqual({ kind: "not-bound" });
  });

  test("leaving returns the conversation to Mimi", async () => {
    const w = wiring();
    await w.sessionBindExecutor({ action: "enter", sessionSelector: SELECTOR }, IM_CONTEXT);
    await w.sessionBindExecutor({ action: "leave" }, IM_CONTEXT);
    expect(await w.routeInbound(INBOUND)).toEqual({ kind: "not-bound" });
  });
});

describe("delivering a Session reply", () => {
  test("reaches a bound conversation", async () => {
    const w = wiring();
    await w.sessionBindExecutor({ action: "enter", sessionSelector: SELECTOR }, IM_CONTEXT);
    await w.deliverSessionReply({ sessionId: "s-login", turnId: "t-1", text: "已修复" });
    expect(w.published).toHaveLength(1);
    expect(w.published[0]).toMatchObject({
      type: "session.reply",
      text: "已修复",
      target: { channel: "wechat", target: "owner-1" },
    });
  });

  test("still reaches a conversation that has left, because notify survives", async () => {
    // The completion the user was waiting for must not be cancelled by /mimi.
    const w = wiring();
    await w.sessionBindExecutor({ action: "enter", sessionSelector: SELECTOR }, IM_CONTEXT);
    await w.sessionBindExecutor({ action: "leave" }, IM_CONTEXT);
    await w.deliverSessionReply({ sessionId: "s-login", turnId: "t-1", text: "已修复" });
    expect(w.published).toHaveLength(1);
  });

  test("one turn produces one stable delivery key across retries", async () => {
    const w = wiring();
    await w.sessionBindExecutor({ action: "enter", sessionSelector: SELECTOR }, IM_CONTEXT);
    await w.deliverSessionReply({ sessionId: "s-login", turnId: "t-1", text: "已修复" });
    await w.deliverSessionReply({ sessionId: "s-login", turnId: "t-1", text: "已修复" });
    expect(w.published[0]!.deliveryKey).toBe(w.published[1]!.deliveryKey);
    // A different turn is a different delivery.
    await w.deliverSessionReply({ sessionId: "s-login", turnId: "t-2", text: "还有一处" });
    expect(w.published[2]!.deliveryKey).not.toBe(w.published[0]!.deliveryKey);
  });

  test("an unrelated Session and an empty answer publish nothing", async () => {
    const w = wiring();
    await w.sessionBindExecutor({ action: "enter", sessionSelector: SELECTOR }, IM_CONTEXT);
    await w.deliverSessionReply({ sessionId: "s-other", turnId: "t-1", text: "hi" });
    await w.deliverSessionReply({ sessionId: "s-login", turnId: "t-2", text: "   " });
    expect(w.published).toEqual([]);
  });
});

describe("startup recovery", () => {
  test("a binding that aged out while the app was closed no longer captures", async () => {
    const w = wiring();
    await w.sessionBindExecutor({ action: "enter", sessionSelector: SELECTOR }, IM_CONTEXT);
    clock = NOW + BOUND_ROUTE_IDLE_EXPIRY_MS;
    await w.recoverOnStartup();
    expect(await w.routeInbound(INBOUND)).toEqual({ kind: "not-bound" });
    // It survives as notify, so a late completion still arrives.
    await w.deliverSessionReply({ sessionId: "s-login", turnId: "t-1", text: "已修复" });
    expect(w.published).toHaveLength(1);
  });
});

test("a failed outbox publication retries without repeating successful routes", async () => {
  const attempts: Array<{ target: string; deliveryKey: string }> = [];
  const delivered: string[] = [];
  const errors: unknown[] = [];
  let failed = false;
  const w = wiring({
    deliveryRetryMs: 1,
    onDeliveryError: (error) => {
      errors.push(error);
    },
    publish: async (event) => {
      attempts.push({ target: event.target.target, deliveryKey: event.deliveryKey });
      if (event.target.target === "owner-2" && !failed) {
        failed = true;
        throw new Error("temporary outbox write failure");
      }
      delivered.push(event.target.target);
    },
  });
  await w.sessionBindExecutor({ action: "enter", sessionSelector: SELECTOR }, IM_CONTEXT);
  await w.sessionBindExecutor(
    { action: "enter", sessionSelector: SELECTOR },
    {
      completionTarget: { channel: "wechat", target: "owner-2" },
      senderId: "owner-2",
      isDirectMessage: true,
    },
  );
  const turn = { sessionId: "s-login", turnId: "durable-run", text: "answer" };
  const first = w.emitTurn(turn);
  expect(w.emitTurn(turn)).toBe(first);
  await first;
  expect(errors).toHaveLength(1);
  expect(delivered).toEqual(["owner-1", "owner-2"]);
  expect(attempts.map((entry) => entry.target)).toEqual(["owner-1", "owner-2", "owner-2"]);
  expect(attempts[1]!.deliveryKey).toBe(attempts[2]!.deliveryKey);
});

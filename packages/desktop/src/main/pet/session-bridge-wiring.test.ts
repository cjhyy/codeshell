import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOUND_ROUTE_IDLE_EXPIRY_MS } from "@cjhyy/code-shell-pet";
import {
  createSessionBridgeWiring,
  type SessionBridgeWiringDeps,
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
  const built = createSessionBridgeWiring({
    routesFilePath: join(dir, "pet", "conversation-session-routes.json"),
    resolveSelector: async () =>
      ({
        sessionId: "s-login",
        workspacePath: "/repo",
        title: "修复登录问题",
        updatedAt: NOW,
      }) as PetReusableSessionCandidate,
    runner,
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
  return { ...built, published, calls };
}

const IM_CONTEXT = {
  completionTarget: { channel: "wechat", target: "owner-1" },
  senderId: "owner-1",
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

  test("a shared target that is not the sender is treated as a group", async () => {
    // Without an adapter signal a room cannot be proven private, so it fails
    // closed rather than binding one member's chat to everyone's replies.
    const w = wiring();
    const result = await w.sessionBindExecutor(
      { action: "enter", sessionSelector: SELECTOR },
      { completionTarget: { channel: "wechat", target: "room-9" }, senderId: "owner-1" },
    );
    expect(result.ok).toBe(false);
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

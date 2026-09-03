import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOUND_ROUTE_IDLE_EXPIRY_MS, BOUND_ROUTE_STALE_PROMPT_MS } from "@cjhyy/code-shell-pet";
import { ConversationSessionRouteStore } from "./conversation-session-route-store.js";
import {
  SessionConversationBridge,
  boundClientMessageId,
  type BoundSessionHealth,
  type BoundSessionRunner,
} from "./session-conversation-bridge.js";

const NOW = 1_700_000_000_000;
// Must match imConversationRouteKey exactly, NUL separators included.
const ROUTE_KEY = "im:wechat\u0000owner-1\u0000owner-1";
const INBOUND = {
  channel: "wechat",
  target: "owner-1",
  senderId: "owner-1",
  messageId: "m-1",
  text: "继续修那个 bug",
  isDirectMessage: true,
};

let dir: string;
let clock = NOW;

interface Harness {
  bridge: SessionConversationBridge;
  routes: ConversationSessionRouteStore;
  calls: string[];
  runner: BoundSessionRunner;
}

function harness(
  runnerOverrides: Partial<BoundSessionRunner> = {},
  health: BoundSessionHealth = { check: async () => ({ ok: true }) },
): Harness {
  const calls: string[] = [];
  const runner: BoundSessionRunner = {
    isRunning: async () => false,
    run: async () => {
      calls.push("run");
      return { started: true };
    },
    steer: async () => {
      calls.push("steer");
      return { accepted: true };
    },
    unsteer: async () => ({ removed: true }),
    wasInjected: () => false,
    runDone: async () => undefined,
    queueNextTurn: async () => {
      calls.push("queue");
    },
    supportsSteer: () => true,
    ...runnerOverrides,
  };
  const routes = new ConversationSessionRouteStore(
    join(dir, "pet", "conversation-session-routes.json"),
    () => clock,
  );
  const bridge = new SessionConversationBridge({
    routes,
    runner,
    health,
    describeStatus: async (route) => `状态：${route.sessionTitle}`,
  });
  return { bridge, routes, calls, runner };
}

async function bind(routes: ConversationSessionRouteStore) {
  return routes.upsert({
    routeKey: ROUTE_KEY,
    channel: "wechat",
    target: "owner-1",
    senderId: "owner-1",
    sessionId: "s-login",
    sessionTitle: "修复登录问题",
    mode: "bound",
    origin: "enter",
  });
}

beforeEach(async () => {
  clock = NOW;
  dir = await mkdtemp(join(tmpdir(), "bridge-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("unbound conversations", () => {
  test("fall through to Mimi", async () => {
    const { bridge } = harness();
    expect(await bridge.accept(INBOUND)).toEqual({ kind: "not-bound" });
  });

  test("an unaddressable conversation is never bound", async () => {
    const { bridge } = harness();
    const result = await bridge.accept({ ...INBOUND, senderId: "   " });
    expect(result).toEqual({ kind: "not-bound" });
  });

  test("/mimi still answers definitively when nothing is bound", async () => {
    const { bridge } = harness();
    const result = await bridge.accept({ ...INBOUND, text: "/mimi" });
    expect(result.kind).toBe("left");
  });

  test("an internal failure falls back to Mimi rather than losing the message", async () => {
    const { bridge, routes } = harness();
    await bind(routes);
    // Force a failure inside routing.
    (routes as unknown as { boundRoute: () => Promise<never> }).boundRoute = async () => {
      throw new Error("disk gone");
    };
    expect(await bridge.accept(INBOUND)).toEqual({ kind: "not-bound" });
  });
});

describe("delivering into a Session", () => {
  test("an idle Session starts a turn", async () => {
    const { bridge, routes, calls } = harness();
    await bind(routes);
    expect((await bridge.accept(INBOUND)).kind).toBe("accepted");
    expect(calls).toEqual(["run"]);
  });

  test("a running Session takes a steer that is confirmed injected", async () => {
    const { bridge, routes, calls } = harness({
      isRunning: async () => true,
      wasInjected: () => true,
    });
    await bind(routes);
    expect((await bridge.accept(INBOUND)).kind).toBe("accepted");
    expect(calls).toEqual(["steer"]);
  });

  test("a steer that was not consumed becomes its own turn", async () => {
    // Losing the message would be worse than an extra turn; the stable
    // clientMessageId makes the retry safe.
    const { bridge, routes, calls } = harness({
      isRunning: async () => true,
      wasInjected: () => false,
      unsteer: async () => ({ removed: true }),
    });
    await bind(routes);
    await bridge.accept(INBOUND);
    expect(calls).toEqual(["steer", "run"]);
  });

  test("an external runtime queues instead of steering", async () => {
    // codex and claude-code have no steer, only a post-turn continuation.
    const { bridge, routes, calls } = harness({
      isRunning: async () => true,
      supportsSteer: () => false,
    });
    await bind(routes);
    await bridge.accept(INBOUND);
    expect(calls).toEqual(["queue"]);
  });

  test("a refused start is queued rather than dropped", async () => {
    const { bridge, routes, calls } = harness({
      run: async () => ({ started: false, reason: "busy" }),
    });
    await bind(routes);
    await bridge.accept(INBOUND);
    expect(calls).toEqual(["queue"]);
  });
});

describe("health checks before every delivery", () => {
  test("a deleted worktree suspends the route and does not deliver", async () => {
    const { bridge, routes, calls } = harness(
      {},
      { check: async () => ({ ok: false, reason: "worktree-missing" }) },
    );
    await bind(routes);
    const result = await bridge.accept(INBOUND);
    expect(result.kind).toBe("suspended");
    expect(calls).toEqual([]);
    // The message was not silently sent somewhere else.
    if (result.kind === "suspended") expect(result.text).toContain("没有发送出去");
    expect(await routes.boundRoute(ROUTE_KEY)).toBeUndefined();
  });

  test("an archived or missing Session suspends with its own reason", async () => {
    for (const reason of ["session-missing", "session-archived"] as const) {
      const { bridge, routes } = harness({}, { check: async () => ({ ok: false, reason }) });
      await bind(routes);
      const result = await bridge.accept(INBOUND);
      expect(result.kind).toBe("suspended");
    }
  });
});

describe("commands", () => {
  test("/mimi leaves and the route survives as notify", async () => {
    const { bridge, routes } = harness();
    await bind(routes);
    const result = await bridge.accept({ ...INBOUND, text: "/mimi" });
    expect(result.kind).toBe("left");
    // The completion the user is waiting for still has somewhere to go.
    expect(await routes.notifyRoutesForSession("s-login")).toHaveLength(1);
  });

  test("/session reports status without touching the runner", async () => {
    const { bridge, routes, calls } = harness();
    await bind(routes);
    const result = await bridge.accept({ ...INBOUND, text: "/session" });
    expect(result).toMatchObject({ kind: "status" });
    expect(calls).toEqual([]);
  });
});

describe("expiry and stale prompts", () => {
  test("a route that aged out stops capturing messages", async () => {
    const { bridge, routes, calls } = harness();
    await bind(routes);
    clock = NOW + BOUND_ROUTE_IDLE_EXPIRY_MS;
    expect((await bridge.accept(INBOUND)).kind).toBe("not-bound");
    expect(calls).toEqual([]);
  });

  test("a long-quiet binding warns once and still delivers", async () => {
    const { bridge, routes, calls } = harness();
    await bind(routes);
    clock = NOW + BOUND_ROUTE_STALE_PROMPT_MS;
    const first = await bridge.accept(INBOUND);
    expect(first).toMatchObject({ kind: "accepted" });
    if (first.kind === "accepted") expect(first.notice).toContain("/mimi");
    const second = await bridge.accept({ ...INBOUND, messageId: "m-2" });
    expect(second).toEqual({ kind: "accepted" });
    expect(calls).toEqual(["run", "run"]);
  });
});

describe("message identity", () => {
  test("is stable for the same platform message and distinct across routes", () => {
    const a = boundClientMessageId("route-1", INBOUND);
    expect(boundClientMessageId("route-1", INBOUND)).toBe(a);
    expect(boundClientMessageId("route-2", INBOUND)).not.toBe(a);
    expect(a).toContain("im-session:route-1:m-1");
  });

  test("falls back to the text when an adapter supplies no message id", () => {
    const id = boundClientMessageId("route-1", { ...INBOUND, messageId: undefined });
    expect(id).toContain("text:");
  });
});

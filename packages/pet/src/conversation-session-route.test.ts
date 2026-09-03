import { describe, expect, test } from "bun:test";
import {
  BOUND_ROUTE_IDLE_EXPIRY_MS,
  BOUND_ROUTE_STALE_PROMPT_MS,
  activeBoundRoute,
  createConversationSessionRoute,
  enterConversationSessionRoute,
  isConversationSessionRouteExpired,
  leaveConversationSessionRoute,
  markConversationSessionRouteStalePrompted,
  parseConversationSessionRoute,
  recordConversationSessionRouteInbound,
  shouldPromptConversationSessionRouteStale,
  suspendConversationSessionRoute,
  type ConversationSessionRoute,
} from "./conversation-session-route.js";

const NOW = 1_700_000_000_000;

function route(
  overrides: Partial<Parameters<typeof createConversationSessionRoute>[0]> = {},
): ConversationSessionRoute {
  const created = createConversationSessionRoute({
    id: "route-1",
    routeKey: "im:wechat\u0000room-7\u0000owner-3",
    channel: "wechat",
    target: "room-7",
    senderId: "owner-3",
    sessionId: "s-login-fix",
    sessionTitle: "修复登录问题",
    mode: "notify",
    origin: "delegate",
    now: NOW,
    ...overrides,
  });
  if (!created) throw new Error("expected a valid route fixture");
  return created;
}

describe("createConversationSessionRoute", () => {
  test("a notify route carries no expiry, a bound route does", () => {
    expect(route().expiresAt).toBeUndefined();
    expect(route({ mode: "bound", origin: "enter" }).expiresAt).toBe(
      NOW + BOUND_ROUTE_IDLE_EXPIRY_MS,
    );
  });

  test("falls back to the session id when the title is blank", () => {
    expect(route({ sessionTitle: "   " }).sessionTitle).toBe("s-login-fix");
  });

  test("rejects an unaddressable route rather than guessing a conversation", () => {
    // petChatRouteKey fails closed when target/sender are missing; a record
    // built from that must not become a deliverable route.
    expect(createConversationSessionRoute({ ...baseInput(), target: "" })).toBeUndefined();
    expect(createConversationSessionRoute({ ...baseInput(), senderId: "" })).toBeUndefined();
    expect(createConversationSessionRoute({ ...baseInput(), routeKey: "" })).toBeUndefined();
  });

  test("rejects control characters in a session title", () => {
    expect(
      createConversationSessionRoute({ ...baseInput(), sessionTitle: "bad\u0007title" }),
    ).toBeUndefined();
  });

  function baseInput() {
    return {
      id: "route-1",
      routeKey: "im:wechat\u0000room-7\u0000owner-3",
      channel: "wechat",
      target: "room-7",
      senderId: "owner-3",
      sessionId: "s-login-fix",
      sessionTitle: "修复登录问题",
      mode: "notify" as const,
      origin: "delegate" as const,
      now: NOW,
    };
  }
});

describe("mode transitions", () => {
  test("entering upgrades to bound and stamps a fresh expiry", () => {
    const entered = enterConversationSessionRoute(route(), NOW + 5);
    expect(entered.mode).toBe("bound");
    expect(entered.origin).toBe("enter");
    expect(entered.expiresAt).toBe(NOW + 5 + BOUND_ROUTE_IDLE_EXPIRY_MS);
    expect(entered.revision).toBe(2);
  });

  test("leaving downgrades to notify instead of deleting the route", () => {
    // The whole point of notify/bound: /mimi must not cancel the completion
    // the user is still waiting for.
    const left = leaveConversationSessionRoute(
      enterConversationSessionRoute(route(), NOW),
      NOW + 9,
      "user",
    );
    expect(left.mode).toBe("notify");
    expect(left.status).toBe("active");
    expect(left.expiresAt).toBeUndefined();
  });

  test("entering clears a previous suspension", () => {
    const suspended = suspendConversationSessionRoute(route(), NOW, "worktree-missing");
    const reentered = enterConversationSessionRoute(suspended, NOW + 1);
    expect(reentered.status).toBe("active");
    expect(reentered.suspendedReason).toBeUndefined();
  });

  test("suspending stops delivery and records why", () => {
    const suspended = suspendConversationSessionRoute(
      enterConversationSessionRoute(route(), NOW),
      NOW + 2,
      "session-archived",
    );
    expect(suspended.mode).toBe("notify");
    expect(suspended.status).toBe("suspended");
    expect(suspended.suspendedReason).toBe("session-archived");
  });
});

describe("expiry", () => {
  test("a bound route expires only once the window has fully elapsed", () => {
    const bound = route({ mode: "bound", origin: "enter" });
    expect(isConversationSessionRouteExpired(bound, NOW + BOUND_ROUTE_IDLE_EXPIRY_MS - 1)).toBe(
      false,
    );
    expect(isConversationSessionRouteExpired(bound, NOW + BOUND_ROUTE_IDLE_EXPIRY_MS)).toBe(true);
  });

  test("a notify route never expires", () => {
    expect(isConversationSessionRouteExpired(route(), NOW + 10 * BOUND_ROUTE_IDLE_EXPIRY_MS)).toBe(
      false,
    );
  });

  test("inbound traffic extends the window", () => {
    const bound = route({ mode: "bound", origin: "enter" });
    const later = NOW + BOUND_ROUTE_IDLE_EXPIRY_MS - 1_000;
    const refreshed = recordConversationSessionRouteInbound(bound, later);
    expect(refreshed.expiresAt).toBe(later + BOUND_ROUTE_IDLE_EXPIRY_MS);
    expect(isConversationSessionRouteExpired(refreshed, NOW + BOUND_ROUTE_IDLE_EXPIRY_MS)).toBe(
      false,
    );
  });

  test("an expired bound route never captures the next message", () => {
    // The app can be closed across the expiry, so staleness is judged at read
    // time rather than by a timer that did not run.
    const routes = [route({ mode: "bound", origin: "enter" })];
    const key = routes[0]!.routeKey;
    expect(activeBoundRoute(routes, key, NOW + 1)?.sessionId).toBe("s-login-fix");
    expect(activeBoundRoute(routes, key, NOW + BOUND_ROUTE_IDLE_EXPIRY_MS)).toBeUndefined();
  });

  test("a suspended or notify route is never treated as bound", () => {
    const suspended = suspendConversationSessionRoute(
      route({ mode: "bound", origin: "enter" }),
      NOW,
      "session-missing",
    );
    expect(activeBoundRoute([suspended], suspended.routeKey, NOW + 1)).toBeUndefined();
    expect(activeBoundRoute([route()], route().routeKey, NOW + 1)).toBeUndefined();
  });

  test("one conversation's route never leaks into another", () => {
    const routes = [route({ mode: "bound", origin: "enter" })];
    expect(
      activeBoundRoute(routes, "im:wechat\u0000room-7\u0000someone-else", NOW + 1),
    ).toBeUndefined();
  });
});

describe("stale prompt", () => {
  test("a quiet bound route warns once before delivering", () => {
    const bound = recordConversationSessionRouteInbound(
      route({ mode: "bound", origin: "enter" }),
      NOW,
    );
    expect(shouldPromptConversationSessionRouteStale(bound, NOW + 60_000)).toBe(false);
    const stale = NOW + BOUND_ROUTE_STALE_PROMPT_MS;
    expect(shouldPromptConversationSessionRouteStale(bound, stale)).toBe(true);
    const prompted = markConversationSessionRouteStalePrompted(bound, stale);
    expect(shouldPromptConversationSessionRouteStale(prompted, stale + 1_000)).toBe(false);
  });

  test("a new quiet period earns a new warning", () => {
    const first = NOW + BOUND_ROUTE_STALE_PROMPT_MS;
    const prompted = markConversationSessionRouteStalePrompted(
      recordConversationSessionRouteInbound(route({ mode: "bound", origin: "enter" }), NOW),
      first,
    );
    const resumed = recordConversationSessionRouteInbound(prompted, first);
    const second = first + BOUND_ROUTE_STALE_PROMPT_MS;
    expect(shouldPromptConversationSessionRouteStale(resumed, second)).toBe(true);
  });
});

describe("parseConversationSessionRoute", () => {
  test("round-trips a well-formed route", () => {
    const original = enterConversationSessionRoute(route(), NOW);
    expect(parseConversationSessionRoute(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });

  test("drops a row rather than repairing a partly-understood route", () => {
    const good = JSON.parse(JSON.stringify(route())) as Record<string, unknown>;
    expect(parseConversationSessionRoute({ ...good, schemaVersion: 2 })).toBeUndefined();
    expect(parseConversationSessionRoute({ ...good, mode: "chatting" })).toBeUndefined();
    expect(parseConversationSessionRoute({ ...good, sessionId: "" })).toBeUndefined();
    expect(parseConversationSessionRoute({ ...good, revision: -1 })).toBeUndefined();
    expect(parseConversationSessionRoute({ ...good, suspendedReason: "because" })).toBeUndefined();
    expect(parseConversationSessionRoute({ ...good, expiresAt: "soon" })).toBeUndefined();
    expect(parseConversationSessionRoute(undefined)).toBeUndefined();
    expect(parseConversationSessionRoute([])).toBeUndefined();
  });
});

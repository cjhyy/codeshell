/**
 * Host-loopback owner claim.
 *
 * A Panel App tool invocation must land in exactly ONE renderer window, so
 * `requestPanelHost` refuses to broadcast `invoke` and fails closed when the
 * session has no owning window (allowsPanelHostBroadcastFallback).
 *
 * The only writer of that ownership used to be a side effect of the renderer
 * submitting `agent/run` over the "agent:msg" IPC channel. Any session driven
 * from somewhere else — a main-owned session reserved via reserveHostSession, an
 * external Agent Runtime (Codex / Claude Code) whose turns are driven by the
 * runtime rather than the renderer — therefore never had an owner, and
 * `Panel.invoke` was permanently unreachable for it.
 *
 * These tests pin ownership as an explicit, independently-settable property of
 * the routing table rather than a side effect of one particular message.
 */
import { describe, expect, test } from "bun:test";
import {
  acceptsPanelHostResponse,
  allowsPanelHostBroadcastFallback,
  claimPanelHostOwnerForRun,
  PanelHostWindowRoutes,
} from "./panel-host-routing.js";

function fakeWindow(id: number, destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: { id },
  };
}

describe("explicit host-loopback owner claim", () => {
  test("a panel-originated run claims its live host window before dispatch", () => {
    const routes = new PanelHostWindowRoutes();
    const window = fakeWindow(40);

    claimPanelHostOwnerForRun(
      {
        claimSessionPanelOwner: (sessionId, webContentsId) =>
          routes.claim(sessionId, webContentsId),
      },
      "panel-session",
      window,
    );

    expect(routes.resolve("panel-session", [window])).toEqual({
      ownerWebContentsId: 40,
      window,
    });
  });

  test("a panel-originated run fails closed when its host window is gone", () => {
    const routes = new PanelHostWindowRoutes();
    const claimer = {
      claimSessionPanelOwner: (sessionId: string, webContentsId: number) =>
        routes.claim(sessionId, webContentsId),
    };

    expect(() => claimPanelHostOwnerForRun(claimer, "missing-owner", null)).toThrow(
      "owner window is unavailable",
    );
    expect(() => claimPanelHostOwnerForRun(claimer, "dead-owner", fakeWindow(39, true))).toThrow(
      "owner window is unavailable",
    );
  });

  test("a session claimed without any agent/run resolves to its owner", () => {
    const routes = new PanelHostWindowRoutes();
    const window = fakeWindow(41);

    // No agent/run has ever been submitted for this session — it is driven by an
    // external runtime. Ownership is established directly.
    routes.claim("external-session", window.webContents.id);

    expect(routes.resolve("external-session", [window])).toEqual({
      ownerWebContentsId: 41,
      window,
    });
  });

  test("an unclaimed session stays unowned so invoke fails closed", () => {
    const routes = new PanelHostWindowRoutes();
    const window = fakeWindow(42);

    const resolved = routes.resolve("never-claimed", [window]);
    expect(resolved).toEqual({ ownerWebContentsId: null, window: null });
    // A mutating invocation must NOT fall back to broadcasting into that window.
    expect(allowsPanelHostBroadcastFallback("invoke")).toBe(false);
  });

  test("re-claiming after the owning window dies re-establishes routing", () => {
    const routes = new PanelHostWindowRoutes();
    const dead = fakeWindow(43, true);
    const live = fakeWindow(44);

    routes.claim("resumed-session", dead.webContents.id);
    // resolve() drops a dead owner rather than retaining a stale id.
    expect(routes.resolve("resumed-session", [dead, live])).toEqual({
      ownerWebContentsId: null,
      window: null,
    });

    // Recovery is a fresh claim — nothing is inherited from the dead window.
    routes.claim("resumed-session", live.webContents.id);
    expect(routes.resolve("resumed-session", [dead, live])).toEqual({
      ownerWebContentsId: 44,
      window: live,
    });
  });

  test("hasLiveOwner answers without mutating routing state", () => {
    const routes = new PanelHostWindowRoutes();
    const dead = fakeWindow(51, true);
    const live = fakeWindow(52);

    expect(routes.hasLiveOwner("unclaimed", [live])).toBe(false);

    routes.claim("live-session", live.webContents.id);
    expect(routes.hasLiveOwner("live-session", [live])).toBe(true);

    // The owner window is gone. `resolve()` DELETES the mapping in this case, so a
    // predicate built on it would mutate state as a side effect of being asked.
    // hasLiveOwner must answer false and leave the mapping intact.
    routes.claim("dead-session", dead.webContents.id);
    expect(routes.hasLiveOwner("dead-session", [dead, live])).toBe(false);
    expect(routes.hasLiveOwner("dead-session", [dead, live])).toBe(false);

    // Proof the mapping survived: revive that webContentsId and it resolves again,
    // which could not happen had the first query dropped the owner.
    expect(routes.resolve("dead-session", [fakeWindow(51)]).ownerWebContentsId).toBe(51);
  });

  test("a claimed owner rejects responses from any other window", () => {
    const routes = new PanelHostWindowRoutes();
    routes.claim("guarded-session", 45);
    const { ownerWebContentsId } = routes.resolve("guarded-session", [fakeWindow(45)]);

    expect(acceptsPanelHostResponse(ownerWebContentsId, 45)).toBe(true);
    expect(acceptsPanelHostResponse(ownerWebContentsId, 46)).toBe(false);
  });

  test("ownership is per-session, so concurrent sessions do not cross windows", () => {
    const routes = new PanelHostWindowRoutes();
    const a = fakeWindow(47);
    const b = fakeWindow(48);

    routes.claim("session-a", a.webContents.id);
    routes.claim("session-b", b.webContents.id);

    expect(routes.resolve("session-a", [a, b]).window).toBe(a);
    expect(routes.resolve("session-b", [a, b]).window).toBe(b);

    // Forgetting one must not disturb the other.
    routes.forgetSession("session-a");
    expect(routes.resolve("session-a", [a, b]).window).toBeNull();
    expect(routes.resolve("session-b", [a, b]).window).toBe(b);
  });
});

import { describe, expect, test } from "bun:test";
import {
  acceptsPanelHostResponse,
  allowsPanelHostBroadcastFallback,
  PanelHostWindowRoutes,
} from "./panel-host-routing.js";

function fakeWindow(id: number, destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: { id },
  };
}

describe("PanelHostWindowRoutes", () => {
  test("routes a session only to the window that most recently claimed it", () => {
    const routes = new PanelHostWindowRoutes();
    const first = fakeWindow(11);
    const second = fakeWindow(12);

    routes.claim("session-a", first.webContents.id);
    expect(routes.resolve("session-a", [first, second])).toEqual({
      ownerWebContentsId: 11,
      window: first,
    });

    routes.claim("session-a", second.webContents.id);
    expect(routes.resolve("session-a", [first, second])).toEqual({
      ownerWebContentsId: 12,
      window: second,
    });
  });

  test("drops closed and explicitly forgotten owners", () => {
    const routes = new PanelHostWindowRoutes();
    routes.claim("session-a", 21);
    routes.claim("session-b", 21);
    routes.releaseWindow(21);
    expect(routes.resolve("session-a", [])).toEqual({
      ownerWebContentsId: null,
      window: null,
    });

    routes.claim("session-c", 22);
    routes.forgetSession("session-c");
    expect(routes.resolve("session-c", [fakeWindow(22)])).toEqual({
      ownerWebContentsId: null,
      window: null,
    });

    routes.claim("session-d", 23);
    expect(routes.resolve("session-d", [fakeWindow(23, true)])).toEqual({
      ownerWebContentsId: null,
      window: null,
    });
  });

  test("reports actual reclaims, transfers and all authority release paths", () => {
    const changes: Array<[string, number | null]> = [];
    const routes = new PanelHostWindowRoutes((id, owner) => changes.push([id, owner]));
    routes.claim("a", 11);
    routes.claim("a", 11);
    routes.claim("a", 12);
    routes.claim("a", 11);
    routes.releaseWindow(11);
    routes.claim("b", 12);
    routes.resolve("b", []);
    routes.claim("c", 12);
    routes.forgetSession("c");
    expect(changes).toEqual([
      ["a", 11],
      ["a", 12],
      ["a", 11],
      ["a", null],
      ["b", 12],
      ["b", null],
      ["c", 12],
      ["c", null],
    ]);
  });

  test("accepts only the bound window response unless routing uses a fallback", () => {
    expect(acceptsPanelHostResponse(31, 31)).toBe(true);
    expect(acceptsPanelHostResponse(31, 32)).toBe(false);
    expect(acceptsPanelHostResponse(null, 32)).toBe(true);
  });

  test("never broadcasts a potentially mutating invocation to multiple windows", () => {
    expect(allowsPanelHostBroadcastFallback("list")).toBe(true);
    expect(allowsPanelHostBroadcastFallback("open")).toBe(true);
    expect(allowsPanelHostBroadcastFallback("tools")).toBe(true);
    expect(allowsPanelHostBroadcastFallback("invoke")).toBe(false);
  });
});

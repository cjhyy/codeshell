import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionVisitReceipt } from "@cjhyy/code-shell-pet";
import { ConversationSessionRouteStore } from "./conversation-session-route-store.js";
import { createSessionBindHostAction } from "./session-bind-host-action.js";
import type { BindValidation } from "./conversation-session-bind-validator.js";

const NOW = 1_700_000_000_000;
const ROUTE_KEY = "im:wechat\u0000owner-1\u0000owner-1";
const SELECTOR = "session-0123456789abcdef0123";
const CONTEXT = {
  channel: "wechat",
  target: "owner-1",
  senderId: "owner-1",
  isDirectMessage: true,
};

const ACCEPTED: BindValidation = {
  ok: true,
  candidate: { sessionId: "s-login", title: "修复登录问题", workspacePath: "/repo" },
};

let dir: string;

function harness(validation: BindValidation = ACCEPTED) {
  const routes = new ConversationSessionRouteStore(
    join(dir, "pet", "conversation-session-routes.json"),
    () => NOW,
  );
  const visits: SessionVisitReceipt[] = [];
  const execute = createSessionBindHostAction({
    routes,
    validate: async () => validation,
    recordVisit: async (receipt) => {
      visits.push(receipt);
    },
    newVisitId: () => "visit-1",
    now: () => NOW,
  });
  return { routes, visits, execute };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bind-action-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("entering", () => {
  test("binds the conversation and returns an authoritative receipt", async () => {
    const { execute, routes } = harness();
    const result = await execute({ action: "enter", sessionSelector: SELECTOR }, CONTEXT);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("修复登录问题");
    expect(result.message).toContain("/mimi");
    expect((await routes.boundRoute(ROUTE_KEY))?.sessionId).toBe("s-login");
  });

  test("opens a visit receipt so Mimi can summarize the visit later", async () => {
    const { execute, visits } = harness();
    await execute({ action: "enter", sessionSelector: SELECTOR }, CONTEXT);
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ sessionId: "s-login", enteredAt: NOW, inboundCount: 0 });
  });

  test("a refusal reaches the user verbatim and binds nothing", async () => {
    const { execute, routes } = harness({
      ok: false,
      reason: "archived-session",
      message: "这个 Session 已归档，不能进入。",
    });
    const result = await execute({ action: "enter", sessionSelector: SELECTOR }, CONTEXT);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("这个 Session 已归档，不能进入。");
    expect(await routes.boundRoute(ROUTE_KEY)).toBeUndefined();
  });

  test("a group chat refusal comes from the validator, not from here", async () => {
    const { execute } = harness({
      ok: false,
      reason: "group-chat",
      message: "进入 Session 目前只支持私聊。",
    });
    const result = await execute(
      { action: "enter", sessionSelector: SELECTOR },
      { ...CONTEXT, isDirectMessage: false },
    );
    expect(result.ok).toBe(false);
  });

  test("a failed receipt write does not undo a completed bind", async () => {
    const routes = new ConversationSessionRouteStore(
      join(dir, "pet", "conversation-session-routes.json"),
      () => NOW,
    );
    const execute = createSessionBindHostAction({
      routes,
      validate: async () => ACCEPTED,
      recordVisit: async () => {
        throw new Error("disk full");
      },
      newVisitId: () => "visit-1",
      now: () => NOW,
    });
    const result = await execute({ action: "enter", sessionSelector: SELECTOR }, CONTEXT);
    expect(result.ok).toBe(true);
    expect((await routes.boundRoute(ROUTE_KEY))?.sessionId).toBe("s-login");
  });
});

describe("leaving", () => {
  test("downgrades the route and names the Session that was left", async () => {
    const { execute, routes } = harness();
    await execute({ action: "enter", sessionSelector: SELECTOR }, CONTEXT);
    const result = await execute({ action: "leave" }, CONTEXT);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("修复登录问题");
    expect(await routes.boundRoute(ROUTE_KEY)).toBeUndefined();
    // Still notified when the Session finishes.
    expect(await routes.notifyRoutesForSession("s-login")).toHaveLength(1);
  });

  test("leaving with nothing bound still answers definitively", async () => {
    const { execute } = harness();
    const result = await execute({ action: "leave" }, CONTEXT);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Mimi");
  });
});

describe("rejecting bad requests", () => {
  test("an unknown action or missing selector throws rather than binding", async () => {
    const { execute } = harness();
    await expect(execute({ action: "resume" }, CONTEXT)).rejects.toThrow();
    await expect(execute({ action: "enter" }, CONTEXT)).rejects.toThrow();
  });

  test("a turn with no conversation route is refused", async () => {
    const { execute } = harness();
    await expect(
      execute({ action: "enter", sessionSelector: SELECTOR }, undefined),
    ).rejects.toThrow();
  });

  test("an unaddressable conversation cannot bind", async () => {
    const { execute, routes } = harness();
    const result = await execute(
      { action: "enter", sessionSelector: SELECTOR },
      { ...CONTEXT, senderId: "  " },
    );
    expect(result.ok).toBe(false);
    expect(await routes.all()).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOUND_ROUTE_IDLE_EXPIRY_MS, BOUND_ROUTE_STALE_PROMPT_MS } from "@cjhyy/code-shell-pet";
import { ConversationSessionRouteStore } from "./conversation-session-route-store.js";

const NOW = 1_700_000_000_000;
const ROUTE_KEY = "im:wechat\u0000owner-1\u0000owner-1";
const OTHER_KEY = "im:wechat\u0000group-9\u0000someone-else";

let dir: string;
let filePath: string;
let clock = NOW;

function store(): ConversationSessionRouteStore {
  return new ConversationSessionRouteStore(filePath, () => clock);
}

function input(overrides: Partial<Parameters<ConversationSessionRouteStore["upsert"]>[0]> = {}) {
  return {
    routeKey: ROUTE_KEY,
    channel: "wechat",
    target: "owner-1",
    senderId: "owner-1",
    sessionId: "s-login",
    sessionTitle: "修复登录问题",
    mode: "notify" as const,
    origin: "delegate" as const,
    ...overrides,
  };
}

beforeEach(async () => {
  clock = NOW;
  dir = await mkdtemp(join(tmpdir(), "route-store-"));
  filePath = join(dir, "pet", "conversation-session-routes.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("persistence", () => {
  test("a route survives a restart", async () => {
    const created = await store().upsert(input({ mode: "bound", origin: "enter" }));
    const reloaded = await store().boundRoute(ROUTE_KEY);
    expect(reloaded?.id).toBe(created.id);
    expect(reloaded?.sessionId).toBe("s-login");
  });

  test("an empty store starts clean rather than throwing", async () => {
    expect(await store().all()).toEqual([]);
  });

  test("a corrupt file is quarantined, not overwritten in place", async () => {
    await store().upsert(input());
    const original = await readFile(filePath, "utf8");
    await writeFile(filePath, "{ not json", "utf8");
    expect(await store().all()).toEqual([]);
    // The bad bytes are preserved somewhere for diagnosis.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(dir, "pet"));
    expect(entries.some((name) => name.endsWith(".corrupt"))).toBe(true);
    expect(original).toContain("s-login");
  });

  test("one unreadable row never blocks the others", async () => {
    const first = await store().upsert(input());
    const raw = JSON.parse(await readFile(filePath, "utf8")) as { routes: unknown[] };
    raw.routes.push({ schemaVersion: 1, id: "broken", mode: "sideways" });
    await writeFile(filePath, JSON.stringify(raw), "utf8");
    const loaded = await store().all();
    expect(loaded.map((route) => route.id)).toEqual([first.id]);
  });

  test("a future schema version is quarantined instead of misread", async () => {
    await store().upsert(input());
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    await writeFile(filePath, JSON.stringify({ ...raw, version: 99 }), "utf8");
    expect(await store().all()).toEqual([]);
  });
});

describe("bound routing", () => {
  test("only a bound route captures a conversation", async () => {
    const shared = store();
    await shared.upsert(input());
    expect(await shared.boundRoute(ROUTE_KEY)).toBeUndefined();
    await shared.upsert(input({ mode: "bound", origin: "enter" }));
    expect((await shared.boundRoute(ROUTE_KEY))?.sessionId).toBe("s-login");
  });

  test("entering a second Session leaves the first", async () => {
    // Otherwise one message would fan out to two Sessions at once.
    const shared = store();
    await shared.upsert(input({ mode: "bound", origin: "enter" }));
    await shared.upsert(
      input({ mode: "bound", origin: "enter", sessionId: "s-billing", sessionTitle: "账单" }),
    );
    expect((await shared.boundRoute(ROUTE_KEY))?.sessionId).toBe("s-billing");
    const all = await shared.all();
    expect(all.filter((route) => route.mode === "bound")).toHaveLength(1);
    expect(all.find((route) => route.sessionId === "s-login")?.mode).toBe("notify");
  });

  test("another conversation is never captured by this one's route", async () => {
    const shared = store();
    await shared.upsert(input({ mode: "bound", origin: "enter" }));
    expect(await shared.boundRoute(OTHER_KEY)).toBeUndefined();
  });

  test("leaving keeps the route so the completion still arrives", async () => {
    const shared = store();
    await shared.upsert(input({ mode: "bound", origin: "enter" }));
    await shared.leave(ROUTE_KEY, "user");
    expect(await shared.boundRoute(ROUTE_KEY)).toBeUndefined();
    expect(await shared.notifyRoutesForSession("s-login")).toHaveLength(1);
  });

  test("a suspended route stops both routing and notification", async () => {
    const shared = store();
    const bound = await shared.upsert(input({ mode: "bound", origin: "enter" }));
    await shared.suspend(bound.id, "worktree-missing");
    expect(await shared.boundRoute(ROUTE_KEY)).toBeUndefined();
    expect(await shared.notifyRoutesForSession("s-login")).toEqual([]);
  });
});

describe("expiry", () => {
  test("a route that aged out while the app was closed cannot capture a message", async () => {
    await store().upsert(input({ mode: "bound", origin: "enter" }));
    clock = NOW + BOUND_ROUTE_IDLE_EXPIRY_MS;
    expect(await store().boundRoute(ROUTE_KEY)).toBeUndefined();
  });

  test("expiring downgrades to notify and is durable", async () => {
    await store().upsert(input({ mode: "bound", origin: "enter" }));
    clock = NOW + BOUND_ROUTE_IDLE_EXPIRY_MS;
    const expired = await store().expireStaleBoundRoutes();
    expect(expired).toHaveLength(1);
    const persisted = await store().all();
    expect(persisted[0]?.mode).toBe("notify");
  });

  test("inbound traffic keeps a busy conversation alive", async () => {
    const shared = store();
    const bound = await shared.upsert(input({ mode: "bound", origin: "enter" }));
    clock = NOW + BOUND_ROUTE_IDLE_EXPIRY_MS - 1_000;
    await shared.recordInbound(bound.id);
    clock = NOW + BOUND_ROUTE_IDLE_EXPIRY_MS + 1_000;
    expect((await shared.boundRoute(ROUTE_KEY))?.id).toBe(bound.id);
  });
});

describe("stale prompt", () => {
  test("warns once per quiet period", async () => {
    const shared = store();
    const bound = await shared.upsert(input({ mode: "bound", origin: "enter" }));
    await shared.recordInbound(bound.id);
    clock = NOW + BOUND_ROUTE_STALE_PROMPT_MS;
    expect(await shared.consumeStalePrompt(bound.id)).toBe(true);
    expect(await shared.consumeStalePrompt(bound.id)).toBe(false);
  });

  test("does not warn an active conversation", async () => {
    const shared = store();
    const bound = await shared.upsert(input({ mode: "bound", origin: "enter" }));
    await shared.recordInbound(bound.id);
    clock = NOW + 60_000;
    expect(await shared.consumeStalePrompt(bound.id)).toBe(false);
  });
});

describe("concurrent mutation", () => {
  test("interleaved writes all land", async () => {
    const shared = store();
    await Promise.all([
      shared.upsert(input({ sessionId: "s-a", sessionTitle: "A" })),
      shared.upsert(input({ sessionId: "s-b", sessionTitle: "B" })),
      shared.upsert(input({ sessionId: "s-c", sessionTitle: "C" })),
    ]);
    const persisted = await store().all();
    expect(persisted.map((route) => route.sessionId).sort()).toEqual(["s-a", "s-b", "s-c"]);
  });

  test("an unaddressable route is refused rather than stored", async () => {
    await expect(store().upsert(input({ target: "" }))).rejects.toThrow(/unaddressable/u);
  });
});

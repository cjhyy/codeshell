import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PetRuleStore, type NoticeRule, type PetChatRoute } from "./pet-rule-store.js";

const NOW = 1_700_000_000_000;

let dir: string;
let filePath: string;
let clock = NOW;

function store(options: { maxRules?: number } = {}): PetRuleStore {
  return new PetRuleStore({ path: filePath, now: () => clock, ...options });
}

const ROUTE: PetChatRoute = {
  kind: "im-gateway",
  channel: "wechat",
  target: "owner-1",
  senderId: "owner-1",
  isDirectMessage: true,
};

function upsert(
  overrides: Partial<Parameters<PetRuleStore["upsertSessionRule"]>[0]> = {},
): Parameters<PetRuleStore["upsertSessionRule"]>[0] {
  return {
    sessionId: "s-login",
    createdBy: "notify-me",
    events: ["done", "failed"],
    scope: "turn",
    channel: "auto",
    attention: "always",
    target: { kind: "owner" },
    origin: "user",
    armedAt: NOW - 10,
    ...overrides,
  };
}

async function readDisk(): Promise<{ version: number; rules: unknown[]; quarantine: unknown[] }> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

beforeEach(async () => {
  clock = NOW;
  dir = await mkdtemp(join(tmpdir(), "pet-rule-store-"));
  filePath = join(dir, "pet", "rules.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("flush", () => {
  test("waits for queued writes", async () => {
    const s = store();
    await s.load();
    void s.upsertSessionRule(upsert());
    void s.upsertSessionRule(upsert({ sessionId: "s-other" }));
    await s.flush();
    expect((await readDisk()).rules).toHaveLength(2);
  });
});

describe("upsertSessionRule", () => {
  test("creates an active session rule with a random stable id", async () => {
    const s = store();
    await s.load();
    const rule = await s.upsertSessionRule(upsert({ note: "提醒我看日志" }));
    expect(rule.id).toMatch(/^rule-[0-9a-f-]{36}$/u);
    expect(rule).toMatchObject({
      version: 1,
      origin: "user",
      createdBy: "notify-me",
      when: {
        kind: "session",
        sessionId: "s-login",
        runtime: "native",
        events: ["done", "failed"],
        scope: "turn",
        armedAt: NOW - 10,
      },
      then: { mode: "notify" },
      attention: "always",
      channel: "auto",
      target: { kind: "owner" },
      note: "提醒我看日志",
      state: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const other = await s.upsertSessionRule(upsert({ sessionId: "s-other" }));
    expect(other.id).not.toBe(rule.id);
  });

  test("same session + same owner target updates the one active rule", async () => {
    const s = store();
    const first = await s.upsertSessionRule(upsert());
    clock = NOW + 1_000;
    const second = await s.upsertSessionRule(
      upsert({
        createdBy: "bell",
        events: ["blocked"],
        scope: "goal",
        channel: "lark",
        attention: "important",
        note: "要等审批",
        armedAt: 42,
      }),
    );
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(2);
    expect(second.createdAt).toBe(NOW);
    expect(second.updatedAt).toBe(NOW + 1_000);
    expect(second.createdBy).toBe("notify-me");
    expect(second.when).toMatchObject({ events: ["blocked"], scope: "goal", armedAt: 42 });
    expect(second.channel).toBe("lark");
    expect(second.attention).toBe("important");
    expect(second.note).toBe("要等审批");
    expect(s.list().filter((rule) => rule.state === "active")).toHaveLength(1);
  });

  test("an owner upsert takes over Mimi's delegation rule; Mimi never rewrites the owner's", async () => {
    const s = store();
    const delegation = await s.upsertSessionRule(
      upsert({ createdBy: "delegation", origin: "delegation", channel: "auto" }),
    );
    const owned = await s.upsertSessionRule(
      upsert({ createdBy: "bell", channel: "lark", attention: "important" }),
    );
    expect(owned).toMatchObject({
      id: delegation.id,
      origin: "user",
      createdBy: "bell",
      channel: "lark",
      attention: "important",
    });
    const kept = await s.upsertSessionRule(
      upsert({ createdBy: "delegation", origin: "delegation", channel: "auto" }),
    );
    expect(kept).toEqual(owned);
    expect(s.list()).toEqual([owned]);
  });

  test("a repeat upsert without a note clears the previous note", async () => {
    const s = store();
    await s.upsertSessionRule(upsert({ note: "old" }));
    const next = await s.upsertSessionRule(upsert());
    expect(next.note).toBeUndefined();
  });

  test("same conversation with new capabilities is one rule and stores the new route", async () => {
    const s = store();
    const first = await s.upsertSessionRule(
      upsert({ target: { kind: "route", route: { ...ROUTE, replyAttachmentKinds: ["image"] } } }),
    );
    const refreshed: PetChatRoute = {
      ...ROUTE,
      replyButton: "native",
      replyAttachmentKinds: ["file", "image"],
    };
    const second = await s.upsertSessionRule(
      upsert({ target: { kind: "route", route: refreshed } }),
    );
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(2);
    expect(second.target).toEqual({ kind: "route", route: refreshed });
    const reloaded = store();
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.get(first.id)?.target).toEqual({ kind: "route", route: refreshed });
  });

  test("a route without a sender is keyed by channel + target", async () => {
    const s = store();
    const group = { kind: "im-gateway" as const, channel: "lark", target: "group-1" };
    const first = await s.upsertSessionRule(upsert({ target: { kind: "route", route: group } }));
    const again = await s.upsertSessionRule(
      upsert({ target: { kind: "route", route: { ...group, replyButton: "link" } } }),
    );
    const withSender = await s.upsertSessionRule(
      upsert({ target: { kind: "route", route: { ...group, senderId: "u1" } } }),
    );
    expect(again.id).toBe(first.id);
    expect(withSender.id).not.toBe(first.id);
  });

  test("routes are stored in normalised form", async () => {
    const rule = await store().upsertSessionRule(
      upsert({ target: { kind: "route", route: { ...ROUTE, channel: " WeChat " } } }),
    );
    expect(rule.target).toEqual({ kind: "route", route: { ...ROUTE, channel: "wechat" } });
  });

  test("upsert leaves a paused rule paused and creates a new active one", async () => {
    const s = store();
    const original = await s.upsertSessionRule(upsert());
    const paused = await s.update(original.id, 1, { state: "paused" });
    const fresh = await s.upsertSessionRule(upsert({ armedAt: 77 }));
    expect(fresh.id).not.toBe(original.id);
    expect(fresh.state).toBe("active");
    expect(s.get(original.id)).toEqual(paused);
    expect(s.activeForSession("s-login").map((rule) => rule.id)).toEqual([fresh.id]);
  });

  test("deep-equal routes dedupe; different routes and owner coexist", async () => {
    const s = store();
    const owner = await s.upsertSessionRule(upsert());
    const routed = await s.upsertSessionRule(upsert({ target: { kind: "route", route: ROUTE } }));
    const again = await s.upsertSessionRule(
      upsert({
        target: { kind: "route", route: { ...ROUTE } },
        armedAt: 11,
      }),
    );
    const otherRoute = await s.upsertSessionRule(
      upsert({ target: { kind: "route", route: { ...ROUTE, target: "group-9" } } }),
    );
    expect(routed.id).not.toBe(owner.id);
    expect(again.id).toBe(routed.id);
    expect(again.version).toBe(2);
    expect(otherRoute.id).not.toBe(routed.id);
    expect(
      s
        .activeForSession("s-login")
        .map((rule) => rule.id)
        .sort(),
    ).toEqual([owner.id, routed.id, otherRoute.id].sort());
  });

  test("a spent/cancelled/completed rule does not block a new active rule", async () => {
    const s = store();
    let previous = await s.upsertSessionRule(upsert());
    for (const state of ["spent", "cancelled", "completed"] as const) {
      await s.update(previous.id, previous.version, { state });
      const next = await s.upsertSessionRule(upsert());
      expect(next.id).not.toBe(previous.id);
      expect(next.version).toBe(1);
      expect(next.state).toBe("active");
      previous = next;
    }
    expect(s.list()).toHaveLength(4);
  });

  test("rejects input the upsert contract would not accept", async () => {
    const s = store();
    await expect(s.upsertSessionRule(upsert({ events: [] }))).rejects.toThrow();
    await expect(
      s.upsertSessionRule(upsert({ events: ["done", "done"] as never })),
    ).rejects.toThrow();
    await expect(s.upsertSessionRule(upsert({ sessionId: "" }))).rejects.toThrow();
    await expect(s.upsertSessionRule(upsert({ attention: "muted" as never }))).rejects.toThrow();
    await expect(s.upsertSessionRule(upsert({ createdBy: "system" as never }))).rejects.toThrow();
    await expect(s.upsertSessionRule(upsert({ armedAt: -1 }))).rejects.toThrow();
    await expect(s.upsertSessionRule(upsert({ origin: "system" }))).rejects.toThrow();
    await expect(
      s.upsertSessionRule(
        upsert({ target: { kind: "route", route: { ...ROUTE, kind: "email" as never } } }),
      ),
    ).rejects.toThrow();
    expect(s.list()).toEqual([]);
  });

  test("a write is on disk before the promise resolves", async () => {
    const rule = await store().upsertSessionRule(
      upsert({ target: { kind: "route", route: ROUTE } }),
    );
    const reloaded = store();
    await reloaded.load();
    expect(reloaded.get(rule.id)).toEqual(rule);
  });

  test("writes compact JSON: rewritten on every rule change, so no indentation", async () => {
    await store().upsertSessionRule(upsert());
    const text = await readFile(filePath, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.slice(0, -1)).not.toContain("\n");
  });

  test("concurrent upserts for the same key serialise into one rule", async () => {
    const s = store();
    const results = await Promise.all([
      s.upsertSessionRule(upsert({ armedAt: 1 })),
      s.upsertSessionRule(upsert({ armedAt: 2 })),
      s.upsertSessionRule(upsert({ armedAt: 3 })),
    ]);
    expect(new Set(results.map((rule) => rule.id)).size).toBe(1);
    expect(results.map((rule) => rule.version)).toEqual([1, 2, 3]);
    const reloaded = store();
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]?.version).toBe(3);
  });
});

describe("update", () => {
  test("patches fields and bumps the version", async () => {
    const s = store();
    const rule = await s.upsertSessionRule(upsert());
    clock = NOW + 5;
    const next = await s.update(rule.id, 1, {
      state: "paused",
      channel: "desktop",
      attention: "digest",
      note: "n",
      events: ["blocked"],
    });
    expect(next).toMatchObject({
      id: rule.id,
      version: 2,
      state: "paused",
      channel: "desktop",
      attention: "digest",
      note: "n",
      updatedAt: NOW + 5,
      when: { kind: "session", events: ["blocked"] },
    });
    expect(s.activeForSession("s-login")).toEqual([]);
  });

  test("a stale version is a version_conflict", async () => {
    const s = store();
    const rule = await s.upsertSessionRule(upsert());
    await s.upsertSessionRule(upsert({ armedAt: 99 }));
    const failure = await s.update(rule.id, 1, { state: "cancelled" }).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("version_conflict");
    expect((failure as { code?: string }).code).toBe("version_conflict");
    expect(s.get(rule.id)?.state).toBe("active");
  });

  test("an unknown id is rejected", async () => {
    await expect(store().update("rule-missing", 1, { state: "paused" })).rejects.toThrow(
      "rule_not_found",
    );
  });

  test("invalid patches are rejected without changing the rule", async () => {
    const s = store();
    const rule = await s.upsertSessionRule(upsert());
    await expect(s.update(rule.id, 1, { state: "bogus" as never })).rejects.toThrow();
    await expect(s.update(rule.id, 1, { events: [] })).rejects.toThrow();
    await expect(s.update(rule.id, 1, { channel: " bad" })).rejects.toThrow();
    expect(s.get(rule.id)).toEqual(rule);
  });

  test("resuming a paused rule cannot create a second active rule for the same key", async () => {
    const s = store();
    const old = await s.upsertSessionRule(upsert());
    const paused = await s.update(old.id, 1, { state: "paused" });
    await s.upsertSessionRule(upsert());
    await expect(s.update(old.id, paused.version, { state: "active" })).rejects.toThrow(
      "duplicate_active_rule",
    );
  });

  test("a finished rule can never transition to another state", async () => {
    const s = store();
    for (const terminal of ["spent", "completed", "cancelled"] as const) {
      const rule = await s.upsertSessionRule(upsert({ sessionId: `s-${terminal}` }));
      const done = await s.update(rule.id, 1, { state: terminal });
      for (const next of ["active", "paused", "spent", "completed", "cancelled"] as const) {
        if (next === terminal) continue;
        const failure = await s.update(rule.id, done.version, { state: next }).catch((e) => e);
        expect((failure as { code?: string }).code).toBe("invalid_rule");
      }
      expect(s.get(rule.id)).toEqual(done);
    }
  });
});

describe("system rule", () => {
  test("defaults to paused (off) with all events, auto channel and owner target", () => {
    const rule = store().systemRule("all-sessions");
    expect(rule).toMatchObject({
      id: "all-sessions",
      origin: "system",
      createdBy: "system",
      when: { kind: "all-sessions", events: ["done", "failed", "blocked"], onlyWhenAway: true },
      then: { mode: "notify" },
      attention: "always",
      channel: "auto",
      target: { kind: "owner" },
      state: "paused",
    });
  });

  test("setSystemRule persists, and activeForSession includes it only when active", async () => {
    const s = store();
    const session = await s.upsertSessionRule(upsert());
    expect(s.activeForSession("s-login").map((rule) => rule.id)).toEqual([session.id]);
    const on = await s.setSystemRule("all-sessions", { state: "active", channel: "wechat" });
    expect(on.state).toBe("active");
    expect(on.channel).toBe("wechat");
    expect(on.version).toBe(1);
    expect(s.activeForSession("s-login").map((rule) => rule.id)).toEqual([
      session.id,
      "all-sessions",
    ]);
    expect(s.activeForSession("s-unrelated").map((rule) => rule.id)).toEqual(["all-sessions"]);

    const reloaded = store();
    await reloaded.load();
    expect(reloaded.systemRule("all-sessions")).toEqual(on);

    const off = await reloaded.setSystemRule("all-sessions", {
      state: "paused",
      events: ["failed"],
    });
    expect(off.version).toBe(2);
    expect(off.channel).toBe("wechat");
    expect(off.when).toMatchObject({ kind: "all-sessions", events: ["failed"] });
    expect(reloaded.activeForSession("s-unrelated")).toEqual([]);
  });

  test("setSystemRule rejects terminal states and bad events", async () => {
    const s = store();
    await expect(s.setSystemRule("all-sessions", { state: "spent" as never })).rejects.toThrow();
    await expect(s.setSystemRule("all-sessions", { events: [] })).rejects.toThrow();
    await expect(s.setSystemRule("other" as never, { state: "active" })).rejects.toThrow();
  });
});

describe("onChange", () => {
  test("listeners fire after a committed write and can unsubscribe", async () => {
    const s = store();
    let calls = 0;
    const off = s.onChange(() => {
      calls += 1;
      expect(s.list().length).toBeGreaterThan(0);
    });
    await s.upsertSessionRule(upsert());
    expect(calls).toBe(1);
    off();
    await s.setSystemRule("all-sessions", { state: "active" });
    expect(calls).toBe(1);
  });

  test("a throwing listener does not fail the write", async () => {
    const s = store();
    s.onChange(() => {
      throw new Error("observer boom");
    });
    await expect(s.upsertSessionRule(upsert())).resolves.toBeTruthy();
  });
});

describe("load", () => {
  test("a missing file loads empty and writes nothing", async () => {
    const s = store();
    await s.load();
    expect(s.list()).toEqual([]);
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  test("a corrupt file is quarantined aside and the store starts empty", async () => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "{ not json", { mode: 0o600 });
    const s = store();
    await s.load();
    expect(s.list()).toEqual([]);
    const siblings = await readdir(dirname(filePath));
    const quarantined = siblings.filter((name) => name.endsWith(".corrupt"));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(join(dirname(filePath), quarantined[0]!), "utf8")).toBe("{ not json");
    await s.upsertSessionRule(upsert());
    expect((await readDisk()).rules).toHaveLength(1);
  });

  test("an unknown row is kept in quarantine and written back unchanged", async () => {
    const valid = await store().upsertSessionRule(upsert());
    const disk = await readDisk();
    const unknownRow = { id: "rule-from-the-future", when: { kind: "calendar" }, extra: [1, 2] };
    await writeFile(
      filePath,
      JSON.stringify({ ...disk, rules: [...disk.rules, unknownRow], quarantine: [] }),
      { mode: 0o600 },
    );

    const s = store();
    await s.load();
    expect(s.list()).toEqual([valid]);
    await s.upsertSessionRule(upsert({ sessionId: "s-two" }));
    const after = await readDisk();
    expect(after.rules).toHaveLength(2);
    expect(after.quarantine).toEqual([unknownRow]);

    // Quarantine survives further round trips, and never re-enters the live set.
    const again = store();
    await again.load();
    expect(again.list()).toHaveLength(2);
    await again.setSystemRule("all-sessions", { state: "active" });
    expect((await readDisk()).quarantine).toEqual([unknownRow]);
  });

  test("a duplicate id keeps the higher version and quarantines the other", async () => {
    const valid = await store().upsertSessionRule(upsert());
    const disk = await readDisk();
    const newer = { ...(disk.rules[0] as NoticeRule), version: 5, note: "newer" };
    const sameVersion = { ...(disk.rules[0] as NoticeRule), note: "same version" };
    await writeFile(
      filePath,
      JSON.stringify({ ...disk, rules: [disk.rules[0], newer, sameVersion] }),
      { mode: 0o600 },
    );
    const s = store();
    await s.load();
    expect(s.list()).toEqual([newer]);
    await s.upsertSessionRule(upsert({ sessionId: "s-two" }));
    expect((await readDisk()).quarantine).toEqual([valid, sameVersion]);
  });

  test("a legacy sequence-armed row loads as armed at its last update", async () => {
    const valid = await store().upsertSessionRule(upsert());
    const disk = await readDisk();
    const { armedAt: _armedAt, ...when } = (disk.rules[0] as NoticeRule).when as {
      armedAt: number;
    };
    const updatedAt = valid.createdAt + 5_000;
    const legacy = {
      ...(disk.rules[0] as NoticeRule),
      updatedAt,
      when: { ...when, armedAtSeq: 4 },
    };
    await writeFile(filePath, JSON.stringify({ ...disk, rules: [legacy] }), { mode: 0o600 });
    const s = store();
    await s.load();
    expect(s.list()).toEqual([
      { ...valid, updatedAt, when: { ...valid.when, armedAt: updatedAt } },
    ]);
    await s.upsertSessionRule(upsert({ sessionId: "s-two" }));
    const after = await readDisk();
    expect(after.quarantine).toEqual([]);
    expect((after.rules[0] as NoticeRule).when).not.toHaveProperty("armedAtSeq");
  });

  test("a row carrying both arming fields is quarantined unchanged", async () => {
    await store().upsertSessionRule(upsert());
    const disk = await readDisk();
    const rule = disk.rules[0] as NoticeRule;
    const both = { ...rule, when: { ...rule.when, armedAtSeq: 4 } };
    await writeFile(filePath, JSON.stringify({ ...disk, rules: [both] }), { mode: 0o600 });
    const s = store();
    await s.load();
    expect(s.list()).toEqual([]);
    await s.upsertSessionRule(upsert({ sessionId: "s-two" }));
    expect((await readDisk()).quarantine).toEqual([both]);
  });

  test("a file from a newer schema is left untouched and writes are refused", async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const future = JSON.stringify({ version: 99, rules: [{ anything: true }] });
    await writeFile(filePath, future, { mode: 0o600 });
    const s = store();
    await s.load();
    expect(s.list()).toEqual([]);
    await expect(s.upsertSessionRule(upsert())).rejects.toThrow("rule_store_unwritable");
    expect(await readFile(filePath, "utf8")).toBe(future);
  });

  test("a structurally wrong v1 file is quarantined aside", async () => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ version: 1, rules: "nope" }), { mode: 0o600 });
    const s = store();
    await s.load();
    expect(s.list()).toEqual([]);
    const siblings = await readdir(dirname(filePath));
    expect(siblings.filter((name) => name.endsWith(".corrupt"))).toHaveLength(1);
  });
});

describe("cap", () => {
  test("evicts the oldest non-active rules first", async () => {
    const s = store({ maxRules: 3 });
    const a = await s.upsertSessionRule(upsert({ sessionId: "a" }));
    clock += 1;
    const b = await s.upsertSessionRule(upsert({ sessionId: "b" }));
    clock += 1;
    const c = await s.upsertSessionRule(upsert({ sessionId: "c" }));
    clock += 1;
    await s.update(b.id, 1, { state: "spent" });
    clock += 1;
    await s.update(a.id, 1, { state: "completed" });
    clock += 1;
    const d = await s.upsertSessionRule(upsert({ sessionId: "d" }));
    // b was finished before a, so it is the oldest non-active rule.
    expect(
      s
        .list()
        .map((rule) => rule.id)
        .sort(),
    ).toEqual([a.id, c.id, d.id].sort());
    const reloaded = store({ maxRules: 3 });
    await reloaded.load();
    expect(reloaded.get(b.id)).toBeUndefined();
  });

  test("never evicts active rules; throws when every rule is active", async () => {
    const s = store({ maxRules: 2 });
    await s.upsertSessionRule(upsert({ sessionId: "a" }));
    await s.upsertSessionRule(upsert({ sessionId: "b" }));
    await expect(s.upsertSessionRule(upsert({ sessionId: "c" }))).rejects.toThrow(
      "rule_store_full",
    );
    expect(s.list()).toHaveLength(2);
    // Updating an existing active rule needs no new slot.
    await expect(s.upsertSessionRule(upsert({ sessionId: "a", armedAt: 5 }))).resolves.toBeTruthy();
  });
});

describe("cap: paused", () => {
  test("a paused rule is never evicted", async () => {
    const s = store({ maxRules: 2 });
    const a = await s.upsertSessionRule(upsert({ sessionId: "a" }));
    clock += 1;
    await s.update(a.id, 1, { state: "paused" });
    clock += 1;
    const b = await s.upsertSessionRule(upsert({ sessionId: "b" }));
    clock += 1;
    await s.update(b.id, 1, { state: "spent" });
    clock += 1;
    await s.upsertSessionRule(upsert({ sessionId: "c" }));
    expect(s.get(a.id)?.state).toBe("paused");
    expect(s.get(b.id)).toBeUndefined();
    await expect(s.upsertSessionRule(upsert({ sessionId: "d" }))).rejects.toThrow(
      "rule_store_full",
    );
    expect(s.get(a.id)?.state).toBe("paused");
  });
});

describe("failed writes", () => {
  test("leave memory unchanged, fire no listeners, and the next write succeeds", async () => {
    const s = store();
    const rule = await s.upsertSessionRule(upsert());
    let calls = 0;
    s.onChange(() => {
      calls += 1;
    });
    // A directory at the target path makes the atomic replace fail.
    await rm(filePath);
    await mkdir(filePath);
    await expect(s.upsertSessionRule(upsert({ sessionId: "s-two" }))).rejects.toThrow();
    await expect(s.update(rule.id, 1, { state: "paused" })).rejects.toThrow();
    expect(s.list()).toEqual([rule]);
    expect(calls).toBe(0);

    await rm(filePath, { recursive: true });
    const next = await s.update(rule.id, 1, { state: "paused" });
    expect(next.version).toBe(2);
    expect(calls).toBe(1);
    const reloaded = store();
    await reloaded.load();
    expect(reloaded.list()).toEqual([next]);
  });
});

describe("lock hook", () => {
  test("every write runs inside the injected lock", async () => {
    let depth = 0;
    let entered = 0;
    const s = new PetRuleStore({
      path: filePath,
      now: () => clock,
      lock: async (critical) => {
        entered += 1;
        depth += 1;
        expect(depth).toBe(1);
        try {
          return await critical();
        } finally {
          depth -= 1;
        }
      },
    });
    await Promise.all([
      s.upsertSessionRule(upsert({ sessionId: "a" })),
      s.upsertSessionRule(upsert({ sessionId: "b" })),
      s.setSystemRule("all-sessions", { state: "active" }),
    ]);
    expect(entered).toBe(3);
  });
});

describe("schedule rules", () => {
  const HOUR = 60 * 60_000;
  const ID = "rule-00000000-0000-4000-8000-0000000000aa";
  function schedule(
    overrides: Partial<Parameters<PetRuleStore["createScheduleRule"]>[0]> = {},
  ): Parameters<PetRuleStore["createScheduleRule"]>[0] {
    return {
      id: ID,
      when: { kind: "schedule", at: NOW + HOUR, timezone: "UTC", missedPolicy: "fire-once" },
      then: { mode: "remind", title: "交材料", text: "提醒我交材料" },
      channel: "auto",
      target: { kind: "owner" },
      ...overrides,
    };
  }
  /** 2023-11-15 09:00 UTC: the first "0 9 * * *" after NOW (2023-11-14 22:13 UTC). */
  const NINE = Date.UTC(2023, 10, 15, 9, 0);
  const daily = {
    kind: "schedule" as const,
    cron: "0 9 * * *",
    label: "每天 09:00",
    timezone: "UTC",
    missedPolicy: "fire-once" as const,
  };

  test("a one-shot is stored with its first occurrence scheduled", async () => {
    const s = store();
    const rule = await s.createScheduleRule(schedule());
    expect(rule).toMatchObject({
      id: ID,
      version: 1,
      origin: "user",
      createdBy: "follow-up",
      attention: "always",
      state: "active",
      when: { kind: "schedule", at: NOW + HOUR },
      wake: { occurrence: NOW + HOUR, status: "scheduled" },
    });
    const reloaded = store();
    await reloaded.load();
    expect(reloaded.get(ID)).toEqual(rule);
  });

  test("the same id is a replay: it returns the rule as it is now, never re-creates it", async () => {
    const s = store();
    await s.createScheduleRule(schedule());
    const moved = await s.rescheduleRule(ID, 1, { ...schedule().when, at: NOW + 2 * HOUR });
    expect(await s.createScheduleRule(schedule())).toEqual(moved);
    expect(s.list()).toHaveLength(1);
  });

  test("a repeating rule starts at the next cron occurrence", async () => {
    const s = store();
    const rule = await s.createScheduleRule(schedule({ when: daily }));
    expect(rule.wake).toEqual({ occurrence: NINE, status: "scheduled" });
  });

  test("refuses a past one-shot, a too-frequent or a never-firing cron", async () => {
    const s = store();
    await expect(
      s.createScheduleRule(schedule({ when: { ...schedule().when, at: NOW - 1 } })),
    ).rejects.toThrow("schedule_in_past");
    await expect(
      s.createScheduleRule(schedule({ when: { ...daily, cron: "*/10 * * * *" } })),
    ).rejects.toThrow("invalid_rule");
    await expect(
      s.createScheduleRule(schedule({ when: { ...daily, label: undefined } })),
    ).rejects.toThrow("invalid_rule");
    await expect(
      // A date that never exists is not a valid schedule at all.
      s.createScheduleRule(schedule({ when: { ...daily, cron: "0 9 31 2 *" } })),
    ).rejects.toThrow("invalid_rule");
    await expect(
      s.createScheduleRule(
        schedule({ when: { ...daily, catchUpUntil: NOW + 2 * HOUR } as typeof daily }),
      ),
    ).rejects.toThrow("invalid_rule");
    expect(s.list()).toEqual([]);
  });

  test("schedule rules never match a Session's events", async () => {
    const s = store();
    await s.createScheduleRule(schedule());
    await s.upsertSessionRule(upsert());
    expect(s.activeForSession("s-login").map((rule) => rule.when.kind)).toEqual(["session"]);
  });

  test("an occurrence is claimed once, only when due, and settles without a version bump", async () => {
    const s = store();
    await s.createScheduleRule(schedule());
    expect(await s.claimOccurrence(ID, 1, NOW + HOUR)).toBeUndefined();
    clock = NOW + HOUR;
    expect(await s.claimOccurrence(ID, 2, NOW + HOUR)).toBeUndefined();
    expect(await s.claimOccurrence(ID, 1, NOW)).toBeUndefined();
    const claimed = await s.claimOccurrence(ID, 1, NOW + HOUR);
    expect(claimed?.wake).toEqual({ occurrence: NOW + HOUR, status: "claimed", claimedAt: clock });
    expect(await s.claimOccurrence(ID, 1, NOW + HOUR)).toBeUndefined();
    clock += 5;
    const settled = await s.settleOccurrence(ID, NOW + HOUR, {
      status: "notified",
      detail: "提醒我交材料",
    });
    expect(settled).toMatchObject({
      version: 1,
      state: "active",
      wake: { status: "notified", completedAt: clock, detail: "提醒我交材料" },
    });
    // Settling again (a duplicate callback) changes nothing.
    expect(await s.settleOccurrence(ID, NOW + HOUR, { status: "failed" })).toBeUndefined();
  });

  test("a repeating rule moves on to its next occurrence once settled", async () => {
    const s = store();
    await s.createScheduleRule(schedule({ when: daily }));
    clock = NINE + 30_000;
    await s.claimOccurrence(ID, 1, NINE);
    const settled = await s.settleOccurrence(ID, NINE, { status: "notified", detail: "写周报" });
    expect(settled?.wake).toEqual({
      occurrence: NINE + 24 * HOUR,
      status: "scheduled",
      detail: "写周报",
    });
    expect(settled?.version).toBe(1);
  });

  test("a sleep over several occurrences moves on from now, not one day at a time", async () => {
    const s = store();
    await s.createScheduleRule(schedule({ when: daily }));
    clock = NINE + 3 * 24 * HOUR + HOUR;
    await s.claimOccurrence(ID, 1, NINE);
    const settled = await s.settleOccurrence(ID, NINE, { status: "failed", detail: "错过" });
    expect(settled?.wake?.occurrence).toBe(NINE + 4 * 24 * HOUR);
  });

  test("a surviving claim is recovered as unknown; a repeating rule moves on", async () => {
    const s = store();
    await s.createScheduleRule(schedule());
    await s.createScheduleRule(
      schedule({ id: "rule-00000000-0000-4000-8000-0000000000bb", when: daily }),
    );
    clock = NINE + 1_000;
    await s.claimOccurrence(ID, 1, NOW + HOUR);
    await s.claimOccurrence("rule-00000000-0000-4000-8000-0000000000bb", 1, NINE);
    const reloaded = store();
    expect(await reloaded.recoverClaims()).toBe(2);
    expect(reloaded.get(ID)?.wake).toMatchObject({ status: "unknown", completedAt: clock });
    expect(reloaded.get("rule-00000000-0000-4000-8000-0000000000bb")?.wake).toMatchObject({
      occurrence: NINE + 24 * HOUR,
      status: "scheduled",
    });
    expect(await reloaded.recoverClaims()).toBe(0);
  });

  test("reschedule bumps the version and starts a fresh occurrence", async () => {
    const s = store();
    await s.createScheduleRule(schedule());
    const moved = await s.rescheduleRule(ID, 1, daily);
    expect(moved).toMatchObject({
      version: 2,
      when: daily,
      wake: { occurrence: NINE, status: "scheduled" },
    });
    await expect(s.rescheduleRule(ID, 1, daily)).rejects.toThrow("version_conflict");
    const done = await s.update(ID, 2, { state: "completed" });
    expect(done.state).toBe("completed");
    await expect(s.rescheduleRule(ID, 3, daily)).rejects.toThrow("invalid_rule");
  });

  test("an edit while an occurrence runs applies at once; the run's outcome still lands", async () => {
    const s = store();
    await s.createScheduleRule(schedule({ when: daily }));
    clock = NINE;
    await s.claimOccurrence(ID, 1, NINE);
    // Cancelled mid-run: the outcome is recorded, a finished rule does not move on.
    await s.update(ID, 1, { state: "cancelled" });
    const settled = await s.settleOccurrence(ID, NINE, { status: "launched", taskId: "task-1" });
    expect(settled).toMatchObject({
      state: "cancelled",
      wake: { occurrence: NINE, status: "launched", taskId: "task-1" },
    });

    const t = store();
    await t.createScheduleRule(
      schedule({ id: "rule-00000000-0000-4000-8000-0000000000bb", when: daily }),
    );
    await t.claimOccurrence("rule-00000000-0000-4000-8000-0000000000bb", 1, NINE);
    // Rescheduled mid-run: the new timing replaces the claim; the late settle finds nothing.
    const moved = await t.rescheduleRule("rule-00000000-0000-4000-8000-0000000000bb", 1, {
      ...daily,
      cron: "0 10 * * *",
    });
    expect(moved.wake).toEqual({ occurrence: NINE + HOUR, status: "scheduled" });
    expect(
      await t.settleOccurrence("rule-00000000-0000-4000-8000-0000000000bb", NINE, {
        status: "notified",
      }),
    ).toBeUndefined();
  });

  test("a staggered occurrence cannot be claimed before its stagger has passed", async () => {
    const s = store();
    await s.createScheduleRule(schedule());
    await s.createScheduleRule(schedule({ id: "rule-00000000-0000-4000-8000-0000000000bb" }));
    clock = NOW + HOUR;
    expect(
      await s.claimOccurrence("rule-00000000-0000-4000-8000-0000000000bb", 1, NOW + HOUR),
    ).toBeUndefined();
    clock = NOW + HOUR + 60_000;
    expect(
      await s.claimOccurrence("rule-00000000-0000-4000-8000-0000000000bb", 1, NOW + HOUR),
    ).toBeDefined();
  });

  test("a repeating rule finished mid-run keeps that run's full outcome", async () => {
    const s = store();
    await s.createScheduleRule(schedule({ when: daily }));
    clock = NINE;
    await s.claimOccurrence(ID, 1, NINE);
    await s.update(ID, 1, { state: "completed" });
    const settled = await s.settleOccurrence(ID, NINE, {
      status: "notified",
      detail: "写周报",
      taskId: "task-9",
    });
    expect(settled?.wake).toMatchObject({ status: "notified", detail: "写周报", taskId: "task-9" });
  });

  test("session-only patches and session rules with a wake are invalid", async () => {
    const s = store();
    await s.createScheduleRule(schedule());
    await expect(s.update(ID, 1, { events: ["done"] })).rejects.toThrow("invalid_rule");
    const session = await s.upsertSessionRule(upsert());
    await expect(s.rescheduleRule(session.id, 1, daily)).rejects.toThrow("invalid_rule");
  });

  test("malformed schedule rows are quarantined one by one", async () => {
    const s = store();
    const good = await s.createScheduleRule(schedule());
    const disk = await readDisk();
    const row = disk.rules[0] as NoticeRule;
    const bad = [
      { ...row, id: "rule-00000000-0000-4000-8000-000000000001", wake: undefined },
      { ...row, id: "rule-00000000-0000-4000-8000-000000000002", then: { mode: "compose" } },
      {
        ...row,
        id: "rule-00000000-0000-4000-8000-000000000003",
        when: { ...row.when, cron: "0 9 * * *" },
      },
      {
        ...row,
        id: "rule-00000000-0000-4000-8000-000000000004",
        wake: { occurrence: 1, status: "claimed" },
      },
      { ...row, id: "rule-00000000-0000-4000-8000-000000000005", createdBy: "notify-me" },
    ];
    await writeFile(filePath, JSON.stringify({ ...disk, rules: [row, ...bad] }), { mode: 0o600 });
    const reloaded = store();
    await reloaded.load();
    expect(reloaded.list()).toEqual([good]);
    await reloaded.createScheduleRule(
      schedule({ id: "rule-00000000-0000-4000-8000-0000000000cc" }),
    );
    expect((await readDisk()).quarantine).toHaveLength(bad.length);
  });

  test("a mutation that changes nothing writes nothing and tells no listener", async () => {
    const s = store();
    await s.createScheduleRule(schedule());
    let calls = 0;
    s.onChange(() => {
      calls += 1;
    });
    const before = await readFile(filePath, "utf8");
    expect(await s.claimOccurrence(ID, 1, NOW + HOUR)).toBeUndefined();
    expect(await s.recoverClaims()).toBe(0);
    expect(calls).toBe(0);
    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  test("the cap evicts fired one-shots after finished rules, never pending ones", async () => {
    const s = store({ maxRules: 2 });
    const fired = await s.createScheduleRule(schedule());
    clock = NOW + HOUR;
    await s.claimOccurrence(ID, 1, NOW + HOUR);
    await s.settleOccurrence(ID, NOW + HOUR, { status: "notified" });
    await s.createScheduleRule(
      schedule({
        id: "rule-00000000-0000-4000-8000-0000000000bb",
        when: { ...schedule().when, at: NOW + 5 * HOUR },
      }),
    );
    await s.upsertSessionRule(upsert());
    expect(s.get(fired.id)).toBeUndefined();
    await expect(s.upsertSessionRule(upsert({ sessionId: "other" }))).rejects.toThrow(
      "rule_store_full",
    );
  });
});

describe("schedule rules: stagger", () => {
  const at = NOW + 60 * 60_000;
  const one = (n: number, when: Record<string, unknown> = {}) => ({
    id: `rule-00000000-0000-4000-8000-00000000000${n}`,
    when: {
      kind: "schedule" as const,
      at,
      timezone: "UTC",
      missedPolicy: "fire-once" as const,
      ...when,
    },
    then: { mode: "remind" as const, title: `t${n}`, text: "x" },
    channel: "auto",
    target: { kind: "owner" as const },
  });

  test("same-minute occurrences are spread a minute apart, fixed once assigned", async () => {
    const s = store();
    const a = await s.createScheduleRule(one(1));
    const b = await s.createScheduleRule(one(2, { at: at + 20_000 }));
    const c = await s.createScheduleRule(one(3));
    const d = await s.createScheduleRule(one(4, { at: at + 60_000 }));
    expect([a, b, c, d].map((rule) => rule.wake.stagger)).toEqual([
      undefined,
      60_000,
      120_000,
      undefined,
    ]);
    // a firing does not move b or c.
    clock = at;
    await s.claimOccurrence(a.id, 1, at);
    await s.settleOccurrence(a.id, at, { status: "notified" });
    expect(s.get(b.id)?.wake?.stagger).toBe(60_000);
    expect(s.get(c.id)?.wake?.stagger).toBe(120_000);
    // A finished neighbour no longer counts.
    await s.update(c.id, 1, { state: "cancelled" });
    clock = NOW;
    const e = await s.createScheduleRule(one(5));
    expect(e.wake.stagger).toBe(120_000);
  });
});

describe("schedule rules across builds", () => {
  const RULE = "rule-00000000-0000-4000-8000-0000000000aa";
  const create = (s: PetRuleStore) =>
    s.createScheduleRule({
      id: RULE,
      when: { kind: "schedule", at: NOW + 60 * 60_000, timezone: "UTC", missedPolicy: "fire-once" },
      then: { mode: "remind", title: "交材料", text: "提醒我交材料" },
      channel: "auto",
      target: { kind: "owner" },
    });

  test("a newer-schema file still answers no-op mutations (startup recovery)", async () => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ version: 99, rules: [] }), { mode: 0o600 });
    const s = store();
    expect(await s.recoverClaims()).toBe(0);
    expect(await s.claimOccurrence(RULE, 1, NOW)).toBeUndefined();
    await expect(create(s)).rejects.toThrow("rule_store_unwritable");
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ version: 99, rules: [] });
  });

  test("rows an older build quarantined come back; the newest copy wins", async () => {
    const s = store();
    const rule = await create(s);
    const session = await s.upsertSessionRule(upsert());
    // What an older build writes after its first rule change: the schedule
    // row moved to quarantine, alongside a row nobody understands.
    const disk = await readDisk();
    const alien = { id: "rule-from-the-future", when: { kind: "calendar" } };
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, rules: [session], quarantine: [rule, alien] }),
      { mode: 0o600 },
    );
    expect(disk.rules).toHaveLength(2);
    const reloaded = store();
    await reloaded.load();
    expect(reloaded.get(RULE)).toEqual(rule);
    expect(reloaded.list()).toHaveLength(2);
    await reloaded.upsertSessionRule(upsert({ sessionId: "s-two" }));
    expect((await readDisk()).quarantine).toEqual([alien]);

    // An older copy in quarantine never replaces the live one.
    const live = { ...rule, version: 3 };
    await writeFile(filePath, JSON.stringify({ version: 1, rules: [live], quarantine: [rule] }), {
      mode: 0o600,
    });
    const again = store();
    await again.load();
    expect(again.get(RULE)?.version).toBe(3);
    // A newer one in quarantine does.
    await writeFile(filePath, JSON.stringify({ version: 1, rules: [rule], quarantine: [live] }), {
      mode: 0o600,
    });
    const third = store();
    await third.load();
    expect(third.get(RULE)?.version).toBe(3);
  });

  test("cap eviction keeps failed or unknown one-shots for the owner", async () => {
    const s = store({ maxRules: 2 });
    await create(s);
    clock = NOW + 60 * 60_000;
    await s.claimOccurrence(RULE, 1, NOW + 60 * 60_000);
    await s.settleOccurrence(RULE, NOW + 60 * 60_000, { status: "unknown" });
    await s.upsertSessionRule(upsert());
    await expect(s.upsertSessionRule(upsert({ sessionId: "other" }))).rejects.toThrow(
      "rule_store_full",
    );
    expect(s.get(RULE)).toBeDefined();
  });
});

describe("system schedule rules", () => {
  const TZ = "UTC";
  const MORNING = {
    kind: "schedule",
    cron: "0 9 * * *",
    label: "每天 09:00",
    timezone: TZ,
    missedPolicy: "fire-once",
  } as const;
  const HEARTBEAT = {
    kind: "schedule",
    cron: "0,30 9-21 * * *",
    label: "活跃时段每 30 分钟",
    timezone: TZ,
    missedPolicy: "skip",
  } as const;

  test("absent until first switched on; then a fixed-shape owner rule", async () => {
    const s = store();
    await s.load();
    expect(
      await s.setSystemSchedule("system-brief-morning", { when: MORNING, state: "paused" }),
    ).toBeUndefined();
    expect(s.get("system-brief-morning")).toBeUndefined();
    const rule = await s.setSystemSchedule("system-brief-morning", {
      when: MORNING,
      state: "active",
    });
    expect(rule).toMatchObject({
      id: "system-brief-morning",
      version: 1,
      origin: "system",
      createdBy: "system",
      then: { mode: "compose", brief: "morning" },
      target: { kind: "owner" },
      channel: "auto",
      state: "active",
      wake: { occurrence: Date.UTC(2023, 10, 15, 9, 0), status: "scheduled" },
    });
    // Survives a reload: the row is valid on disk.
    const reloaded = store();
    await reloaded.load();
    expect(reloaded.get("system-brief-morning")?.state).toBe("active");
  });

  test("pausing keeps the row; switching back on starts from now, never a slept-through occurrence", async () => {
    const s = store();
    await s.load();
    await s.setSystemSchedule("system-brief-morning", { when: MORNING, state: "active" });
    const paused = await s.setSystemSchedule("system-brief-morning", {
      when: MORNING,
      state: "paused",
    });
    expect(paused).toMatchObject({ state: "paused", version: 2 });
    clock = Date.UTC(2023, 10, 16, 15, 0);
    const again = await s.setSystemSchedule("system-brief-morning", {
      when: MORNING,
      state: "active",
    });
    expect(again).toMatchObject({
      state: "active",
      version: 3,
      wake: { occurrence: Date.UTC(2023, 10, 17, 9, 0), status: "scheduled" },
    });
  });

  test("a new time reschedules; the same settings write nothing", async () => {
    const s = store();
    await s.load();
    await s.setSystemSchedule("system-brief-morning", { when: MORNING, state: "active" });
    let changes = 0;
    s.onChange(() => (changes += 1));
    await s.setSystemSchedule("system-brief-morning", { when: MORNING, state: "active" });
    expect(changes).toBe(0);
    const moved = await s.setSystemSchedule("system-brief-morning", {
      when: { ...MORNING, cron: "30 7 * * *", label: "每天 07:30" },
      state: "active",
    });
    expect(moved?.version).toBe(2);
    expect(moved?.wake.occurrence).toBe(Date.UTC(2023, 10, 15, 7, 30));
    expect(changes).toBe(1);
  });

  test("only the heartbeat may fire twice an hour, and only at minutes 30 apart", async () => {
    const s = store();
    await s.load();
    const beat = await s.setSystemSchedule("system-heartbeat", {
      when: HEARTBEAT,
      state: "active",
    });
    expect(beat?.then).toEqual({ mode: "judge", kind: "heartbeat" });
    expect(beat?.wake.occurrence).toBe(Date.UTC(2023, 10, 15, 9, 0));
    await expect(
      s.setSystemSchedule("system-brief-evening", { when: HEARTBEAT, state: "active" }),
    ).rejects.toMatchObject({ code: "invalid_rule" });
    await expect(
      s.setSystemSchedule("system-heartbeat", {
        when: { ...HEARTBEAT, cron: "0,20 9-21 * * *" },
        state: "active",
      }),
    ).rejects.toMatchObject({ code: "invalid_rule" });
    // A follow-up is never exempt.
    await expect(
      s.createScheduleRule({
        id: "rule-00000000-0000-4000-8000-0000000000cc",
        when: HEARTBEAT,
        then: { mode: "remind", title: "t", text: "x" },
        channel: "auto",
        target: { kind: "owner" },
      }),
    ).rejects.toMatchObject({ code: "invalid_rule" });
  });

  test("the recheck is a one-shot; a follow-up cannot carry a system `then`", async () => {
    const s = store();
    await s.load();
    const at = NOW + 20 * 60_000;
    const recheck = await s.setSystemSchedule("system-heartbeat-recheck", {
      when: { kind: "schedule", at, timezone: TZ, missedPolicy: "skip" },
      state: "active",
    });
    expect(recheck?.wake.occurrence).toBe(at);
    await expect(
      s.setSystemSchedule("system-heartbeat-recheck", { when: HEARTBEAT, state: "active" }),
    ).rejects.toMatchObject({ code: "invalid_rule" });
    await expect(
      s.createScheduleRule({
        id: "rule-00000000-0000-4000-8000-0000000000dd",
        when: MORNING,
        then: { mode: "compose", brief: "morning" } as never,
        channel: "auto",
        target: { kind: "owner" },
      }),
    ).rejects.toMatchObject({ code: "invalid_rule" });
  });

  test("hand-edited system rows that break the shape are quarantined", async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const row = {
      id: "system-brief-evening",
      version: 1,
      origin: "system",
      createdBy: "system",
      when: { ...MORNING, cron: "30 18 * * *" },
      then: { mode: "compose", brief: "morning" },
      wake: { occurrence: NOW + 1_000, status: "scheduled" },
      attention: "always",
      channel: "auto",
      target: { kind: "owner" },
      state: "active",
      createdAt: NOW,
      updatedAt: NOW,
    };
    await writeFile(filePath, JSON.stringify({ version: 1, rules: [row], quarantine: [] }));
    const s = store();
    await s.load();
    expect(s.get("system-brief-evening")).toBeUndefined();
  });
});

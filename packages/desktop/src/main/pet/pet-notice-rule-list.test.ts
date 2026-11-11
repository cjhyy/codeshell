import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PetNotificationSettingsView } from "../../shared/pet-notices.js";
import { petNotificationSettingsView } from "./pet-notice-settings.js";
import {
  noticeRuleSummaries,
  updateNoticeRule,
  type NoticeRuleUpdaterDeps,
} from "./pet-notice-rule-list.js";
import { PetRuleStore, type NoticeRule } from "./pet-rule-store.js";
import { syncSystemSchedules } from "./pet-proactive-rules.js";

const NOW = Date.UTC(2026, 10, 11, 8, 0);
const HOUR = 60 * 60_000;
const SID = "s-work";
const FOLLOW_UP = "rule-00000000-0000-4000-8000-0000000000aa";
const ROUTE = {
  kind: "im-gateway" as const,
  channel: "wechat",
  target: "wxid_secret_conversation",
  senderId: "wxid_secret_sender",
  isDirectMessage: true,
};

let dir: string;
let clock: number;
let settings: unknown;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pet-notice-rule-list-"));
  clock = NOW;
  settings = {};
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function harness(overrides: Partial<NoticeRuleUpdaterDeps> = {}) {
  const store = new PetRuleStore({ path: join(dir, "rules.json"), now: () => clock });
  const writes: Array<Record<string, unknown>> = [];
  const cancels: Array<[string, number]> = [];
  const view = (): PetNotificationSettingsView => petNotificationSettingsView(settings);
  const deps: NoticeRuleUpdaterDeps = {
    rules: store,
    settings: view,
    channels: () => [
      { id: "wechat", label: "微信", ready: "ready" },
      { id: "lark", label: "飞书", ready: "unknown" },
    ],
    predictIm: (channel, target) =>
      channel === "desktop"
        ? undefined
        : target.kind === "route"
          ? { label: target.route.channel, ready: "ready" }
          : channel === "auto"
            ? { label: "微信", ready: "ready" }
            : { label: channel === "lark" ? "飞书" : channel, ready: "unknown" },
    sessionTitle: (id) => (id === SID ? "修登录" : undefined),
    now: () => clock,
    writeNotificationSettings: async (notifications) => {
      writes.push(notifications);
      // Main's settings write deep-merges, then the proactive sync retimes the rules.
      const pet = (settings as { pet?: { notifications?: Record<string, unknown> } }).pet ?? {};
      const merged = structuredClone(pet.notifications ?? {}) as Record<string, any>;
      for (const [key, value] of Object.entries(notifications))
        merged[key] =
          typeof value === "object" && value
            ? { ...(merged[key] ?? {}), ...structuredClone(value as object) }
            : value;
      for (const brief of ["morning", "evening"] as const)
        if (merged.briefs?.[brief]) merged.briefs[brief] = { ...merged.briefs[brief] };
      settings = { pet: { notifications: merged } };
      const parsed = view();
      await syncSystemSchedules(
        store,
        { briefs: parsed.briefs!, heartbeat: parsed.heartbeat! },
        "UTC",
        () => undefined,
      );
    },
    cancelFollowUp: async (id, revision) => {
      cancels.push([id, revision]);
      await store.update(id, revision, { state: "cancelled" });
    },
    ...overrides,
  };
  return { store, deps, writes, cancels };
}

async function sessionRule(
  store: PetRuleStore,
  input: Partial<Parameters<PetRuleStore["upsertSessionRule"]>[0]> = {},
): Promise<NoticeRule> {
  return store.upsertSessionRule({
    sessionId: SID,
    createdBy: "bell",
    events: ["done", "blocked"],
    scope: "turn",
    channel: "auto",
    attention: "always",
    target: { kind: "owner" },
    origin: "user",
    armedAt: NOW,
    ...input,
  });
}

async function followUp(store: PetRuleStore, id = FOLLOW_UP, cron = false) {
  return store.createScheduleRule({
    id,
    when: cron
      ? {
          kind: "schedule",
          cron: "0 9 * * 1-5",
          label: "工作日 09:00",
          timezone: "UTC",
          missedPolicy: "fire-once",
        }
      : { kind: "schedule", at: NOW + HOUR, timezone: "UTC", missedPolicy: "fire-once" },
    then: {
      mode: "run-mimi",
      title: "看看 PR 有没有人回",
      text: "继续跟进 PR",
      sourceSessionId: SID,
    },
    channel: "wechat",
    target: { kind: "route", route: ROUTE },
  });
}

describe("rule summaries", () => {
  test("Mimi's own rules are always listed, from the settings, before any is stored", async () => {
    const { store, deps } = harness();
    await store.load();
    expect(noticeRuleSummaries(deps)).toEqual([
      {
        id: "all-sessions",
        version: 0,
        kind: "all-sessions",
        state: "paused",
        source: "system",
        events: ["done", "failed", "blocked"],
        target: { kind: "auto", label: "微信", ready: "ready" },
        actions: ["resume"],
        updatedAt: 0,
      },
      {
        id: "system-brief-morning",
        version: 0,
        kind: "system-brief",
        state: "paused",
        source: "system",
        brief: "morning",
        dailyAt: "09:00",
        target: { kind: "auto", label: "微信", ready: "ready" },
        actions: ["resume"],
        updatedAt: 0,
      },
      expect.objectContaining({ id: "system-brief-evening", dailyAt: "18:30", state: "paused" }),
      expect.objectContaining({
        id: "system-heartbeat",
        kind: "system-heartbeat",
        activeHours: { start: "09:00", end: "22:00" },
        actions: ["resume"],
      }),
    ]);
  });

  test("a switched-on brief shows its next time and how its last one went", async () => {
    const { store, deps } = harness();
    settings = {
      pet: { notifications: { briefs: { morning: { enabled: true, time: "09:30" } } } },
    };
    const view = petNotificationSettingsView(settings);
    await syncSystemSchedules(
      store,
      { briefs: view.briefs!, heartbeat: view.heartbeat! },
      "UTC",
      () => undefined,
    );
    const nine30 = Date.UTC(2026, 10, 11, 9, 30);
    const morning = () =>
      noticeRuleSummaries(deps).find((row) => row.id === "system-brief-morning");
    expect(morning()).toMatchObject({
      state: "active",
      version: 1,
      dailyAt: "09:30",
      schedule: { cron: "30 9 * * *", timezone: "UTC", nextAt: nine30 },
      actions: ["pause"],
    });
    expect(morning()).not.toHaveProperty("lastFiredAt");
    clock = nine30 + 1_000;
    await store.claimOccurrence("system-brief-morning", 1, nine30);
    await store.settleOccurrence("system-brief-morning", nine30, { status: "notified" });
    expect(morning()).toMatchObject({
      lastFiredAt: nine30 + 1_000,
      lastOutcome: "notified",
      schedule: { nextAt: nine30 + 24 * HOUR },
    });
  });

  test("Session rules carry their source, Session, events and a spent rule's last fire", async () => {
    const { store, deps } = harness();
    const bell = await sessionRule(store);
    await sessionRule(store, {
      createdBy: "watch-session",
      channel: "wechat",
      target: { kind: "route", route: ROUTE },
    });
    await sessionRule(store, {
      sessionId: "s-other",
      createdBy: "delegation",
      origin: "delegation",
      channel: "desktop",
    });
    const rows = noticeRuleSummaries(deps).filter((row) => row.kind === "session");
    expect(rows.map((row) => row.source).sort()).toEqual(["delegation", "owner", "watch"]);
    expect(rows.find((row) => row.id === bell.id)).toEqual({
      id: bell.id,
      version: 1,
      kind: "session",
      state: "active",
      source: "owner",
      sessionId: SID,
      sessionTitle: "修登录",
      events: ["done", "blocked"],
      scope: "turn",
      target: { kind: "auto", label: "微信", ready: "ready" },
      actions: ["pause", "cancel"],
      updatedAt: NOW,
    });
    expect(rows.find((row) => row.source === "delegation")).toMatchObject({
      target: { kind: "desktop" },
    });
    expect(rows.find((row) => row.source === "delegation")).not.toHaveProperty("sessionTitle");
    clock = NOW + 5_000;
    await store.update(bell.id, 1, { state: "spent" });
    expect(noticeRuleSummaries(deps).find((row) => row.id === bell.id)).toMatchObject({
      state: "spent",
      lastFiredAt: NOW + 5_000,
      actions: [],
    });
  });

  test("an IM target is the channel's name and chat kind, never the conversation ids", async () => {
    const { store, deps } = harness();
    await sessionRule(store, {
      createdBy: "watch-session",
      channel: "wechat",
      target: { kind: "route", route: ROUTE },
    });
    await followUp(store);
    const listed = noticeRuleSummaries(deps);
    expect(listed.find((row) => row.source === "watch")?.target).toEqual({
      kind: "chat",
      label: "微信",
      direct: true,
    });
    const text = JSON.stringify(listed);
    expect(text).not.toContain("wxid_secret_conversation");
    expect(text).not.toContain("wxid_secret_sender");
    // Nor the follow-up's own text (only its title is display data).
    expect(text).not.toContain("继续跟进 PR");
  });

  test("a follow-up shows its title, the Session it continues, its schedule and next time", async () => {
    const { store, deps } = harness();
    await followUp(store);
    await followUp(store, "rule-00000000-0000-4000-8000-0000000000bb", true);
    const [once, weekly] = [FOLLOW_UP, "rule-00000000-0000-4000-8000-0000000000bb"].map((id) =>
      noticeRuleSummaries(deps).find((row) => row.id === id),
    );
    expect(once).toMatchObject({
      kind: "schedule",
      source: "follow-up",
      title: "看看 PR 有没有人回",
      followUp: "continue",
      sessionId: SID,
      sessionTitle: "修登录",
      schedule: { at: NOW + HOUR, timezone: "UTC", nextAt: NOW + HOUR },
      target: { kind: "chat", label: "微信", direct: true },
      actions: ["pause", "cancel"],
    });
    expect(weekly).toMatchObject({
      schedule: {
        cron: "0 9 * * 1-5",
        label: "工作日 09:00",
        // Due the same minute as the one-shot: staggered one minute behind it.
        nextAt: Date.UTC(2026, 10, 11, 9, 1),
      },
    });
    // Fired: it waits on the follow-up list, can only be cancelled, and says how it went.
    clock = NOW + HOUR + 1_000;
    await store.claimOccurrence(FOLLOW_UP, 1, NOW + HOUR);
    await store.settleOccurrence(FOLLOW_UP, NOW + HOUR, { status: "launched" });
    const fired = noticeRuleSummaries(deps).find((row) => row.id === FOLLOW_UP);
    expect(fired).toMatchObject({
      lastFiredAt: NOW + HOUR + 1_000,
      lastOutcome: "launched",
      actions: ["cancel"],
    });
    expect(fired?.schedule).not.toHaveProperty("nextAt");
  });

  test("ended rules follow the live ones, newest first, at most twenty", async () => {
    const { store, deps } = harness();
    for (let index = 0; index < 23; index += 1) {
      clock = NOW + index;
      const rule = await sessionRule(store, { sessionId: `s-${index}` });
      await store.update(rule.id, rule.version, { state: "cancelled" });
    }
    clock = NOW + 100;
    const live = await sessionRule(store, { sessionId: "s-live" });
    const rows = noticeRuleSummaries(deps).filter((row) => row.kind === "session");
    expect(rows[0]?.id).toBe(live.id);
    const ended = rows.slice(1);
    expect(ended).toHaveLength(20);
    expect(ended.every((row) => row.state === "cancelled")).toBe(true);
    expect(ended[0]?.sessionId).toBe("s-22");
    expect(ended.at(-1)?.sessionId).toBe("s-3");
  });

  test("the heartbeat's one-off recheck is not a row of its own", async () => {
    const { store, deps } = harness();
    await store.setSystemSchedule("system-heartbeat-recheck", {
      when: { kind: "schedule", at: NOW + HOUR, timezone: "UTC", missedPolicy: "skip" },
      state: "active",
    });
    expect(noticeRuleSummaries(deps).map((row) => row.id)).not.toContain(
      "system-heartbeat-recheck",
    );
  });
});

describe("update-rule", () => {
  test("pause, resume and cancel a Session rule with its version", async () => {
    const { store, deps } = harness();
    const rule = await sessionRule(store);
    const paused = await updateNoticeRule(deps, {
      ruleId: rule.id,
      expectedVersion: 1,
      action: "pause",
    });
    expect(paused).toMatchObject({
      ok: true,
      rule: { state: "paused", version: 2, actions: ["resume", "cancel"] },
    });
    const resumed = await updateNoticeRule(deps, {
      ruleId: rule.id,
      expectedVersion: 2,
      action: "resume",
    });
    expect(resumed).toMatchObject({ ok: true, rule: { state: "active", version: 3 } });
    const cancelled = await updateNoticeRule(deps, {
      ruleId: rule.id,
      expectedVersion: 3,
      action: "cancel",
    });
    expect(cancelled).toMatchObject({ ok: true, rule: { state: "cancelled", actions: [] } });
    expect(store.get(rule.id)?.state).toBe("cancelled");
  });

  test("a stale version, an ended rule, an unknown id and a duplicate come back as refusals", async () => {
    const { store, deps } = harness();
    const rule = await sessionRule(store);
    expect(
      await updateNoticeRule(deps, { ruleId: rule.id, expectedVersion: 7, action: "pause" }),
    ).toMatchObject({
      ok: false,
      reason: "version_conflict",
      rule: { version: 1, state: "active" },
    });
    expect(store.get(rule.id)?.state).toBe("active");
    expect(
      await updateNoticeRule(deps, { ruleId: "rule-missing", expectedVersion: 1, action: "pause" }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await updateNoticeRule(deps, { ruleId: rule.id, expectedVersion: 1, action: "resume" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    // Paused, then a fresh rule for the same Session and target: resuming would make two.
    await store.update(rule.id, 1, { state: "paused" });
    await sessionRule(store);
    expect(
      await updateNoticeRule(deps, { ruleId: rule.id, expectedVersion: 2, action: "resume" }),
    ).toMatchObject({ ok: false, reason: "not_allowed", rule: { state: "paused" } });
    await store.update(rule.id, 2, { state: "cancelled" });
    expect(
      await updateNoticeRule(deps, { ruleId: rule.id, expectedVersion: 3, action: "resume" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  test("Mimi's paused delegation rule can be deleted but never resumed", async () => {
    const { store, deps } = harness();
    const rule = await sessionRule(store, { createdBy: "delegation", origin: "delegation" });
    const paused = await updateNoticeRule(deps, {
      ruleId: rule.id,
      expectedVersion: 1,
      action: "pause",
    });
    expect(paused).toMatchObject({ ok: true, rule: { state: "paused", actions: ["cancel"] } });
    expect(
      await updateNoticeRule(deps, { ruleId: rule.id, expectedVersion: 2, action: "resume" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(store.get(rule.id)?.state).toBe("paused");
  });

  test("a paused one-shot whose time passed says it catches up at once, or is expired", async () => {
    const { store, deps } = harness();
    await followUp(store);
    await store.update(FOLLOW_UP, 1, { state: "paused" });
    const row = () => noticeRuleSummaries(deps).find((summary) => summary.id === FOLLOW_UP);
    expect(row()).not.toHaveProperty("overdue");
    // Due an hour after NOW; its default catch-up window is a day.
    clock = NOW + 2 * HOUR;
    expect(row()).toMatchObject({ overdue: "catch-up", actions: ["resume", "cancel"] });
    clock = NOW + HOUR + 25 * HOUR;
    expect(row()).toMatchObject({ overdue: "expired", actions: ["cancel"] });
    expect(
      await updateNoticeRule(deps, { ruleId: FOLLOW_UP, expectedVersion: 2, action: "resume" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  test("a follow-up pauses in the store and is cancelled through the follow-up control", async () => {
    const { store, deps, cancels } = harness();
    await followUp(store);
    expect(
      await updateNoticeRule(deps, { ruleId: FOLLOW_UP, expectedVersion: 1, action: "pause" }),
    ).toMatchObject({ ok: true, rule: { state: "paused" } });
    expect(cancels).toEqual([]);
    expect(
      await updateNoticeRule(deps, { ruleId: FOLLOW_UP, expectedVersion: 2, action: "cancel" }),
    ).toMatchObject({ ok: true, rule: { state: "cancelled" } });
    expect(cancels).toEqual([[FOLLOW_UP, 2]]);
  });

  test("the follow-up control's wrapped store conflict is still a conflict", async () => {
    const { store, deps } = harness({
      cancelFollowUp: async (id) => {
        await store.update(id, 99, { state: "cancelled" }).catch((cause) => {
          throw new Error("跟进已被修改，请刷新后重试", { cause });
        });
      },
    });
    await followUp(store);
    expect(
      await updateNoticeRule(deps, { ruleId: FOLLOW_UP, expectedVersion: 1, action: "cancel" }),
    ).toMatchObject({ ok: false, reason: "version_conflict" });
  });

  test("the every-Session rule pauses and resumes but is never cancelled", async () => {
    const { store, deps } = harness();
    await store.load();
    expect(
      await updateNoticeRule(deps, {
        ruleId: "all-sessions",
        expectedVersion: 0,
        action: "resume",
      }),
    ).toMatchObject({ ok: true, rule: { state: "active", version: 1, actions: ["pause"] } });
    expect(
      await updateNoticeRule(deps, {
        ruleId: "all-sessions",
        expectedVersion: 1,
        action: "cancel",
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(store.systemRule("all-sessions").state).toBe("active");
  });

  test("briefs and the heartbeat switch through the settings, which retime their rules", async () => {
    const { store, deps, writes } = harness();
    await store.load();
    const on = await updateNoticeRule(deps, {
      ruleId: "system-brief-evening",
      expectedVersion: 0,
      action: "resume",
    });
    // Only the switch is written: the time keeps following the default.
    expect(writes).toEqual([{ briefs: { evening: { enabled: true } } }]);
    expect(on).toMatchObject({ ok: true, rule: { state: "active", version: 1, dailyAt: "18:30" } });
    expect(store.get("system-brief-evening")?.state).toBe("active");
    const off = await updateNoticeRule(deps, {
      ruleId: "system-brief-evening",
      expectedVersion: 1,
      action: "pause",
    });
    expect(off).toMatchObject({ ok: true, rule: { state: "paused" } });
    expect(store.get("system-brief-evening")?.state).toBe("paused");
    await updateNoticeRule(deps, {
      ruleId: "system-heartbeat",
      expectedVersion: 0,
      action: "resume",
    });
    expect(writes.at(-1)).toEqual({ heartbeat: { enabled: true } });
    expect(
      await updateNoticeRule(deps, {
        ruleId: "system-heartbeat",
        expectedVersion: 1,
        action: "cancel",
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  test("without a settings writer the briefs cannot be switched from the list", async () => {
    const { store, deps } = harness({ writeNotificationSettings: undefined });
    await store.load();
    await expect(
      updateNoticeRule(deps, {
        ruleId: "system-brief-morning",
        expectedVersion: 0,
        action: "resume",
      }),
    ).rejects.toThrow("notification settings are read-only");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PET_NOTICES_QUERY_ACTION,
  PET_NOTIFICATION_SETTINGS_QUERY_ACTION,
  PET_TRIGGERS_QUERY_ACTION,
} from "@cjhyy/code-shell-pet/protocol";
import type { HostActionHandler } from "../host-action-dispatch.js";
import type { ImGatewayOwnerChannel } from "../im-gateway-service.js";
import type { PetHostActionContext } from "./pet-dispatch-service.js";
import { ownerTurnRefusal, wireMimiNoticeTools } from "./pet-mimi-notice-tools.js";
import { createPetNoticeControls, type PetNoticeControls } from "./pet-notice-ipc.js";
import { PetNoticeLedger, type NoticeRecordInput } from "./pet-notice-ledger.js";
import { wirePetNotices, type PetNoticeWiring } from "./pet-notice-wiring.js";
import type { DesktopPetSession } from "./pet-state-aggregator.js";

const SID = "s-work";
const MIMI = "s-mimi";
const NOW = Date.UTC(2026, 10, 12, 6, 0); // 14:00 at UTC+8
const HOUR = 60 * 60_000;
const OFFSET = 480;

let dir: string;
let wiring: PetNoticeWiring | undefined;
let clock = NOW;

const DESKTOP: PetHostActionContext = {
  originClientMessageId: "cm-1",
  requestedAt: NOW,
  originRef: { id: "origin-desktop", kind: "desktop", channel: "mimi" },
};
const OWNER_DM: PetHostActionContext = {
  originClientMessageId: "cm-2",
  requestedAt: NOW,
  completionTarget: { kind: "im-gateway", channel: "wechat", target: "owner-dm", senderId: "u1" },
  senderId: "u1",
  isDirectMessage: true,
  originRef: { id: "origin-x", kind: "im-gateway", channel: "wechat" },
};
const GROUP: PetHostActionContext = {
  ...OWNER_DM,
  completionTarget: { kind: "im-gateway", channel: "wechat", target: "team-room", senderId: "u1" },
  isDirectMessage: false,
};
const STRANGER_DM: PetHostActionContext = {
  ...OWNER_DM,
  completionTarget: { kind: "im-gateway", channel: "wechat", target: "someone", senderId: "u9" },
};

function session(id: string): DesktopPetSession {
  return {
    agentSessionId: id,
    title: "修登录",
    runState: "idle",
    queueDepth: 0,
    lastActivityAt: NOW,
    pendingDecisionCount: 0,
    freshness: { source: "live", observedAt: NOW, workerState: "active" },
  } as DesktopPetSession;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The settings writer's deep merge (null deletes), as main applies it. */
function merge(base: Record<string, unknown>, patch: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (isRecord(value) && isRecord(out[key]))
      out[key] = merge(out[key] as Record<string, unknown>, value);
    else out[key] = value;
  }
  return out;
}

const isOwnerConversation = (channel: string, target: string) =>
  channel === "wechat" && target === "owner-dm";

function fixture() {
  const channels: ImGatewayOwnerChannel[] = [
    { id: "wechat", label: "微信", ready: "ready", targetId: "wechat:owner", isDirect: true },
  ];
  const settings = { value: {} as Record<string, unknown> };
  const writes: Record<string, unknown>[] = [];
  const created = wirePetNotices({
    userDataDir: dir,
    bridge: { setHostActionHandler: () => () => undefined },
    projection: {
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        workerState: "active",
        sessions: [session(SID)],
        pending: [],
        observedAt: NOW,
        workMemorySegments: [],
      }),
      subscribe: () => () => undefined,
    },
    longTasks: { activeForSession: () => undefined, getSnapshot: () => ({ tasks: [] }) },
    sessionRoutes: () => ({ notifyRoutesForSession: async () => [] }),
    gateway: {
      ownerChannels: () => channels,
      listOwnerMessageTargets: () => [],
      resolveOwnerTarget: () => undefined,
      lastOwnerInboundChannel: () => "wechat",
      isOwnerConversation,
    },
    outbox: {
      publish: async () => undefined,
      revoke: async () => undefined,
      state: () => undefined,
    },
    notifyDesktop: async () => undefined,
    readSettings: () => settings.value,
    presence: { getSystemIdleTimeSec: () => 0, hasFocusedWindow: () => true },
    isMimiSession: (id) => id === MIMI,
    now: () => clock,
    log: () => undefined,
    timezoneOffsetMin: () => OFFSET,
  });
  wiring = created;
  const writeNotificationSettings = async (notifications: Record<string, unknown>) => {
    writes.push(notifications);
    const pet = isRecord(settings.value.pet) ? settings.value.pet : {};
    const current = isRecord(pet.notifications) ? pet.notifications : {};
    settings.value = { pet: { ...pet, notifications: merge(current, notifications) } };
    created.settingsChanged();
  };
  const controls: PetNoticeControls = createPetNoticeControls({
    notices: created,
    ownerChannels: () => channels,
    goals: { readActiveGoal: () => undefined },
    writeNotificationSettings,
    now: () => clock,
  });
  const handlers = new Map<string, HostActionHandler>();
  const ledger = new PetNoticeLedger({ path: join(dir, "mimi-ledger.json"), now: () => clock });
  const tools = wireMimiNoticeTools({
    bridge: {
      setHostActionHandler: (action, handler) => {
        handlers.set(action, handler);
        return () => handlers.delete(action);
      },
    },
    isMimiSession: (id) => id === MIMI,
    ledger,
    controls: () => controls,
    settingsView: () => created.settingsView(),
    writeNotificationSettings,
    channels: () => channels,
    sessionTitle: (id) => (id === SID ? "修登录" : undefined),
    isOwnerConversation,
    now: () => clock,
    timezoneOffsetMin: () => OFFSET,
  });
  return { wiring: created, controls, settings, writes, handlers, ledger, tools };
}

function draft(overrides: Partial<NoticeRecordInput> = {}): NoticeRecordInput {
  return {
    kind: "session.done",
    priority: "P1",
    dedupeKey: `k-${Math.random()}`,
    sessionId: SID,
    ruleIds: ["rule-1"],
    facts: { title: "修登录", summary: "测试都过了", target: { kind: "owner" } },
    decision: { outlet: "desktop", reason: "present-desktop" },
    ...overrides,
  };
}

async function read(f: ReturnType<typeof fixture>, action: string, args = {}) {
  return (await f.handlers.get(action)!(MIMI, args)) as Record<string, unknown>;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pet-mimi-notice-tools-"));
  clock = NOW;
});

afterEach(async () => {
  wiring?.dispose();
  wiring = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("Notices query", () => {
  test("lists what was sent, newest first, without ids, media or reply codes", async () => {
    const f = fixture();
    await f.ledger.load();
    clock = NOW - 2 * HOUR;
    await f.ledger.record(
      draft({
        kind: "brief.morning",
        sessionId: undefined,
        dedupeKey: "brief:morning:1",
        facts: {
          title: "晨报",
          summary: "早上好",
          refs: [
            { ref: "r1", type: "done", status: "【完成】", title: "修登录", sessionId: SID },
            { ref: "r2", type: "bogus", status: "x", title: "" },
          ],
          target: { kind: "owner" },
        },
        body: "早上好：\n- 【完成】修登录",
        decision: { outlet: "im", im: "wechat", reason: "away-last-inbound" },
      }),
    );
    clock = NOW - HOUR;
    const sent = await f.ledger.record(
      draft({
        facts: {
          title: "导出报表",
          taskId: "task-7",
          target: {
            kind: "route",
            route: {
              kind: "im-gateway",
              channel: "wechat",
              target: "team-room",
              senderId: "u-secret",
              isDirectMessage: false,
            },
          },
          media: { files: [{ path: "/Users/me/secret.pdf" }] },
        },
        body: "x".repeat(900),
        decision: { outlet: "im", im: "wechat", reason: "named-im" },
      }),
    );
    await f.ledger.claim(sent.id, "wechat", "x".repeat(900));
    await f.ledger.settle(sent.id, "accepted");
    clock = NOW;
    const result = await read(f, PET_NOTICES_QUERY_ACTION, { limit: 10 });
    const notices = result.notices as Array<Record<string, unknown>>;
    expect(notices.map((notice) => notice.kind)).toEqual(["session.done", "brief.morning"]);
    const [result0, brief] = notices;
    expect(result0).toMatchObject({
      title: "导出报表",
      to: "group-chat",
      channel: "微信",
      delivery: "sent",
      createdAt: "2026-11-12T13:00:00+08:00",
      session: { id: SID, title: "修登录" },
      taskId: "task-7",
    });
    expect((result0!.text as string).length).toBe(600);
    expect(brief).toMatchObject({
      kind: "brief.morning",
      to: "owner",
      text: "早上好：\n- 【完成】修登录",
      refs: [{ type: "done", status: "【完成】", title: "修登录", sessionId: SID }],
    });
    const serialized = JSON.stringify(result);
    for (const secret of ["team-room", "u-secret", "secret.pdf", "owner-dm"])
      expect(serialized).not.toContain(secret);
  });

  test("filters by kind, session and time, and reports more past the limit", async () => {
    const f = fixture();
    await f.ledger.load();
    for (let index = 0; index < 5; index += 1) {
      clock = NOW - (5 - index) * HOUR;
      await f.ledger.record(
        draft({ kind: index % 2 ? "heartbeat" : "session.done", sessionId: `s${index}` }),
      );
    }
    clock = NOW;
    const kinds = await read(f, PET_NOTICES_QUERY_ACTION, { kinds: ["heartbeat"], limit: 10 });
    expect((kinds.notices as unknown[]).length).toBe(2);
    const bySession = await read(f, PET_NOTICES_QUERY_ACTION, { sessionId: "s2", limit: 10 });
    expect((bySession.notices as Array<{ session: { id: string } }>)[0]!.session.id).toBe("s2");
    const windowed = await read(f, PET_NOTICES_QUERY_ACTION, {
      since: NOW - 4 * HOUR,
      until: NOW - 2 * HOUR,
      limit: 10,
    });
    expect((windowed.notices as unknown[]).length).toBe(3);
    const limited = await read(f, PET_NOTICES_QUERY_ACTION, { limit: 2 });
    expect((limited.notices as unknown[]).length).toBe(2);
    expect(limited.more).toBe(true);
    await expect(read(f, PET_NOTICES_QUERY_ACTION, { limit: 99 })).rejects.toThrow("invalid");
  });

  test("answers only Mimi's own Session", async () => {
    const f = fixture();
    await expect(f.handlers.get(PET_NOTICES_QUERY_ACTION)!(SID, { limit: 3 })).rejects.toThrow(
      "only Mimi",
    );
    f.tools.dispose();
    expect(f.handlers.size).toBe(0);
  });
});

describe("Triggers and settings queries", () => {
  test("Triggers is the settings rule list, with Mimi's system actions and local times", async () => {
    const f = fixture();
    await f.controls.setSessionBell(SID, true);
    const result = await read(f, PET_TRIGGERS_QUERY_ACTION);
    const triggers = result.triggers as Array<Record<string, unknown>>;
    expect(triggers.map((row) => row.id).slice(0, 4)).toEqual([
      "all-sessions",
      "system-brief-morning",
      "system-brief-evening",
      "system-heartbeat",
    ]);
    expect(triggers[1]).toMatchObject({
      kind: "system-brief",
      state: "paused",
      when: { dailyAt: "09:00" },
      actions: ["resume", "enable", "set_time"],
    });
    expect(triggers[3]!.actions).toEqual(["resume", "enable", "set_active_hours"]);
    const own = triggers.find((row) => row.kind === "session")!;
    expect(own).toMatchObject({
      source: "owner",
      session: { id: SID, title: "修登录" },
      actions: ["pause", "cancel"],
    });
    expect(JSON.stringify(result)).not.toContain("owner-dm");
  });

  test("ended rules only on request", async () => {
    const f = fixture();
    await f.controls.setSessionBell(SID, true);
    await f.controls.setSessionBell(SID, false);
    const live = (await read(f, PET_TRIGGERS_QUERY_ACTION)).triggers as Array<{ kind: string }>;
    expect(live.some((row) => row.kind === "session")).toBe(false);
    const all = (await read(f, PET_TRIGGERS_QUERY_ACTION, { includeEnded: true }))
      .triggers as Array<{
      kind: string;
      state: string;
    }>;
    expect(all.find((row) => row.kind === "session")?.state).toBe("cancelled");
  });

  test("settings read shows an active snooze in owner-local time", async () => {
    const f = fixture();
    f.settings.value = { pet: { notifications: { maxPerHour: 4, snoozeUntil: NOW + 2 * HOUR } } };
    const result = await read(f, PET_NOTIFICATION_SETTINGS_QUERY_ACTION);
    expect(result.settings).toMatchObject({ maxPerHour: 4 });
    expect(result.settings).not.toHaveProperty("snoozeUntil");
    expect(result.snooze).toEqual({ until: "2026-11-12T16:00:00+08:00" });
    clock = NOW + 3 * HOUR;
    expect(await read(f, PET_NOTIFICATION_SETTINGS_QUERY_ACTION)).not.toHaveProperty("snooze");
  });
});

describe("owner authority", () => {
  test("only the desktop owner or the owner's private chat may change notices", () => {
    expect(ownerTurnRefusal(DESKTOP, isOwnerConversation)).toBeUndefined();
    expect(ownerTurnRefusal(OWNER_DM, isOwnerConversation)).toBeUndefined();
    expect(ownerTurnRefusal(GROUP, isOwnerConversation)).toContain("群聊");
    expect(ownerTurnRefusal(STRANGER_DM, isOwnerConversation)).toContain("只有主人本人");
    expect(ownerTurnRefusal(undefined, isOwnerConversation)).toContain("无法核实");
    expect(
      ownerTurnRefusal(
        { ...DESKTOP, originRef: { id: "origin-x", kind: "unknown", channel: "wechat" } },
        isOwnerConversation,
      ),
    ).toContain("无法核实");
  });

  test("a refused turn changes nothing", async () => {
    const f = fixture();
    const { noticeTriggerMutation, notificationSettingsMutation } = f.tools.hostActions;
    await expect(
      noticeTriggerMutation!({ ruleId: "system-brief-morning", action: "enable" }, GROUP),
    ).rejects.toThrow("群聊");
    await expect(
      notificationSettingsMutation!({ snooze: { minutes: 60 } }, STRANGER_DM),
    ).rejects.toThrow("只有主人本人");
    await expect(
      notificationSettingsMutation!({ patch: { maxPerHour: 2 } }, undefined),
    ).rejects.toThrow("无法核实");
    expect(f.writes).toEqual([]);
  });
});

describe("ManageTrigger host action", () => {
  test("system briefs and the heartbeat are switched and timed through the settings", async () => {
    const f = fixture();
    const change = f.tools.hostActions.noticeTriggerMutation!;
    expect(
      (await change({ ruleId: "system-brief-morning", action: "enable" }, DESKTOP)).message,
    ).toBe("晨报已打开。");
    expect(f.writes.at(-1)).toEqual({ briefs: { morning: { enabled: true } } });
    expect(
      (await change({ ruleId: "system-brief-morning", action: "enable" }, OWNER_DM)).message,
    ).toBe("晨报本来就是开着的，没有变化。");
    expect(
      (await change({ ruleId: "system-brief-morning", action: "set_time", time: "08:30" }, DESKTOP))
        .message,
    ).toBe("晨报时间改为每天 08:30。");
    expect(f.writes.at(-1)).toEqual({ briefs: { morning: { time: "08:30" } } });
    expect(
      (
        await change(
          { ruleId: "system-heartbeat", action: "set_active_hours", start: "10:00", end: "20:00" },
          DESKTOP,
        )
      ).message,
    ).toBe("心跳的活跃时段改为 10:00–20:00。（心跳目前是关着的）");
    expect(f.writes.at(-1)).toEqual({
      heartbeat: { activeHours: { start: "10:00", end: "20:00" } },
    });
    await change({ ruleId: "system-brief-morning", action: "disable" }, DESKTOP);
    expect(f.writes.at(-1)).toEqual({ briefs: { morning: { enabled: false } } });
    expect(f.wiring.settingsView().briefs?.morning).toEqual({ enabled: false, time: "08:30" });
  });

  test("the every-Session rule goes through its system-rule path", async () => {
    const f = fixture();
    const change = f.tools.hostActions.noticeTriggerMutation!;
    expect((await change({ ruleId: "all-sessions", action: "enable" }, DESKTOP)).message).toBe(
      "「不在电脑前时所有会话都推我」已打开。",
    );
    expect(f.wiring.ruleStore.systemRule("all-sessions").state).toBe("active");
    await expect(change({ ruleId: "all-sessions", action: "cancel" }, DESKTOP)).rejects.toThrow(
      "不能删除",
    );
  });

  test("owner rules pause, resume and cancel with optimistic versions", async () => {
    const f = fixture();
    const change = f.tools.hostActions.noticeTriggerMutation!;
    const bell = await f.controls.setSessionBell(SID, true);
    const ruleId = bell.ruleId!;
    const version = f.wiring.ruleStore.get(ruleId)!.version;
    await expect(
      change({ ruleId, action: "pause", expectedVersion: version + 1 }, DESKTOP),
    ).rejects.toThrow("刚被改过");
    expect(f.wiring.ruleStore.get(ruleId)!.state).toBe("active");
    expect(
      (await change({ ruleId, action: "pause", expectedVersion: version }, DESKTOP)).message,
    ).toBe("会话「修登录」的提醒已暂停。");
    expect(f.wiring.ruleStore.get(ruleId)!.state).toBe("paused");
    await change({ ruleId, action: "resume" }, OWNER_DM);
    expect(f.wiring.ruleStore.get(ruleId)!.state).toBe("active");
    await expect(change({ ruleId, action: "enable" }, DESKTOP)).rejects.toThrow("系统提醒");
    await expect(change({ ruleId, action: "set_time", time: "08:00" }, DESKTOP)).rejects.toThrow(
      "只有晨报",
    );
    await change({ ruleId, action: "cancel" }, DESKTOP);
    expect(f.wiring.ruleStore.get(ruleId)!.state).toBe("cancelled");
    await expect(change({ ruleId, action: "resume" }, DESKTOP)).rejects.toThrow("不能这样改");
    await expect(change({ ruleId: "rule-nope", action: "pause" }, DESKTOP)).rejects.toThrow(
      "找不到",
    );
  });
});

describe("NotificationSettings host action", () => {
  test("writes only the touched fields, completing the quiet window from the current one", async () => {
    const f = fixture();
    f.settings.value = { pet: { notifications: { quietHours: { start: "22:00", end: "07:00" } } } };
    const update = f.tools.hostActions.notificationSettingsMutation!;
    const result = await update(
      { patch: { quietHours: { enabled: false }, maxPerHour: 3, digestSlots: ["18:00", "12:00"] } },
      DESKTOP,
    );
    expect(f.writes).toEqual([
      {
        quietHours: { enabled: false, start: "22:00", end: "07:00" },
        maxPerHour: 3,
        digestSlots: ["12:00", "18:00"],
      },
    ]);
    expect(result.message).toBe(
      "通知设置已更新：免打扰已关闭；每小时最多推 3 条；摘要固定在 12:00、18:00 发。",
    );
    expect(f.wiring.settingsView()).toMatchObject({
      quietHours: { enabled: false, start: "22:00", end: "07:00" },
      maxPerHour: 3,
      maxP0PerHour: 12,
    });
    await update({ patch: { briefs: { evening: { enabled: true } } } }, OWNER_DM);
    expect(f.writes.at(-1)).toEqual({ briefs: { evening: { enabled: true } } });
    expect(f.wiring.settingsView().briefs?.evening).toEqual({ enabled: true, time: "18:30" });
  });

  test("refuses values the settings schema would drop", async () => {
    const f = fixture();
    const update = f.tools.hostActions.notificationSettingsMutation!;
    await expect(update({ patch: { maxPerHour: 99 } }, DESKTOP)).rejects.toThrow("invalid");
    expect(f.writes).toEqual([]);
  });

  test("a snooze holds non-decisions, survives a restart, expires and can be cancelled", async () => {
    const f = fixture();
    const update = f.tools.hostActions.notificationSettingsMutation!;
    const set = await update({ snooze: { minutes: 90 } }, OWNER_DM);
    expect(set.message).toBe(
      "通知设置已更新：静音到 15:30：这期间只推需要你决定的事，其余到时合成一条摘要。",
    );
    const until = NOW + 90 * 60_000;
    expect(f.writes.at(-1)).toEqual({ snoozeUntil: until });
    await expect(update({ snooze: { minutes: 24 * 60 + 1 } }, DESKTOP)).rejects.toThrow();
    await expect(update({ snooze: { until: NOW + 25 * HOUR } }, DESKTOP)).rejects.toThrow(
      "24 小时",
    );
    await expect(update({ snooze: { until: NOW - 1 } }, DESKTOP)).rejects.toThrow("24 小时");

    // A new process reads the same settings: still snoozed.
    const saved = f.settings.value;
    f.wiring.dispose();
    const g = fixture();
    g.settings.value = saved;
    await g.wiring.ready;
    const p1 = {
      priority: "P1" as const,
      ruleIds: [],
      facts: { title: "修登录" },
      attention: "always" as const,
      channel: "auto" as const,
      target: { kind: "owner" as const },
    };
    expect(
      await g.wiring.submitNotice({ ...p1, kind: "session.done", dedupeKey: "a", sessionId: SID }),
    ).toMatchObject({ outlet: "digest", reason: "snoozed" });
    expect(
      await g.wiring.submitNotice({
        ...p1,
        kind: "session.blocked",
        priority: "P0",
        dedupeKey: "b",
        sessionId: SID,
        requestId: "r1",
      }),
    ).not.toMatchObject({ reason: "snoozed" });
    clock = until;
    expect(
      await g.wiring.submitNotice({ ...p1, kind: "session.done", dedupeKey: "c", sessionId: SID }),
    ).not.toMatchObject({ reason: "snoozed" });

    clock = NOW;
    const cancelled = await g.tools.hostActions.notificationSettingsMutation!(
      { snooze: null },
      DESKTOP,
    );
    expect(cancelled.message).toBe("通知设置已更新：已取消静音。");
    expect(g.writes.at(-1)).toEqual({ snoozeUntil: null });
    expect(g.wiring.settingsView()).not.toHaveProperty("snoozeUntil");
  });
});

describe("recent proactive context", () => {
  async function seed(f: ReturnType<typeof fixture>) {
    await f.ledger.load();
    const brief = async (at: number, overrides: Partial<NoticeRecordInput>) => {
      clock = at;
      const record = await f.ledger.record(
        draft({
          kind: "brief.morning",
          sessionId: undefined,
          body: `brief at ${at}`,
          facts: {
            title: "晨报",
            refs: [{ ref: "r1", type: "done", status: "【完成】", title: "修登录" }],
            target: { kind: "owner" },
          },
          ...overrides,
        }),
      );
      // What the router does for an IM send the outbox delivered.
      if (record.decision?.outlet === "im") {
        await f.ledger.claim(record.id, "wechat", record.body ?? "");
        await f.ledger.settle(record.id, "accepted");
      }
    };
    const im = {
      decision: { outlet: "im" as const, im: "wechat", reason: "away-last-inbound" as const },
    };
    await brief(NOW - 13 * HOUR, im); // too old
    await brief(NOW - 5 * HOUR, { ...im, kind: "heartbeat" });
    await brief(NOW - 4 * HOUR, { kind: "brief.evening" }); // desktop only
    await brief(NOW - 3 * HOUR, im);
    await brief(NOW - 2 * HOUR, { ...im, kind: "session.done" }); // not proactive
    await brief(NOW - HOUR, { ...im, decision: { outlet: "digest", reason: "quiet-hours" } }); // held
    clock = NOW;
  }

  test("the desktop sees every brief and heartbeat sent to the owner in 12 hours, at most three", async () => {
    const f = fixture();
    await seed(f);
    const recent = await f.tools.recentProactive({ kind: "desktop" });
    expect(recent.map((notice) => notice.kind)).toEqual([
      "brief.morning",
      "brief.evening",
      "heartbeat",
    ]);
    expect(recent[0]).toEqual({
      kind: "brief.morning",
      sentAt: "2026-11-12T11:00:00+08:00",
      text: `brief at ${NOW - 3 * HOUR}`,
      refs: [{ type: "done", status: "【完成】", title: "修登录" }],
    });
  });

  test("an IM conversation sees only what reached its channel, and only as the owner's private chat", async () => {
    const f = fixture();
    await seed(f);
    const dm = await f.tools.recentProactive({
      kind: "im",
      channel: "wechat",
      target: "owner-dm",
      isDirectMessage: true,
    });
    expect(dm.map((notice) => notice.kind)).toEqual(["brief.morning", "heartbeat"]);
    expect(
      await f.tools.recentProactive({
        kind: "im",
        channel: "wechat",
        target: "team-room",
        isDirectMessage: false,
      }),
    ).toEqual([]);
    expect(
      await f.tools.recentProactive({
        kind: "im",
        channel: "lark",
        target: "owner-dm",
        isDirectMessage: true,
      }),
    ).toEqual([]);
  });

  test("each text is bounded", async () => {
    const f = fixture();
    await f.ledger.load();
    await f.ledger.record(
      draft({
        kind: "heartbeat",
        body: "长".repeat(2_000),
        facts: { title: "Mimi", target: { kind: "owner" } },
      }),
    );
    const [notice] = await f.tools.recentProactive({ kind: "desktop" });
    expect(notice!.text.length).toBe(600);
  });
});

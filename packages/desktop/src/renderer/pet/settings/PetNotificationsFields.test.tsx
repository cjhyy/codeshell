import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../../test-utils/renderHook";
import type {
  PetNoticesState,
  PetNoticeSystemRule,
  PetNoticeSystemRulePatch,
} from "../../../shared/pet-notices";
import type { NotificationSettingKey, PetNotificationsController } from "./PetNotificationsFields";

// Radix layout effects bind at import time: install the DOM before the card loads.
ensureMiniDom();
const { PetNotificationsFields, notificationsSettingsPatch, usePetNotificationsController } =
  await import("./PetNotificationsFields");

function noticesState(): PetNoticesState {
  return {
    channels: [
      { id: "wechat", label: "个人微信", ready: "ready" },
      { id: "lark", label: "飞书", ready: "unknown" },
      { id: "telegram", label: "Telegram", ready: "unavailable" },
    ],
    systemRule: { state: "paused", channel: "auto", events: ["done", "failed", "blocked"] },
    settings: {
      quietHours: { enabled: true, start: "22:30", end: "07:15" },
      maxPerHour: 8,
      maxP0PerHour: 12,
      mergeWindowSec: 600,
      presenceIdleSec: 120,
      delegatedFromDesktop: "desktop",
    },
  };
}

function fakeApi(state: PetNoticesState) {
  const systemCalls: PetNoticeSystemRulePatch[] = [];
  let fail = false;
  return {
    systemCalls,
    failNext: () => {
      fail = true;
    },
    api: {
      getNoticesState: async () => structuredClone(state),
      setSystemNoticeRule: async (patch: PetNoticeSystemRulePatch) => {
        systemCalls.push(patch);
        if (fail) {
          fail = false;
          throw new Error("rules.json is read-only");
        }
        const next: PetNoticeSystemRule = { ...state.systemRule, ...patch };
        state.systemRule = next;
        return next;
      },
      onNoticesChanged: () => () => undefined,
    },
  };
}

const ALL = new Set<NotificationSettingKey>([
  "quietHours",
  "maxPerHour",
  "maxP0PerHour",
  "mergeWindowSec",
  "presenceIdleSec",
  "delegatedFromDesktop",
]);

/** The proactive half of a draft, all at its defaults (these tests leave it untouched). */
const PROACTIVE = {
  morningEnabled: false,
  morningTime: "09:00",
  eveningEnabled: false,
  eveningTime: "18:30",
  heartbeatEnabled: false,
  heartbeatStart: "09:00",
  heartbeatEnd: "22:00",
  digestSlots: [] as string[],
};

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await flushMicrotasks();
  });
}

describe("PetNotificationsFields", () => {
  test("renders the loaded values, channel readiness and the WeChat note", async () => {
    const { api } = fakeApi(noticesState());
    const hook = await renderHook(() =>
      usePetNotificationsController({ api, write: async () => undefined }),
    );
    await settle();
    const html = renderToStaticMarkup(
      <PetNotificationsFields controller={hook.result.current as PetNotificationsController} />,
    );
    expect(html).toContain("免打扰时段");
    expect(html).toContain('value="22:30"');
    expect(html).toContain('value="07:15"');
    expect(html).toContain('value="8"');
    expect(html).toContain("每小时最多推送");
    expect(html).toContain("桌面派活结果");
    expect(html).toContain("只在桌面");
    expect(html).toContain("不在电脑前时所有会话完成/卡住都推我");
    expect(html).toContain('data-pet-notices-channel="wechat"');
    expect(html).toContain("个人微信");
    expect(html).toContain(">就绪<");
    expect(html).toContain(">待确认<");
    expect(html).toContain(">不可用<");
    expect(html).toContain("微信需要你先给 Mimi 发过消息");
    await hook.unmount();
  });

  test("edits are written to user settings under pet.notifications", async () => {
    const { api } = fakeApi(noticesState());
    const writes: Array<{ scope: string; patch: Record<string, unknown> }> = [];
    const hook = await renderHook(() =>
      usePetNotificationsController({
        api,
        write: async (scope, patch) => {
          writes.push({ scope, patch });
        },
      }),
    );
    await settle();
    act(() => {
      hook.result.current.update({ quietEnabled: false });
      hook.result.current.update({ maxPerHour: "12", delegatedFromDesktop: "auto" });
      hook.result.current.flush();
    });
    await settle();
    // Debounced: one write with the latest draft, holding only what was edited.
    // The untouched advanced limits keep following the host defaults.
    expect(writes).toEqual([
      {
        scope: "user",
        patch: {
          pet: {
            notifications: {
              delegatedFromDesktop: "auto",
              quietHours: { enabled: false, start: "22:30", end: "07:15" },
              maxPerHour: 12,
            },
          },
        },
      },
    ]);
    expect(hook.result.current.draft?.quietEnabled).toBe(false);
    // A later edit adds to what was touched; it never re-sends untouched defaults.
    act(() => {
      hook.result.current.update({ presenceIdleSec: "300" });
      hook.result.current.flush();
    });
    await settle();
    expect(writes[1]?.patch).toEqual({
      pet: {
        notifications: {
          delegatedFromDesktop: "auto",
          quietHours: { enabled: false, start: "22:30", end: "07:15" },
          maxPerHour: 12,
          presenceIdleSec: 300,
        },
      },
    });
    await hook.unmount();
  });

  test("a single edit writes only its own setting", async () => {
    const { api } = fakeApi(noticesState());
    const patches: Record<string, unknown>[] = [];
    const hook = await renderHook(() =>
      usePetNotificationsController({
        api,
        write: async (_scope, patch) => {
          patches.push(patch);
        },
      }),
    );
    await settle();
    act(() => {
      hook.result.current.update({ quietStart: "21:00" });
      hook.result.current.flush();
    });
    await settle();
    expect(patches).toEqual([
      {
        pet: {
          notifications: { quietHours: { enabled: true, start: "21:00", end: "07:15" } },
        },
      },
    ]);
    await hook.unmount();
  });

  test("an invalid count or half-typed time is not written", () => {
    expect(
      notificationsSettingsPatch(
        {
          ...PROACTIVE,
          quietEnabled: true,
          quietStart: "2",
          quietEnd: "07:00",
          maxPerHour: "0",
          maxP0PerHour: "",
          mergeWindowSec: "-1",
          presenceIdleSec: "29",
          delegatedFromDesktop: "auto",
        },
        ALL,
      ),
    ).toEqual({ pet: { notifications: { delegatedFromDesktop: "auto" } } });
    const notifications = notificationsSettingsPatch(
      {
        ...PROACTIVE,
        quietEnabled: true,
        quietStart: "23:00",
        quietEnd: "07:00",
        maxPerHour: "61",
        maxP0PerHour: "121",
        mergeWindowSec: "3601",
        presenceIdleSec: "1801",
        delegatedFromDesktop: "desktop",
      },
      ALL,
    ).pet as { notifications: Record<string, unknown> };
    expect(notifications.notifications).toEqual({
      delegatedFromDesktop: "desktop",
      quietHours: { enabled: true, start: "23:00", end: "07:00" },
    });
  });

  test("the advanced limits are written within the settings schema's bounds", () => {
    expect(
      notificationsSettingsPatch(
        {
          ...PROACTIVE,
          quietEnabled: false,
          quietStart: "23:00",
          quietEnd: "07:00",
          maxPerHour: "6",
          maxP0PerHour: "120",
          mergeWindowSec: "0",
          presenceIdleSec: "30",
          delegatedFromDesktop: "auto",
        },
        ALL,
      ),
    ).toEqual({
      pet: {
        notifications: {
          delegatedFromDesktop: "auto",
          quietHours: { enabled: false, start: "23:00", end: "07:00" },
          maxPerHour: 6,
          maxP0PerHour: 120,
          mergeWindowSec: 0,
          presenceIdleSec: 30,
        },
      },
    });
  });

  test("the advanced group starts collapsed and shows the loaded limits when opened", async () => {
    const { api } = fakeApi(noticesState());
    const hook = await renderHook(() =>
      usePetNotificationsController({ api, write: async () => undefined }),
    );
    await settle();
    const controller = hook.result.current as PetNotificationsController;
    expect(controller.draft).toMatchObject({
      maxP0PerHour: "12",
      mergeWindowSec: "600",
      presenceIdleSec: "120",
    });
    const collapsed = renderToStaticMarkup(<PetNotificationsFields controller={controller} />);
    expect(collapsed).toContain('data-pet-notices-advanced="collapsed"');
    expect(collapsed).not.toContain('id="pet-notices-max-p0-per-hour"');
    const open = renderToStaticMarkup(
      <PetNotificationsFields controller={controller} defaultAdvancedOpen />,
    );
    expect(open).toContain('data-pet-notices-advanced="open"');
    expect(open).toContain('id="pet-notices-max-p0-per-hour"');
    expect(open).toContain('value="600"');
    expect(open).toContain('value="120"');
    await hook.unmount();
  });

  test("the channel list offers a way to bind channels", async () => {
    const { api } = fakeApi(noticesState());
    const hook = await renderHook(() =>
      usePetNotificationsController({ api, write: async () => undefined }),
    );
    await settle();
    const html = renderToStaticMarkup(
      <PetNotificationsFields
        controller={hook.result.current as PetNotificationsController}
        onManageChannels={() => undefined}
      />,
    );
    expect(html).toContain("data-pet-notices-manage-channels");
    expect(html).toContain("管理消息连接");
    await hook.unmount();
  });

  test("the away switch toggles the system rule, and rolls back when it fails", async () => {
    const fake = fakeApi(noticesState());
    const hook = await renderHook(() =>
      usePetNotificationsController({ api: fake.api, write: async () => undefined }),
    );
    await settle();
    expect(hook.result.current.systemRuleOn).toBe(false);

    act(() => hook.result.current.setSystemRule(true));
    await settle();
    expect(fake.systemCalls).toEqual([{ state: "active" }]);
    expect(hook.result.current.systemRuleOn).toBe(true);

    fake.failNext();
    act(() => hook.result.current.setSystemRule(false));
    await settle();
    expect(fake.systemCalls).toEqual([{ state: "active" }, { state: "paused" }]);
    expect(hook.result.current.systemRuleOn).toBe(true);
    expect(hook.result.current.systemError).toBe("rules.json is read-only");
    await hook.unmount();
  });

  test("shows a retry when main cannot be reached", async () => {
    const hook = await renderHook(() =>
      usePetNotificationsController({
        api: {
          getNoticesState: async () => {
            throw new Error("worker restarting");
          },
        },
        write: async () => undefined,
      }),
    );
    await settle();
    const html = renderToStaticMarkup(
      <PetNotificationsFields controller={hook.result.current as PetNotificationsController} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("worker restarting");
    await hook.unmount();
  });

  test("an active snooze shows when it ends, and cancelling clears only the snooze", async () => {
    const state = noticesState();
    const until = new Date(Date.now() + 2 * 60 * 60_000);
    until.setSeconds(0, 0);
    state.settings.snoozeUntil = until.getTime();
    const { api } = fakeApi(state);
    const patches: Record<string, unknown>[] = [];
    const hook = await renderHook(() =>
      usePetNotificationsController({
        api,
        write: async (_scope, patch) => {
          patches.push(patch);
          delete state.settings.snoozeUntil;
        },
      }),
    );
    await settle();
    expect(hook.result.current.snoozeUntil).toBe(until.getTime());
    const html = renderToStaticMarkup(
      <PetNotificationsFields controller={hook.result.current as PetNotificationsController} />,
    );
    expect(html).toContain("data-pet-notices-snooze");
    const clock = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
    expect(html).toContain("静音到 ");
    expect(html).toContain(clock);
    expect(html).toContain("取消静音");
    await act(async () => {
      hook.result.current.cancelSnooze();
    });
    await settle();
    expect(patches).toEqual([{ pet: { notifications: { snoozeUntil: null } } }]);
    expect(hook.result.current.snoozeUntil).toBeUndefined();
    await hook.unmount();
  });

  test("an ended snooze is not shown", async () => {
    const state = noticesState();
    state.settings.snoozeUntil = Date.now() - 60_000;
    const { api } = fakeApi(state);
    const hook = await renderHook(() =>
      usePetNotificationsController({ api, write: async () => undefined }),
    );
    await settle();
    expect(hook.result.current.snoozeUntil).toBeUndefined();
    const html = renderToStaticMarkup(
      <PetNotificationsFields controller={hook.result.current as PetNotificationsController} />,
    );
    expect(html).not.toContain("data-pet-notices-snooze");
    await hook.unmount();
  });
});

import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import type {
  PetNoticesState,
  PetNoticeSystemRule,
  PetNoticeSystemRulePatch,
} from "../../shared/pet-notices";
import type { PetNotificationsController } from "./PetNotificationsCard";

// Radix layout effects bind at import time: install the DOM before the card loads.
ensureMiniDom();
const { PetNotificationsFields, notificationsSettingsPatch, usePetNotificationsController } =
  await import("./PetNotificationsCard");

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

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await flushMicrotasks();
  });
}

describe("PetNotificationsCard", () => {
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
    // Debounced: one write with the latest draft.
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
    await hook.unmount();
  });

  test("an invalid count or half-typed time is not written", () => {
    expect(
      notificationsSettingsPatch({
        quietEnabled: true,
        quietStart: "2",
        quietEnd: "07:00",
        maxPerHour: "0",
        delegatedFromDesktop: "auto",
      }),
    ).toEqual({ pet: { notifications: { delegatedFromDesktop: "auto" } } });
    expect(
      (
        notificationsSettingsPatch({
          quietEnabled: true,
          quietStart: "23:00",
          quietEnd: "07:00",
          maxPerHour: "61",
          delegatedFromDesktop: "desktop",
        }).pet as { notifications: Record<string, unknown> }
      ).notifications.maxPerHour,
    ).toBeUndefined();
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
});

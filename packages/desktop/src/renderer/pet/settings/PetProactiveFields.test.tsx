import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../../test-utils/renderHook";
import type { PetNoticesState } from "../../../shared/pet-notices";
import type { NotificationSettingKey, PetNotificationsDraft } from "./PetNotificationsFields";

// Radix layout effects bind at import time: install the DOM before the card loads.
ensureMiniDom();
const { createRoot } = await import("react-dom/client");
const { NotificationsSection } = await import("./NotificationsSection");
const { digestSlotsValid, notificationsSettingsPatch, notificationsDraft } =
  await import("./PetNotificationsFields");

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function find(node: any, attribute: string, value?: string): any[] {
  const own = node.getAttribute?.(attribute);
  return [
    ...(own !== null && own !== undefined && (value === undefined || own === value) ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child: any) => find(child, attribute, value)),
  ];
}

function text(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  const children = node.childNodes ?? [];
  return children.length > 0 ? children.map(text).join("") : (node.textContent ?? "");
}

function state(): PetNoticesState {
  return {
    channels: [],
    systemRule: { state: "paused", channel: "auto", events: ["done", "failed", "blocked"] },
    settings: {
      quietHours: { enabled: true, start: "23:00", end: "08:30" },
      maxPerHour: 6,
      maxP0PerHour: 12,
      mergeWindowSec: 600,
      presenceIdleSec: 120,
      delegatedFromDesktop: "auto",
      briefs: {
        morning: { enabled: false, time: "09:00" },
        evening: { enabled: true, time: "18:30" },
      },
      heartbeat: { enabled: true, activeHours: { start: "09:00", end: "22:00" } },
      digestSlots: ["12:00"],
    },
    proactive: {
      briefs: { morning: {}, evening: { lastSentDay: "2026-11-10" } },
      heartbeat: {
        judgedToday: 8,
        saidToday: 2,
        judgeCap: 8,
        sayCap: 4,
        atJudgeCap: true,
        atSayCap: false,
      },
    },
  };
}

describe("通知与主动 › 主动", () => {
  let root: Root | null = null;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
  });

  async function mount() {
    const writes: Record<string, unknown>[] = [];
    const container = document.createElement("div");
    root = createRoot(container);
    const api = {
      getNoticesState: async () => state(),
      setSystemNoticeRule: async () => state().systemRule,
      onNoticesChanged: () => () => undefined,
    };
    await act(async () => {
      root!.render(
        <NotificationsSection
          api={api}
          write={async (_scope, patch) => {
            writes.push(patch);
          }}
        />,
      );
      for (let index = 0; index < 5; index += 1) await flushMicrotasks();
    });
    return { container, writes };
  }

  async function run(work: () => void) {
    await act(async () => {
      work();
      for (let index = 0; index < 5; index += 1) await flushMicrotasks();
    });
  }

  const blur = (node: any) => reactPropsOf(node).onBlur?.();
  const type = (node: any, value: string) => reactPropsOf(node).onChange({ target: { value } });

  test("shows the briefs, the heartbeat with today's usage, and the digest slots", async () => {
    const { container } = await mount();
    const [card] = find(container, "data-pet-setting", "proactive");
    expect(text(card)).toContain("晨报");
    expect(text(card)).toContain("收工小结");
    expect(text(card)).toContain("心跳");
    expect(text(find(card, "data-pet-proactive-usage")[0])).toBe(
      "今天判断 8/8 次，发了 2/4 条 今天已到上限，明天再继续。",
    );
    // A brief that is off keeps its time but cannot be edited until switched on.
    const [morningTime] = find(card, "data-pet-proactive-input", "morning-time");
    expect(morningTime.getAttribute("value") ?? reactPropsOf(morningTime).value).toBe("09:00");
    expect(reactPropsOf(morningTime).disabled).toBe(true);
    expect(reactPropsOf(find(card, "data-pet-proactive-input", "evening-time")[0]).disabled).toBe(
      false,
    );
    expect(find(card, "data-pet-proactive-slot")).toHaveLength(1);
  });

  test("switching a brief on writes only its switch, not today's default time", async () => {
    const { container, writes } = await mount();
    const [field] = find(container, "data-pet-proactive-field", "morning");
    const [toggle] = find(field, "role", "switch");
    await run(() =>
      reactPropsOf(toggle).onClick({
        defaultPrevented: false,
        isPropagationStopped: () => false,
        stopPropagation: () => undefined,
      }),
    );
    await run(() => blur(find(field, "data-pet-proactive-input", "morning-time")[0]));
    expect(writes).toEqual([
      { pet: { notifications: { briefs: { morning: { enabled: true } } } } },
    ]);
  });

  test("the heartbeat window and the digest slots are written whole, after validation", async () => {
    const { container, writes } = await mount();
    const [start] = find(container, "data-pet-proactive-input", "heartbeat-start");
    await run(() => type(start, "1"));
    await run(() => blur(start));
    // Half-typed: nothing written, and the owner is told why.
    expect(writes).toEqual([]);
    expect(text(find(container, "data-pet-proactive-field", "heartbeat")[0])).toContain(
      "时间没填完整",
    );
    await run(() => type(start, "10:00"));
    await run(() => blur(start));
    expect(writes.at(-1)).toEqual({
      pet: { notifications: { heartbeat: { activeHours: { start: "10:00", end: "22:00" } } } },
    });

    await run(() => reactPropsOf(find(container, "data-pet-proactive-add-slot")[0]).onClick());
    expect(writes.at(-1)).toEqual({
      pet: {
        notifications: {
          heartbeat: { activeHours: { start: "10:00", end: "22:00" } },
          digestSlots: ["12:00", "18:00"],
        },
      },
    });
    await run(() =>
      reactPropsOf(find(container, "data-pet-proactive-remove-slot", "0")[0]).onClick(),
    );
    await run(() =>
      reactPropsOf(find(container, "data-pet-proactive-remove-slot", "0")[0]).onClick(),
    );
    // Empty: no fixed times.
    expect((writes.at(-1)!.pet as any).notifications.digestSlots).toEqual([]);
    expect(find(container, "data-pet-proactive-slots-empty")).toHaveLength(1);
  });

  test("the add button stops at six slots; a repeated slot is not saved", async () => {
    const { container, writes } = await mount();
    const add = () => find(container, "data-pet-proactive-add-slot")[0];
    for (let index = 0; index < 5; index += 1) await run(() => reactPropsOf(add()).onClick());
    expect(find(container, "data-pet-proactive-slot")).toHaveLength(6);
    expect(reactPropsOf(add()).disabled).toBe(true);
    const saved = writes.length;
    const [input] = find(container, "aria-label", "摘要时间 2");
    await run(() => type(input, "12:00"));
    await run(() => blur(input));
    expect(writes).toHaveLength(saved);
    expect(find(container, "data-pet-proactive-slots-invalid")).toHaveLength(1);
  });
});

describe("proactive settings patch", () => {
  const draft = (patch: Partial<PetNotificationsDraft> = {}): PetNotificationsDraft => ({
    ...notificationsDraft(state().settings),
    ...patch,
  });

  test("untouched proactive settings are never written", () => {
    expect(notificationsSettingsPatch(draft({ morningEnabled: true }), new Set())).toEqual({
      pet: { notifications: {} },
    });
  });

  test("each leaf the owner touched is written on its own", () => {
    const touched = new Set<NotificationSettingKey>([
      "briefs.evening.time",
      "heartbeat.enabled",
      "digestSlots",
    ]);
    expect(
      notificationsSettingsPatch(
        draft({ eveningTime: "19:15", heartbeatEnabled: false, digestSlots: ["20:00", "08:00"] }),
        touched,
      ),
    ).toEqual({
      pet: {
        notifications: {
          briefs: { evening: { time: "19:15" } },
          heartbeat: { enabled: false },
          digestSlots: ["08:00", "20:00"],
        },
      },
    });
  });

  test("validation mirrors main: HH:MM, distinct, at most six", () => {
    expect(digestSlotsValid([])).toBe(true);
    expect(digestSlotsValid(["09:00", "18:30"])).toBe(true);
    expect(digestSlotsValid(["9:00"])).toBe(false);
    expect(digestSlotsValid(["24:00"])).toBe(false);
    expect(digestSlotsValid(["09:00", "09:00"])).toBe(false);
    expect(digestSlotsValid(["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"])).toBe(
      false,
    );
    const all = new Set<NotificationSettingKey>(["briefs.morning.time", "heartbeat.activeHours"]);
    expect(
      notificationsSettingsPatch(draft({ morningTime: "", heartbeatEnd: "25:00" }), all),
    ).toEqual({ pet: { notifications: {} } });
  });
});

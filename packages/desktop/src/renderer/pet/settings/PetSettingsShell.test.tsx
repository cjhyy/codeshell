import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../../test-utils/renderHook";
import type { PetNoticesState } from "../../../shared/pet-notices";
import type { MimiSettingsSection } from "./mimiSettingsSections";

// Radix layout effects bind at import time: install the DOM before components load.
ensureMiniDom();
const { createRoot } = await import("react-dom/client");
const { PetSettingsShell } = await import("./PetSettingsShell");
const { PetSettingsPage } = await import("../PetSettingsPage");

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function find(node: unknown, attribute: string, value?: string): any[] {
  const current = node as {
    getAttribute?: (name: string) => string | null;
    childNodes?: unknown[];
  };
  const own = current.getAttribute?.(attribute);
  return [
    ...(own !== null && own !== undefined && (value === undefined || own === value)
      ? [current]
      : []),
    ...(current.childNodes ?? []).flatMap((child) => find(child, attribute, value)),
  ];
}

function textOf(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  return (node.textContent ?? "") + (node.childNodes ?? []).map(textOf).join("");
}

const noticesState: PetNoticesState = {
  channels: [{ id: "wechat", label: "个人微信", ready: "ready" }],
  systemRule: { state: "active", channel: "wechat", events: ["done", "blocked"] },
  settings: {
    quietHours: { enabled: true, start: "23:00", end: "08:30" },
    maxPerHour: 6,
    maxP0PerHour: 12,
    mergeWindowSec: 600,
    presenceIdleSec: 120,
    delegatedFromDesktop: "auto",
  },
};

describe("PetSettingsShell", () => {
  let root: Root | null = null;
  let container: any;
  let bridgeBefore: PropertyDescriptor | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    bridgeBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        pet: {
          getNoticesState: async () => structuredClone(noticesState),
          onNoticesChanged: () => () => undefined,
        },
        log: () => undefined,
      },
    });
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    if (bridgeBefore) Object.defineProperty(window, "codeshell", bridgeBefore);
    else Reflect.deleteProperty(window, "codeshell");
  });

  async function mountShell(section: MimiSettingsSection, calls: string[]) {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <PetSettingsShell
          section={section}
          onSectionChange={(next) => calls.push(`section:${next}`)}
          backLabel="返回 Mimi"
          onBack={() => calls.push("back")}
        >
          <p data-section-body={section}>body</p>
        </PetSettingsShell>,
      );
      await flushMicrotasks();
    });
  }

  test("a nav item opens its section and back leaves the page", async () => {
    const calls: string[] = [];
    await mountShell("appearance", calls);
    const [memory] = find(container, "data-pet-settings-nav-item", "memory");
    act(() => reactPropsOf(memory).onClick());
    const [back] = find(container, "data-pet-settings-back");
    act(() => reactPropsOf(back).onClick());
    expect(calls).toEqual(["section:memory", "back"]);
    expect(find(container, "data-section-body", "appearance")).toHaveLength(1);
  });

  test("arrow keys move through the sections and wrap around", async () => {
    await mountShell("appearance", []);
    const items = find(container, "data-pet-settings-nav-item");
    const press = (node: unknown, key: string) => {
      let prevented = false;
      act(() =>
        reactPropsOf(node).onKeyDown({
          key,
          preventDefault: () => {
            prevented = true;
          },
        }),
      );
      return prevented;
    };
    expect(press(items[0], "ArrowDown")).toBe(true);
    expect(document.activeElement).toBe(items[1]);
    press(items[0], "ArrowUp");
    expect(document.activeElement).toBe(items[5]);
    press(items[2], "End");
    expect(document.activeElement).toBe(items[5]);
    press(items[4], "Home");
    expect(document.activeElement).toBe(items[0]);
    expect(press(items[0], "a")).toBe(false);
  });

  test("通知与主动 jumps to 消息连接 and 规则与跟进 jumps to 通知与主动", async () => {
    const calls: string[] = [];
    const mountPage = async (section: MimiSettingsSection) => {
      await act(async () => root?.unmount());
      root = createRoot(container);
      await act(async () => {
        root!.render(
          <PetSettingsPage
            section={section}
            onSectionChange={(next) => calls.push(next)}
            backLabel="返回 Mimi"
            onBack={() => undefined}
            activeModelKey={null}
            modelOptions={[]}
            hasModelOverride={false}
            onSelectModel={() => undefined}
            onResetModel={() => undefined}
            widgetVisible={false}
            onWidgetVisibleChange={() => undefined}
            onOpenMemoryCenter={() => undefined}
          />,
        );
        for (let index = 0; index < 5; index += 1) await flushMicrotasks();
      });
    };
    await mountPage("notifications");
    const [manage] = find(container, "data-pet-notices-manage-channels");
    act(() => reactPropsOf(manage).onClick());
    await mountPage("rules");
    const [rule] = find(container, "data-pet-rule", "system");
    expect(rule.getAttribute("data-state")).toBe("active");
    expect(textOf(rule)).toContain("推到 个人微信");
    expect(textOf(rule)).toContain("提醒：完成、卡住");
    const [open] = find(container, "data-pet-rules-open-notifications");
    act(() => reactPropsOf(open).onClick());
    expect(calls).toEqual(["connections", "notifications"]);
  });
});

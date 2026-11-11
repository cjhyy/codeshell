import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import type { ViewMode } from "../view";
import { mimiSettingsBackLabel, useMimiSettingsNavigation } from "./useMimiSettingsNavigation";

describe("Mimi settings navigation", () => {
  let stored: Map<string, string>;
  let storageBefore: PropertyDescriptor | undefined;
  let view: ViewMode;
  let calls: string[];
  let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useMimiSettingsNavigation>>>>;

  const mount = async (initial: ViewMode) => {
    view = initial;
    hook = await renderHook(() =>
      useMimiSettingsNavigation({
        viewMode: view,
        setViewMode: (next) => {
          calls.push(`view:${next}`);
          view = next;
        },
        openPetPage: () => {
          calls.push("pet");
          view = "pet";
        },
        openSettingsModule: (module) => {
          calls.push(`settings:${module}`);
          view = "settings_page";
        },
      }),
    );
  };
  const step = async (action: () => void) => {
    await act(async () => action());
    await hook.rerender();
  };

  beforeEach(() => {
    ensureMiniDom();
    calls = [];
    stored = new Map();
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
  });
  afterEach(async () => {
    await hook?.unmount();
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  test("opens on the last section and returns to the Mimi page by default", async () => {
    stored.set("codeshell:mimi-settings:section", "memory");
    await mount("pet");
    expect(hook.result.current.mimiSettingsSection).toBe("memory");
    await step(() => hook.result.current.openMimiSettings());
    expect(view).toBe("pet_settings");
    expect(hook.result.current.mimiSettingsOrigin.view).toBe("pet");
    await step(() => hook.result.current.leaveMimiSettings());
    expect(calls).toEqual(["view:pet_settings", "pet"]);
  });

  test("a deep link selects its section and remembers it", async () => {
    await mount("credentials");
    await step(() => hook.result.current.openMimiSettings({ section: "connections" }));
    expect(hook.result.current.mimiSettingsSection).toBe("connections");
    expect(stored.get("codeshell:mimi-settings:section")).toBe("connections");
    await step(() => hook.result.current.leaveMimiSettings());
    expect(calls).toEqual(["view:pet_settings", "view:credentials"]);
  });

  test("returns to the settings center module it came from", async () => {
    await mount("settings_page");
    await step(() =>
      hook.result.current.openMimiSettings({
        section: "appearance",
        origin: { view: "settings_page", settingsModule: "computer-use" },
      }),
    );
    expect(hook.result.current.mimiSettingsOrigin).toEqual({
      view: "settings_page",
      settingsModule: "computer-use",
    });
    await step(() => hook.result.current.leaveMimiSettings());
    expect(calls).toEqual(["view:pet_settings", "settings:computer-use"]);
  });

  test("moving between sections or through the memory center keeps the origin", async () => {
    await mount("settings_page");
    await step(() =>
      hook.result.current.openMimiSettings({
        origin: { view: "settings_page", settingsModule: "mimi" },
      }),
    );
    // A jump inside the page ("去绑定") only changes the section.
    await step(() => hook.result.current.openMimiSettings({ section: "connections" }));
    await step(() => hook.result.current.selectMimiSettingsSection("memory"));
    // The memory center returns here; that round trip is not a new origin.
    await step(() => {
      view = "pet_memory";
    });
    await step(() => hook.result.current.openMimiSettings());
    expect(hook.result.current.mimiSettingsSection).toBe("memory");
    await step(() => hook.result.current.leaveMimiSettings());
    expect(calls.at(-1)).toBe("settings:mimi");
  });

  test("an unknown origin after a restart falls back to the Mimi page", async () => {
    await mount("pet_settings");
    await step(() => hook.result.current.leaveMimiSettings());
    expect(calls).toEqual(["pet"]);
  });

  test("the back button names where it returns", () => {
    expect(mimiSettingsBackLabel({ view: "pet" })).toBe("mimiSettings.back.pet");
    expect(mimiSettingsBackLabel({ view: "settings_page", settingsModule: "mimi" })).toBe(
      "mimiSettings.back.settings",
    );
    expect(mimiSettingsBackLabel({ view: "project_config" })).toBe("mimiSettings.back.settings");
    expect(mimiSettingsBackLabel({ view: "credentials" })).toBe("mimiSettings.back.credentials");
    expect(mimiSettingsBackLabel({ view: "automation" })).toBe("mimiSettings.back.other");
  });
});

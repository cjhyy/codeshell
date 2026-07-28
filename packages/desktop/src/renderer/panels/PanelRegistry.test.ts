import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import type { PanelTab } from "../view";
import {
  getEnabledPanelEntries,
  getPanelEntry,
  PANEL_REGISTRY,
  PanelRegistry,
  type PanelRenderContext,
} from "./PanelRegistry";
import {
  installQuickChatPanelApp,
  QUICK_CHAT_PANEL_APP_ID,
} from "./apps/quickChatPanelApp";
import { DESKTOP_BUILTIN_PANEL_APP_RUNTIME } from "./DesktopBuiltinPanelApp";

installQuickChatPanelApp();

const PANEL_KEYS: PanelTab[] = [
  "files",
  "browser",
  "review",
  "terminal",
  "shells",
  "ccRoom",
  "quickChat",
];

describe("PanelRegistry", () => {
  it("registers every built-in panel in display order", () => {
    expect([...PANEL_REGISTRY.keys()]).toEqual(PANEL_KEYS);

    for (const key of PANEL_KEYS) {
      const entry = getPanelEntry(key);
      expect(entry?.key).toBe(key);
      expect(entry?.title).toEqual({ kind: "i18n", key: `panels.kinds.${key}` });
      expect(entry?.icon).toBeDefined();
      expect(entry?.render).toBeFunction();
    }
  });

  it("keeps every existing panel enabled without an active session", () => {
    const entries = getEnabledPanelEntries({ cwd: null, engineSessionId: null });
    expect(entries.map((entry) => entry.key)).toEqual(PANEL_KEYS);
  });

  it("routes QuickChat through a registered built-in Panel App service", () => {
    const context: PanelRenderContext = {
      cwd: "/repo",
      engineSessionId: "session-1",
      tabId: "quickChat-7",
      bucket: "repo::session-1",
      busy: false,
      visible: true,
      foregroundVisible: true,
    };
    let received: unknown;

    const rendered = getPanelEntry("quickChat")!.render({
      ...context,
      builtinPanelAppHost: {
        getService: (appId) => ({
          ensure: () => undefined,
          release: () => undefined,
          render: (args: PanelRenderContext) => {
            received = { appId, bucket: args.bucket, tabId: args.tabId, cwd: args.cwd };
            return "quick-chat-body";
          },
        }),
      },
    });

    expect(rendered).toBe("quick-chat-body");
    expect(received).toEqual({
      appId: QUICK_CHAT_PANEL_APP_ID,
      bucket: "repo::session-1",
      tabId: "quickChat-7",
      cwd: "/repo",
    });
    expect(getPanelEntry("quickChat")?.owner).toEqual({
      kind: "builtin-panel-app",
      appId: QUICK_CHAT_PANEL_APP_ID,
      panelId: "quick-chat",
    });
  });

  it("lets the QuickChat code module own panel mount and unmount work", async () => {
    const calls: string[] = [];
    const context = {
      panelId: "quick-chat",
      tabId: "quickChat-lifecycle",
      bucket: "repo::session-1",
      cwd: "/repo",
      engineSessionId: "session-1",
      busy: false,
    };
    const host = {
      getService: () => ({
        ensure: () => calls.push("ensure"),
        release: () => calls.push("release"),
        render: () => null,
      }),
    };

    await DESKTOP_BUILTIN_PANEL_APP_RUNTIME.mountPanel(
      QUICK_CHAT_PANEL_APP_ID,
      { panelId: "quick-chat", instanceId: "lifecycle-instance", context, visible: true },
      host,
    );
    await DESKTOP_BUILTIN_PANEL_APP_RUNTIME.unmountPanel(
      QUICK_CHAT_PANEL_APP_ID,
      "lifecycle-instance",
      host,
    );
    await DESKTOP_BUILTIN_PANEL_APP_RUNTIME.deactivate(QUICK_CHAT_PANEL_APP_ID, host);

    expect(calls).toEqual(["ensure", "release"]);
  });

  it("does not mark a lifecycle-live hidden CC Room as active", () => {
    const rendered = getPanelEntry("ccRoom")!.render({
      cwd: "/repo",
      engineSessionId: "session-1",
      tabId: "ccRoom-1",
      bucket: "repo::session-1",
      busy: false,
      visible: true,
      foregroundVisible: false,
    }) as ReactElement<{ active: boolean }>;

    expect(rendered.props.active).toBe(false);
  });

  it("supports dynamic registration, duplicate rejection, and idempotent disposal", () => {
    const registry = new PanelRegistry();
    const entry = {
      key: "panel-app:demo:dashboard",
      owner: { kind: "panel-app" as const, appId: "demo" },
      title: { kind: "literal" as const, value: "Dashboard" },
      icon: getPanelEntry("files")!.icon,
      order: 1_000,
      singleton: true,
      enabled: () => true,
      render: () => null,
    };
    const dispose = registry.register(entry);
    expect(registry.get(entry.key)).toBe(entry);
    expect(() => registry.register(entry)).toThrow(/duplicate panel id/);
    dispose();
    dispose();
    expect(registry.get(entry.key)).toBeUndefined();
  });

  it("returns undefined for a stale persisted panel kind", () => {
    expect(getPanelEntry("panel-app:removed:old-panel")).toBeUndefined();
  });
});

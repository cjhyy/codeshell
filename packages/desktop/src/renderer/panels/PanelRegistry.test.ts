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
import { installQuickChatPanelApp, QUICK_CHAT_PANEL_APP_ID } from "./apps/quickChatPanelApp";
import { DESKTOP_BUILTIN_PANEL_APP_RUNTIME } from "./DesktopBuiltinPanelApp";
import { browserPartitionForBucket } from "../../shared/browser-profile";

installQuickChatPanelApp();

const PANEL_KEYS: PanelTab[] = [
  "files",
  "browser",
  "review",
  "terminal",
  "shells",
  "subagent",
  "ccRoom",
  "quickChat",
];

function renderBrowser(context: Partial<PanelRenderContext> & { bucket: string }) {
  return getPanelEntry("browser")!.render({
    projectPath: "/repo",
    cwd: "/repo",
    engineSessionId: "session-1",
    tabId: "browser-1",
    busy: false,
    visible: true,
    foregroundVisible: true,
    ...context,
  }) as ReactElement<{ bucket: string; partition: string; engineSessionId: string | null }>;
}

describe("PanelRegistry", () => {
  function browserPartition(bucket: string): string {
    const rendered = getPanelEntry("browser")!.render({
      projectPath: "/repo",
      cwd: "/repo",
      engineSessionId: bucket.split("::")[1] ?? null,
      tabId: "browser-1",
      bucket,
      busy: false,
      visible: true,
      foregroundVisible: true,
      modelKey: null,
      permissionMode: "default",
      planMode: false,
      hasGoal: false,
    }) as ReactElement<{ partition: string }>;
    return rendered.props.partition;
  }

  it("mounts the visible browser in the same project profile as tools and cookie injection", () => {
    const first = browserPartition("project-1::session-a");
    const second = browserPartition("project-1::session-b");
    const otherProject = browserPartition("project-2::session-a");

    expect(first).toBe(browserPartitionForBucket("project-1::session-a"));
    expect(first).toBe("persist:browser:p:project-1");
    expect(second).toBe(first);
    expect(otherProject).toBe("persist:browser:p:project-2");
    expect(otherProject).not.toBe(first);
  });

  it("keeps each Quick Chat browser temporary and isolated", () => {
    const first = browserPartition("__quick_chat__::qchat-a");
    const second = browserPartition("__quick_chat__::qchat-b");

    expect(first).toBe(browserPartitionForBucket("__quick_chat__::qchat-a"));
    expect(first).toStartWith("browser:qchat:");
    expect(first).not.toStartWith("persist:");
    expect(second).not.toBe(first);
    expect(second).not.toStartWith("persist:");
  });

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

  it("mounts session browser tabs in the project's shared login profile", () => {
    for (const sessionId of ["session-1", "session-2"]) {
      const bucket = `project-a::${sessionId}`;
      const rendered = renderBrowser({ bucket, engineSessionId: sessionId });
      expect(rendered.props).toMatchObject({
        bucket,
        engineSessionId: sessionId,
        partition: "persist:browser:p:project-a",
      });
    }
    expect(renderBrowser({ bucket: "project-b::session-1" }).props.partition).toBe(
      "persist:browser:p:project-b",
    );
    expect(
      renderBrowser({ bucket: "project-a::session-1", cwd: "/repo/.worktrees/feature" }).props
        .partition,
    ).toBe("persist:browser:p:project-a");
  });

  it("keeps default and sanitized browser profiles on the shared partition contract", () => {
    for (const [bucket, partition] of [
      ["__no_repo__::_none_", "persist:browser:p:__no_repo__"],
      ["__no_repo__::session-1", "persist:browser:p:__no_repo__"],
      ["project /one::session-1", "persist:browser:p:project__one"],
    ]) {
      expect(renderBrowser({ bucket, engineSessionId: null }).props).toMatchObject({
        bucket,
        engineSessionId: null,
        partition,
      });
    }
  });

  it("keeps Quick Chat browser logins temporary and separate per session", () => {
    for (const sessionId of ["qchat-1", "qchat-2"]) {
      const bucket = `__quick_chat__::${sessionId}`;
      expect(renderBrowser({ bucket, engineSessionId: sessionId }).props).toMatchObject({
        bucket,
        engineSessionId: sessionId,
        partition: `browser:qchat:q:__quick_chat__::${sessionId}`,
      });
    }
  });

  it("omits Git review until the workspace confirms a repository", () => {
    const entries = getEnabledPanelEntries({
      projectPath: null,
      cwd: null,
      engineSessionId: null,
    });
    expect(entries.map((entry) => entry.key)).toEqual(PANEL_KEYS.filter((key) => key !== "review"));
    expect(
      getEnabledPanelEntries({
        projectPath: "/repo",
        cwd: "/repo",
        engineSessionId: "session-1",
        gitReviewAvailable: false,
      }).some((entry) => entry.key === "review"),
    ).toBe(false);
    expect(
      getEnabledPanelEntries({
        projectPath: "/repo",
        cwd: "/repo",
        engineSessionId: "session-1",
        gitReviewAvailable: true,
      }).some((entry) => entry.key === "review"),
    ).toBe(true);
  });

  it("keeps the chat-owned subagent kind registered and enabled for internal navigation", () => {
    const context = { projectPath: "/repo", cwd: "/repo", engineSessionId: "parent-session" };
    const entry = getPanelEntry("subagent", context);
    expect(entry?.internalOnly).toBe(true);
    expect(entry?.enabled(context)).toBe(true);
    expect(entry?.render).toBeFunction();
    expect(getEnabledPanelEntries(context).some((panel) => panel.key === "subagent")).toBe(true);
    expect(getPanelEntry("files")?.internalOnly).not.toBe(true);
  });

  it("routes QuickChat through a registered built-in Panel App service", () => {
    const context: PanelRenderContext = {
      projectPath: "/repo",
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

  it("pauses background-work reads for a kept-mounted hidden panel", () => {
    const rendered = getPanelEntry("shells")!.render({
      cwd: "/repo",
      engineSessionId: "session-1",
      tabId: "shells-1",
      bucket: "repo::session-1",
      busy: false,
      visible: true,
      foregroundVisible: false,
    }) as ReactElement<{ sessionId: string; active: boolean }>;

    expect(rendered.props).toMatchObject({ sessionId: "session-1", active: false });
  });

  it("routes the active Session identity into the Review panel", () => {
    const rendered = getPanelEntry("review")!.render({
      projectPath: "/repo",
      cwd: "/repo/.worktrees/feature",
      engineSessionId: "session-review",
      sessionMainRootId: "main-root",
      tabId: "review-1",
      bucket: "project::session-review",
      busy: false,
      visible: true,
      foregroundVisible: true,
    }) as ReactElement<{ cwd: string; sessionId: string }>;

    expect(rendered.props).toMatchObject({
      cwd: "/repo/.worktrees/feature",
      sessionId: "session-review",
    });
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

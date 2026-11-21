import { afterEach, describe, expect, spyOn, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../src/test-utils/renderHook.js";
import { initialChatState } from "../src/lib/streamReducer.js";
import type { RemoteApp } from "../src/hooks/useRemoteApp.js";
import { useDesktopController } from "./DesktopApp.js";
import { getApiWorkspace } from "./api-context.js";
import { Workbench } from "./Workbench.js";
import { SubagentView } from "./SubagentView.js";
import {
  DesktopApproval,
  DesktopChatControls,
  DesktopSidebar,
  DesktopTakeOver,
  cliModeSwitchNotice,
} from "./DesktopControls.js";
import { OutputHistoryRecovery } from "../src/components/OutputHistoryRecovery.js";
import { DesktopModelPicker, CURRENT_NATIVE_MODEL } from "./DesktopModelPicker.js";
import { DesktopCliModelPicker } from "./DesktopCliModelPicker.js";
import { cliSessionControlBlock } from "./cliSessionControls.js";
import { HubPanels } from "./HubPanels.js";
import { PanelHost } from "./PanelHost.js";
import { SessionLoadingState } from "./SessionLoadingState.js";
import { ProjectSessionNavigation } from "./ProjectSessionNavigation.js";
import type { SessionSummary } from "./protocol.js";

const noop = () => {};
const session = { id: "paired-session", username: "synthetic", deviceName: "Fixture" };
function remoteApp(patch: Partial<RemoteApp> = {}): RemoteApp {
  return {
    status: "online",
    conversationRevision: 0,
    deviceName: "Fixture",
    chat: initialChatState(),
    sessions: [],
    unreadSessionIds: new Set(),
    projects: [],
    approvals: [],
    permissionMode: "default",
    loading: {
      sessions: false,
      sessionHistory: false,
      rooms: false,
      projects: false,
      roomHistory: false,
      ccSessions: false,
    },
    logout: noop,
    reconnectNow: noop,
    sendChat: async () => true,
    stopRun: noop,
    selectSession: noop,
    newSession: noop,
    refreshSessions: noop,
    respondApproval: noop,
    setPermissionMode: noop,
    extendGoal: noop,
    clearGoal: noop,
    leaveRoom: noop,
    activeProjectCwd: null,
    activeProjectId: null,
    selectProject: noop,
    ccSessions: [],
    ccProbe: null,
    ccCliKind: "claude-code",
    setCcCliKind: noop,
    openCcSession: noop,
    respondCcApproval: noop,
    ...patch,
  };
}
function workbenchElements(node: React.ReactNode): React.ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(workbenchElements);
  if (!React.isValidElement(node)) return [];
  const element = node as React.ReactElement<any>;
  return [element, ...workbenchElements(element.props.children)];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function connectionClock() {
  let now = 0;
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; run: () => void }>();
  const setting = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback,
    delay,
    ...args
  ) => {
    if (typeof callback !== "function" || (delay !== 2500 && delay !== 8000))
      return originalSet(callback, delay, ...args);
    const handle = originalSet(() => {}, 60_000);
    timers.set(handle, { at: now + delay, run: () => callback(...args) });
    return handle;
  }) as typeof setTimeout);
  const clearing = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    timers.delete(handle as ReturnType<typeof setTimeout>);
    originalClear(handle);
  });
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(handle);
        originalClear(handle);
        timer.run();
      }
    },
    restore() {
      for (const handle of timers.keys()) originalClear(handle);
      setting.mockRestore();
      clearing.mockRestore();
    },
  };
}
function configuration(path: string) {
  return {
    workspace: { path, settingsScope: "local", skillDirectories: [] },
    defaults: {},
    connections: [],
    catalog: [],
    skills: [],
    mcpServers: [],
    restartRequired: false,
  };
}
const originalFetch = globalThis.fetch;
const browserRestores: Array<() => void> = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const restore of browserRestores.splice(0).reverse()) restore();
});

describe("Desktop workbench controller", () => {
  test("offers 立即重连 only while the relay socket is offline", async () => {
    let reconnects = 0;
    let app = remoteApp({ status: "online", reconnectNow: () => reconnects++ });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    try {
      expect(hook.result.current.retryConnection).toBeUndefined();
      app = { ...app, status: "offline" };
      await hook.rerender();
      expect(hook.result.current.connection).toBe("closed");
      hook.result.current.retryConnection?.();
      expect(reconnects).toBe(1);
      for (const status of ["connecting", "unpaired"] as const) {
        app = { ...app, status };
        await hook.rerender();
        expect(hook.result.current.retryConnection).toBeUndefined();
      }
      app = { ...app, status: "offline", accessRequired: true };
      await hook.rerender();
      expect(hook.result.current.retryConnection).toBeUndefined();
    } finally {
      await hook.unmount();
    }
  });

  for (const connectedBefore of [false, true])
    test(`connection grace covers consecutive retries and keeps the conversation (connected before: ${connectedBefore})`, async () => {
      const clock = connectionClock();
      let sends = 0;
      let app = remoteApp({
        status: connectedBefore ? "online" : "connecting",
        activeSessionId: "original-session",
        chat: {
          ...initialChatState(),
          items: [{ kind: "user", id: "original-message", text: "Previous conversation" }],
        },
        sessions: [{ id: "original-session", title: "Original chat", updatedAt: 1, cwd: null }],
        sendChat: async () => {
          sends++;
          return true;
        },
      });
      const hook = await renderHook(() => useDesktopController(app, undefined, noop));
      try {
        await act(async () => {
          hook.result.current.setDraft("unsent task");
          hook.result.current.addFiles([
            new File(["owned image"], "kept.png", { type: "image/png" }),
          ] as unknown as FileList);
        });
        if (connectedBefore) {
          app = { ...app, status: "offline" };
          await hook.rerender();
        }
        expect(hook.result.current.connection).toBe(connectedBefore ? "closed" : "connecting");
        expect(hook.result.current.connectionMessage).toBe(
          connectedBefore ? "正在恢复与电脑的连接…" : "正在连接电脑…",
        );
        await act(async () => clock.advance((connectedBefore ? 2500 : 8000) - 1000));
        app = { ...app, status: "authenticating" };
        await hook.rerender();
        await act(async () => clock.advance(999));
        expect(hook.result.current.connectionMessage).not.toContain("暂时无法");
        app = { ...app, status: "offline" };
        await hook.rerender();
        await act(async () => clock.advance(1));
        expect(hook.result.current.connectionMessage).toContain("暂时无法连接电脑");
        app = { ...app, status: "connecting" };
        await hook.rerender();
        expect(hook.result.current.connectionMessage).toContain("暂时无法连接电脑");
        expect(hook.result.current.send()).toBe(false);
        expect(hook.result.current.activeId).toBe("original-session");
        expect(hook.result.current.chat).toBe(app.chat);
        expect(hook.result.current.navigationSessions.map((item) => item.sessionId)).toEqual([
          "original-session",
        ]);
        expect(hook.result.current.draft).toBe("unsent task");
        expect(hook.result.current.files.map((file) => file.name)).toEqual(["kept.png"]);
        expect(sends).toBe(0);
        app = { ...app, status: "online" };
        await hook.rerender();
        expect(hook.result.current.connection).toBe("open");
        expect(hook.result.current.connectionMessage).toBeUndefined();
        expect(clock.timers.size).toBe(0);
        app = { ...app, status: "offline" };
        await hook.rerender();
        expect(hook.result.current.connectionMessage).toBe("正在恢复与电脑的连接…");
        await act(async () => clock.advance(2499));
        expect(hook.result.current.connectionMessage).not.toContain("暂时无法");
        await act(async () => clock.advance(1));
        expect(hook.result.current.connectionMessage).toContain("暂时无法连接电脑");
        app = { ...app, status: "online" };
        await hook.rerender();
        app = { ...app, status: "offline" };
        await hook.rerender();
        expect(clock.timers.size).toBe(1);
      } finally {
        await hook.unmount();
        const remaining = clock.timers.size;
        clock.restore();
        expect(remaining).toBe(0);
      }
    });

  for (const authorization of ["expired", "unpaired"] as const)
    test(`connection grace never replaces an immediate ${authorization} authorization state`, async () => {
      const clock = connectionClock();
      let app = remoteApp();
      const hook = await renderHook(() => useDesktopController(app, undefined, noop));
      try {
        app = { ...app, status: "offline" };
        await hook.rerender();
        expect(hook.result.current.connectionMessage).toBe("正在恢复与电脑的连接…");
        app = {
          ...app,
          status: authorization === "unpaired" ? "unpaired" : "offline",
          accessRequired: authorization === "expired",
        };
        await hook.rerender();
        expect(hook.result.current.connectionMessage).toBeUndefined();
        expect(hook.result.current.connection).toBe("closed");
        expect(hook.result.current.send()).toBe(false);
        expect(clock.timers.size).toBe(0);
        await act(async () => clock.advance(10_000));
        app = { ...app, status: "connecting", accessRequired: false };
        await hook.rerender();
        expect(hook.result.current.connectionMessage).toBe("正在恢复与电脑的连接…");
        await act(async () => clock.advance(2499));
        expect(hook.result.current.connectionMessage).not.toContain("暂时无法");
        await act(async () => clock.advance(1));
        expect(hook.result.current.connectionMessage).toContain("暂时无法连接电脑");
      } finally {
        await hook.unmount();
        clock.restore();
      }
    });

  test("an explicitly unbound session never inherits the previous project's execution context", async () => {
    const created: unknown[] = [];
    const sent: string[] = [];
    let app = remoteApp({
      activeCwd: null,
      activeProjectCwd: "/previous",
      activeProjectId: "previous",
      activeSessionId: "unbound",
      sessions: [
        { id: "unbound", cwd: null, title: "Unbound", updatedAt: 1 },
        { id: "project", cwd: "/previous", title: "Project", updatedAt: 2 },
      ] as RemoteApp["sessions"],
      newSession: (target) => created.push(target),
      sendChat: async ({ text }) => {
        sent.push(text);
        return true;
      },
    });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    try {
      expect(hook.result.current.workspaceCwd).toBeNull();
      expect(hook.result.current.workspaceName).toBe("无项目");
      expect(getApiWorkspace()).toBeUndefined();
      expect(hook.result.current.sessions.map((item) => item.sessionId)).toEqual(["unbound"]);
      const directory = hook.result.current.navigationSessions;
      expect(directory).toHaveLength(2);
      app = { ...app, chat: { ...app.chat, seq: app.chat.seq + 1 } };
      await hook.rerender();
      expect(hook.result.current.navigationSessions).toBe(directory);
      await act(async () => hook.result.current.setDraft("Unbound task"));
      await act(async () => {
        expect(hook.result.current.send()).toBe(true);
        await flushMicrotasks();
      });
      expect(sent).toEqual(["Unbound task"]);
      await act(async () => hook.result.current.newSession());
      expect(created).toEqual([{ projectId: null }]);
    } finally {
      await hook.unmount();
    }
  });

  test("explicit Panel selection waits for history and preserves each conversation's draft", async () => {
    const selections: string[] = [];
    let app = remoteApp({
      activeCwd: "/owned/A",
      activeSessionId: "native-a",
      sessions: ["native-a", "native-b"].map((id) => ({
        id,
        title: id,
        cwd: "/owned/A",
        updatedAt: 1,
      })),
      selectSession: (id) => selections.push(id),
    });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    try {
      await act(async () => hook.result.current.setDraft("Draft in A"));
      let result: string | undefined;
      let selection!: Promise<string>;
      await act(async () => {
        selection = hook.result.current.selectPanelSession!("native-b");
        void selection.then((id) => {
          result = id;
        });
      });
      expect(selections).toEqual(["native-b"]);
      expect(result).toBeUndefined();
      app = {
        ...app,
        activeSessionId: "native-b",
        loading: { ...app.loading, sessionHistory: true },
      };
      await hook.rerender();
      expect(result).toBeUndefined();
      app = { ...app, loading: { ...app.loading, sessionHistory: false } };
      await hook.rerender();
      expect(await selection).toBe("native-b");
      expect(hook.result.current.draft).toBe("");
      await act(async () => hook.result.current.setDraft("Draft in B"));
      await act(async () => {
        hook.result.current.selectSession("native-a");
      });
      app = { ...app, activeSessionId: "native-a" };
      await hook.rerender();
      expect(hook.result.current.draft).toBe("Draft in A");
      await act(async () => {
        hook.result.current.selectSession("native-b");
      });
      app = { ...app, activeSessionId: "native-b" };
      await hook.rerender();
      expect(hook.result.current.draft).toBe("Draft in B");
    } finally {
      await hook.unmount();
    }
  });

  test.each(["history", "disconnect", "navigation"])(
    "explicit Panel selection rejects %s instead of resolving the old session",
    async (failure) => {
      let app = remoteApp({
        activeCwd: "/owned/A",
        activeSessionId: "native-a",
        sessions: ["native-a", "native-b"].map((id) => ({
          id,
          title: id,
          cwd: "/owned/A",
          updatedAt: 1,
        })),
      });
      const hook = await renderHook(() => useDesktopController(app, undefined, noop));
      try {
        let selection!: Promise<string | Error>;
        await act(async () => {
          selection = hook.result.current.selectPanelSession!("native-b").catch((error) => error);
        });
        if (failure === "navigation") {
          await act(async () => {
            hook.result.current.selectSession("native-a");
          });
        } else {
          app =
            failure === "disconnect"
              ? { ...app, status: "offline" }
              : { ...app, activeSessionId: "native-b", outputHistoryFailed: true };
        }
        await hook.rerender();
        expect(await selection).toBeInstanceOf(Error);
      } finally {
        await hook.unmount();
      }
    },
  );

  test("Panel association refuses unknown and cross-root sessions without navigating", async () => {
    const selections: string[] = [];
    const app = remoteApp({
      activeCwd: "/owned/A",
      activeSessionId: "native-a",
      projects: [
        {
          id: "project-a",
          name: "A",
          path: "/owned/A",
          roots: [
            { id: "a", name: "A", path: "/owned/A" },
            { id: "b", name: "B", path: "/owned/B" },
          ],
        },
      ],
      sessions: [{ id: "native-b", title: "B", cwd: "/owned/B", updatedAt: 1 }],
      selectSession: (id) => selections.push(id),
    });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    try {
      await expect(hook.result.current.selectPanelSession!("unknown-id")).rejects.toThrow(
        "当前项目",
      );
      await expect(hook.result.current.selectPanelSession!("native-b")).rejects.toThrow(
        "另一个项目目录",
      );
      expect(selections).toEqual([]);
    } finally {
      await hook.unmount();
    }
  });

  test.each(["accepted", "rejected"])(
    "Panel creation returns only its new Host ID (%s)",
    async (outcome) => {
      const creates: unknown[] = [];
      let app = remoteApp({
        activeCwd: "/owned/A",
        activeProjectCwd: "/owned/A",
        activeSessionId: "native-a",
        projects: [{ id: "project-a", name: "A", path: "/owned/A" }],
        newSession: (target) => creates.push(target),
      });
      const hook = await renderHook(() => useDesktopController(app, undefined, noop));
      try {
        let value: string | Error | undefined;
        let creation!: Promise<string | Error>;
        await act(async () => {
          hook.result.current.setDraft("Keep old draft");
          creation = hook.result.current.newPanelSession!().catch((error) => error);
          void creation.then((result) => {
            value = result;
          });
        });
        expect(creates).toEqual([{ projectId: "project-a" }]);
        expect(value).toBeUndefined();
        expect(hook.result.current.panelSessionId).toBeUndefined();
        app =
          outcome === "accepted"
            ? { ...app, activeSessionId: "native-created" }
            : { ...app, sessionCreationFailures: 1 };
        await hook.rerender();
        if (outcome === "accepted") {
          expect(await creation).toBe("native-created");
          expect(hook.result.current.draft).toBe("");
        } else {
          expect(await creation).toBeInstanceOf(Error);
          expect(hook.result.current.panelSessionId).toBeUndefined();
          expect(hook.result.current.draft).toBe("Keep old draft");
        }
      } finally {
        await hook.unmount();
      }
    },
  );

  test("Panel project selection reuses Desktop navigation and never borrows the old session during creation", async () => {
    const projects = [
      { id: "project-a", name: "Project A", path: "/owned/A" },
      { id: "project-b", name: "Project B", path: "/owned/B" },
    ];
    const selections: string[] = [],
      creates: unknown[] = [],
      sends: unknown[] = [];
    let app = remoteApp({
      projects,
      activeProjectId: "project-a",
      activeProjectCwd: "/owned/A",
      activeCwd: "/owned/A",
      activeSessionId: "native-a",
      selectProject: (id) => selections.push(id),
      newSession: (target) => creates.push(target),
      sendChat: async (input) => {
        sends.push(input);
        return true;
      },
    });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    try {
      expect(hook.result.current.projects).toEqual(projects);
      expect(hook.result.current.selectedProjectId).toBe("project-a");
      expect(hook.result.current.panelSessionId).toBe("native-a");
      await act(async () => hook.result.current.selectProject!("project-b"));
      expect(selections).toEqual(["project-b"]);
      expect(creates).toEqual([{ projectId: "project-b" }]);
      expect(hook.result.current.workspaceCwd).toBe("/owned/B");
      expect(hook.result.current.selectedProjectId).toBe("project-b");
      expect(hook.result.current.panelSessionId).toBeUndefined();
      const sidebar = hook.result.current.renderSidebar!({
        guard: (action) => action(),
        conversation: (action) => action(),
      }) as React.ReactElement<any>;
      expect(sidebar.props.app.activeProjectId).toBe("project-b");
      app = { ...app, sessionCreationFailures: 1 };
      await hook.rerender();
      expect(hook.result.current.panelSessionId).toBeUndefined();
      expect(hook.result.current.send()).toBe(false);
      await act(async () => hook.result.current.newSession());
      app = { ...app, activeSessionId: "native-b", activeCwd: "/owned/B" };
      await hook.rerender();
      expect(hook.result.current.panelSessionId).toBe("native-b");
      expect(sends).toEqual([]);
    } finally {
      await hook.unmount();
    }
  });

  test.each(["canonical", "room ready", "room pending", "new draft"])(
    "Panels bind only the canonical session (%s)",
    async (selection) => {
      ensureMiniDom();
      let location = new URL("http://localhost/mobile/");
      const history = {
        state: null as unknown,
        replaceState(state: unknown, _unused: string, url: string) {
          this.state = state;
          location = new URL(url, location);
        },
        pushState(state: unknown, _unused: string, url: string) {
          this.replaceState(state, _unused, url);
        },
      };
      for (const [key, descriptor] of [
        ["location", { get: () => location }],
        ["history", { value: history }],
        [
          "matchMedia",
          { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
        ],
      ] as const) {
        const previous = Object.getOwnPropertyDescriptor(window, key);
        Object.defineProperty(window, key, { configurable: true, ...descriptor });
        browserRestores.push(() =>
          previous ? Object.defineProperty(window, key, previous) : delete (window as any)[key],
        );
      }
      const sent: unknown[] = [];
      const room = {
        id: "cli-room",
        name: "Synthetic CLI",
        cwd: "/owned",
        kind: "claude-code" as const,
        createdAt: 1,
        lastActiveAt: 1,
        open: true,
        observing: false,
      };
      const app = remoteApp({
        activeSessionId: selection === "new draft" ? undefined : "native-previous",
        activeRoomId: selection.startsWith("room") ? room.id : undefined,
        activeRoom: selection === "room ready" ? room : undefined,
        sendChat: async (input) => {
          sent.push(input);
          return true;
        },
      });
      const hook = await renderHook(() => {
        const controller = useDesktopController(app, undefined, noop);
        return {
          controller,
          tree: Workbench({ controller: { ...controller, workspaceApi: true } }),
        };
      });
      try {
        const canonical = selection === "canonical" ? "native-previous" : undefined;
        expect(hook.result.current.controller.panelSessionId).toBe(canonical);
        const activeId = hook.result.current.controller.activeId;
        await act(async () => {
          const nav = workbenchElements(hook.result.current.tree).find(
            (element) =>
              element.type === "button" &&
              workbenchElements(element.props.children).some(
                (child) => child.type === "span" && child.props.children === "面板",
              ),
          );
          expect(nav).toBeDefined();
          nav!.props.onClick();
          await flushMicrotasks();
        });
        await act(async () => {
          const panels = workbenchElements(hook.result.current.tree).find(
            (element) => element.type === HubPanels,
          );
          expect(panels).toBeDefined();
          panels!.props.onOpen({
            id: "synthetic-panel",
            title: { default: "Panel" },
            version: "1.0.0",
            entry: "index.html",
            icon: "panel",
            singleton: true,
            permissions: ["context.session"],
            revision: "revision",
            bound: true,
            enabled: true,
            globalDisabled: false,
            updatable: false,
            source: { kind: "local", label: "Fixture" },
            compatibility: { supported: true, reasons: [] },
          });
          await flushMicrotasks();
        });
        const panel = workbenchElements(hook.result.current.tree).find(
          (element) => element.type === PanelHost,
        );
        expect(panel).toBeDefined();
        expect(panel!.props.sessionId).toBe(canonical);
        expect(panel!.key).toBe(
          `${hook.result.current.controller.workspaceKey}:panel:synthetic-panel`,
        );
        expect(hook.result.current.controller.activeId).toBe(activeId);
        if (!canonical) {
          for (const sessionId of new Set([activeId, "native-previous"]))
            await expect(
              panel!.props.onSubmitPrompt({ prompt: "Must not send", sessionId }),
            ).rejects.toThrow();
          expect(hook.result.current.controller.draft).toBe("");
        }
        expect(sent).toEqual([]);
      } finally {
        await hook.unmount();
      }
    },
  );

  test("recovery preserves draft text and attachments without releasing an old intent", async () => {
    const sent: unknown[] = [];
    let app = remoteApp({
      activeSessionId: "native",
      outputHistoryFailed: true,
      getSessionOutputRecoveryPlan: async () => ({
        status: "blocked",
        sessionId: "native",
        reason: "unavailable",
      }),
      applySessionOutputRecovery: async () => ({
        status: "applied",
        sessionId: "native",
        historicalGap: true,
      }),
      sendChat: async (input) => {
        sent.push(input);
        return true;
      },
    });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    try {
      await act(async () => {
        hook.result.current.setDraft("keep this unsent task");
        hook.result.current.addFiles([
          new File(["owned image"], "kept.png", { type: "image/png" }),
        ] as unknown as FileList);
      });
      expect(hook.result.current.readOnly).toBe(true);
      expect(hook.result.current.send()).toBe(false);
      const card = React.Children.toArray(
        (hook.result.current.chatControls as React.ReactElement<{ children: React.ReactNode }>)
          .props.children,
      ).find(
        (child) => React.isValidElement(child) && child.type === OutputHistoryRecovery,
      ) as React.ReactElement<{ onApplied(): void }>;
      expect(card).toBeTruthy();
      await act(async () => {
        card.props.onApplied();
      });
      expect(hook.result.current.draft).toBe("keep this unsent task");
      expect(hook.result.current.files.map((file) => file.name)).toEqual(["kept.png"]);
      expect(sent).toEqual([]);
      app = { ...app, outputHistoryFailed: false, outputHistoricalGap: true };
      await hook.rerender();
      expect(hook.result.current.readOnly).toBeFalsy();
      expect(hook.result.current.draft).toBe("keep this unsent task");
      expect(hook.result.current.files).toHaveLength(1);
      expect(sent).toEqual([]);
    } finally {
      await hook.unmount();
    }
  });

  test("retired in-flight submission merges into later typing and stays manual", async () => {
    const response = deferred<boolean>();
    let retired: (() => void) | undefined;
    const calls: unknown[] = [];
    const app = remoteApp({
      activeSessionId: "native",
      sendChat: (input) => {
        calls.push(input);
        retired = input.onRetired;
        return response.promise;
      },
    });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    try {
      await act(async () => {
        hook.result.current.setDraft("original task");
        hook.result.current.addFiles([
          new File(["image"], "task.png", { type: "image/png" }),
        ] as unknown as FileList);
      });
      await act(async () => {
        hook.result.current.send();
      });
      await act(async () => {
        hook.result.current.setDraft("later typing");
        retired?.();
        response.resolve(false);
      });
      expect(hook.result.current.draft).toContain("original task");
      expect(hook.result.current.draft).toContain("later typing");
      expect(hook.result.current.files.map((file) => file.name)).toEqual(["task.png"]);
      expect(hook.result.current.uncertain).toBe(false);
      expect(hook.result.current.error).toContain("手动处理");
      expect(calls).toHaveLength(1);
    } finally {
      await hook.unmount();
    }
  });

  for (const laterTyping of [false, true])
    test(`send failure keeps its own reason and files (later typing: ${laterTyping})`, async () => {
      ensureMiniDom();
      const previous = Object.getOwnPropertyDescriptor(window, "matchMedia");
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => ({ matches: false }),
      });
      browserRestores.push(() =>
        previous
          ? Object.defineProperty(window, "matchMedia", previous)
          : Reflect.deleteProperty(window, "matchMedia"),
      );
      const response = deferred<boolean>();
      let reject: ((reason: string) => void) | undefined;
      const app = remoteApp({
        notice: "unrelated previous notice",
        sendChat: (input) => {
          reject = input.onRejected;
          return response.promise;
        },
      });
      const hook = await renderHook(() => useDesktopController(app, undefined, noop));
      try {
        await act(async () => {
          hook.result.current.setDraft("original task");
          hook.result.current.addFiles([
            new File(["image"], "task.png", { type: "image/png" }),
          ] as unknown as FileList);
        });
        await act(async () => {
          expect(hook.result.current.send()).toBe(true);
        });
        await act(async () => {
          if (laterTyping) hook.result.current.setDraft("later typing");
          reject?.("Selected runtime is unavailable");
          response.resolve(false);
          await flushMicrotasks();
        });
        expect(hook.result.current.draft).toContain("original task");
        if (laterTyping) expect(hook.result.current.draft).toContain("later typing");
        expect(hook.result.current.files.map((file) => file.name)).toEqual(["task.png"]);
        expect(hook.result.current.error).toContain("Selected runtime is unavailable");
        expect(hook.result.current.error).toContain("消息未送达");
        expect(hook.result.current.error).not.toContain("unrelated previous notice");
        expect(hook.result.current.uncertain).toBe(false);
        const markup = renderToStaticMarkup(<Workbench controller={hook.result.current} />);
        expect(markup).toContain("Selected runtime is unavailable");
      } finally {
        await hook.unmount();
      }
    });

  test("offline session and CLI navigation preserve the workspace and draft", async () => {
    const calls: string[] = [];
    const app = remoteApp({
      status: "offline",
      activeSessionId: "native-a",
      activeCwd: "/a",
      sessions: [{ id: "native-b", title: "B", cwd: "/b", updatedAt: 1 }],
      selectProject: () => calls.push("project"),
      selectSession: () => calls.push("session"),
      openCcSession: () => calls.push("cli"),
    });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    try {
      await act(async () => {
        hook.result.current.setDraft("keep my unsent task");
        hook.result.current.selectSession("native-b");
      });
      const sidebar = hook.result.current.renderSidebar!({
        guard: noop,
        conversation: noop,
      }) as React.ReactElement<{ app: RemoteApp }>;
      await act(async () => sidebar.props.app.openCcSession("cli-b", "/b", "default"));
      expect(calls).toEqual([]);
      expect(hook.result.current.workspaceCwd).toBe("/a");
      expect(hook.result.current.activeId).toBe("native-a");
      expect(hook.result.current.draft).toBe("keep my unsent task");
      expect(hook.result.current.error).toContain("连接已断开");
    } finally {
      await hook.unmount();
    }
  });

  test("new-session target and visible history use the remote Host case policy", async () => {
    const created: unknown[] = [];
    const projects = [
      {
        id: "upper",
        name: "Upper",
        path: "/srv/Example",
        pathCaseSensitive: true,
        roots: [{ id: "upper-root", name: "main", path: "/srv/Example", role: "primary" as const }],
      },
      {
        id: "lower",
        name: "Lower",
        path: "/srv/example",
        pathCaseSensitive: true,
        roots: [{ id: "lower-root", name: "main", path: "/srv/example", role: "primary" as const }],
      },
    ];
    const app = remoteApp({
      activeCwd: "/srv/example",
      projects,
      sessions: [
        { id: "upper-session", title: "Upper session", cwd: "/srv/Example", updatedAt: 1 },
        { id: "lower-session", title: "Lower session", cwd: "/srv/example", updatedAt: 2 },
      ],
      newSession: (target) => created.push(target),
    });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    try {
      const visible = hook.result.current.sessions.map((item) => item.sessionId);
      await act(async () => hook.result.current.newSession());
      expect(created).toEqual([{ projectId: "lower", rootId: "lower-root" }]);
      expect(visible).toEqual(["lower-session"]);
    } finally {
      await hook.unmount();
    }
  });

  test("an optional question retains its card while a new message can be sent", async () => {
    const sent: unknown[] = [];
    const app = remoteApp({
      activeSessionId: "existing",
      approvals: [
        {
          id: "optional",
          requestId: "optional",
          sessionId: "existing",
          toolName: "__ask_user__",
          summary: "Optional question",
          risk: "low",
          asynchronous: true,
        },
      ],
      sendChat: async (message) => {
        sent.push(message);
        return true;
      },
    });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    expect(hook.result.current.running).toBe(false);
    expect(hook.result.current.approvals[0].asynchronous).toBe(true);
    await act(async () => {
      hook.result.current.setDraft("Continue independently");
      expect(hook.result.current.send()).toBe(true);
      await flushMicrotasks();
    });
    expect(sent).toHaveLength(1);
    expect(hook.result.current.approvalContent).toHaveLength(1);
    await hook.unmount();
  });

  test("send reports local admission and preserves a newer draft when its private send guard is busy", async () => {
    const ack = deferred<boolean>();
    let app = remoteApp({ sendChat: () => ack.promise });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    await act(async () => {
      expect(hook.result.current.send()).toBe(false);
      hook.result.current.setDraft("admitted task");
      expect(hook.result.current.send()).toBe(true);
      hook.result.current.setDraft("later draft");
      expect(hook.result.current.send()).toBe(false);
    });
    expect(hook.result.current.draft).toBe("later draft");
    await act(async () => {
      ack.resolve(true);
      await flushMicrotasks();
    });
    app = { ...app, status: "offline" };
    await hook.rerender();
    await act(async () => {
      expect(hook.result.current.send()).toBe(false);
    });
    expect(hook.result.current.draft).toBe("later draft");
    await hook.unmount();
  });

  test("first accepted send carries the next draft and its image to the durable session ID", async () => {
    const ack = deferred<boolean>();
    const sent: unknown[] = [];
    let app = remoteApp({
      sendChat: (input) => {
        sent.push(input);
        return ack.promise;
      },
    });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    await act(async () => {
      hook.result.current.setDraft("first task");
    });
    await act(async () => {
      hook.result.current.send();
    });
    const image = new File(["synthetic-image"], "next.png", { type: "image/png" });
    await act(async () => {
      hook.result.current.setDraft("next task while accepting");
      hook.result.current.addFiles([image] as unknown as FileList);
    });
    app = { ...app, activeSessionId: "mobile-real-1" };
    await hook.rerender();
    await act(async () => {
      ack.resolve(true);
      await flushMicrotasks();
    });
    expect(sent).toEqual([
      {
        text: "first task",
        permissionMode: "default",
        attachments: [],
        onUncertain: expect.any(Function),
        onRetired: expect.any(Function),
        onRejected: expect.any(Function),
      },
    ]);
    expect(hook.result.current.activeId).toBe("mobile-real-1");
    expect(hook.result.current.draft).toBe("next task while accepting");
    expect(hook.result.current.files.map((file) => file.name)).toEqual(["next.png"]);
    expect(hook.result.current.localDrafts).toHaveLength(0);
    await hook.unmount();
  });

  test("session.create acceptance preserves text typed before any task is sent", async () => {
    let app = remoteApp({ activeSessionId: "previous-session" });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    await act(async () => {
      hook.result.current.newSession();
    });
    app = { ...app, activeSessionId: undefined };
    await hook.rerender();
    await act(async () => {
      hook.result.current.setDraft("draft typed while creating");
    });
    app = { ...app, activeSessionId: "mobile-created-2" };
    await hook.rerender();
    expect(hook.result.current.draft).toBe("draft typed while creating");
    expect(hook.result.current.localDrafts).toHaveLength(0);
    await hook.unmount();
  });

  test("late acceptance after navigation retains the original local draft without mixing another session", async () => {
    const ack = deferred<boolean>();
    let app = remoteApp({ sendChat: () => ack.promise });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    const localId = hook.result.current.activeId;
    await act(async () => {
      hook.result.current.setDraft("first task");
    });
    await act(async () => {
      hook.result.current.send();
    });
    await act(async () => {
      hook.result.current.setDraft("retained next task");
      hook.result.current.selectSession("other-session");
    });
    app = { ...app, activeSessionId: "other-session" };
    await hook.rerender();
    await act(async () => {
      hook.result.current.setDraft("other session draft");
      ack.resolve(true);
      await flushMicrotasks();
    });
    expect(hook.result.current.draft).toBe("other session draft");
    expect(
      hook.result.current.localDrafts.map((item) => [item.sessionId, item.draft.text]),
    ).toEqual([[localId, "retained next task"]]);
    await hook.unmount();
  });

  test("reopening an unsent local draft keeps the original project root", async () => {
    const created: unknown[] = [];
    const app = remoteApp({
      activeCwd: "/project-a",
      projects: [
        { id: "a", name: "A", path: "/project-a" },
        { id: "b", name: "B", path: "/project-b" },
      ],
      newSession: (target) => created.push(target),
    });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    const originalId = hook.result.current.activeId;
    await act(async () => {
      hook.result.current.setDraft("belongs to project A");
    });
    const sidebar = hook.result.current.renderSidebar!({
      guard: noop,
      conversation: noop,
    }) as React.ReactElement<{ app: RemoteApp }>;
    await act(async () => {
      sidebar.props.app.selectProject("b");
    });
    await act(async () => {
      hook.result.current.newSession();
    });
    expect(hook.result.current.workspaceCwd).toBe("/project-b");
    expect(hook.result.current.localDrafts.find((item) => item.sessionId === originalId)?.cwd).toBe(
      "/project-a",
    );
    await act(async () => {
      hook.result.current.selectSession(originalId);
    });
    expect(hook.result.current.workspaceCwd).toBe("/project-a");
    expect(created.at(-1)).toEqual({ projectId: "a" });
    expect(hook.result.current.draft).toBe("belongs to project A");
    await hook.unmount();
  });

  test.each(["/draft-project", null])(
    "opening a local draft in %s confirms before retiring the retained Panel",
    async (draftCwd) => {
      ensureMiniDom();
      let location = new URL("http://localhost/mobile/");
      let accept = false;
      const confirmations: string[] = [];
      const history = {
        state: null as unknown,
        replaceState(state: unknown, _unused: string, url: string) {
          this.state = state;
          location = new URL(url, location);
        },
        pushState(state: unknown, unused: string, url: string) {
          this.replaceState(state, unused, url);
        },
      };
      for (const [key, descriptor] of [
        ["location", { get: () => location }],
        ["history", { value: history }],
        [
          "matchMedia",
          { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
        ],
        [
          "confirm",
          {
            value: (message: string) => {
              confirmations.push(message);
              return accept;
            },
          },
        ],
      ] as const) {
        const previous = Object.getOwnPropertyDescriptor(window, key);
        Object.defineProperty(window, key, { configurable: true, ...descriptor });
        browserRestores.push(() =>
          previous ? Object.defineProperty(window, key, previous) : delete (window as any)[key],
        );
      }
      const creates: unknown[] = [];
      const app = remoteApp({
        activeCwd: draftCwd,
        projects: [
          { id: "draft", name: "Draft", path: "/draft-project" },
          { id: "current", name: "Current", path: "/current-project" },
        ],
        newSession: (target) => creates.push(target),
      });
      const hook = await renderHook(() => {
        const controller = useDesktopController(app, undefined, noop);
        return {
          controller,
          tree: Workbench({ controller: { ...controller, workspaceApi: true } }),
        };
      });
      const elements = () => workbenchElements(hook.result.current.tree);
      const draftButton = () =>
        elements().find(
          (element) =>
            element.type === "button" &&
            workbenchElements(element.props.children).some(
              (child) => child.type === "span" && child.props.children === "Original local draft",
            ),
        );
      try {
        const originalId = hook.result.current.controller.activeId;
        await act(async () => {
          hook.result.current.controller.setDraft("Original local draft");
        });
        await act(async () => {
          hook.result.current.controller.selectProject!("current");
        });
        expect(hook.result.current.controller.workspaceCwd).toBe("/current-project");
        expect(
          hook.result.current.controller.localDrafts.find((item) => item.sessionId === originalId)
            ?.cwd,
        ).toBe(draftCwd);
        await act(async () => {
          const nav = elements().find(
            (element) =>
              element.type === "button" &&
              workbenchElements(element.props.children).some(
                (child) => child.type === "span" && child.props.children === "面板",
              ),
          );
          nav!.props.onClick();
        });
        await act(async () => {
          elements()
            .find((element) => element.type === HubPanels)!
            .props.onOpen({
              id: "retained-panel",
              title: { default: "Panel" },
              version: "1.0.0",
              entry: "index.html",
              icon: "panel",
              singleton: true,
              permissions: ["context.session"],
              revision: "revision",
              bound: true,
              enabled: true,
              globalDisabled: false,
              updatable: false,
              source: { kind: "local", label: "Fixture" },
              compatibility: { supported: true, reasons: [] },
            });
        });
        const panelKey = elements().find((element) => element.type === PanelHost)!.key;
        creates.length = 0;
        await act(async () => {
          draftButton()!.props.onClick();
        });
        expect(confirmations).toHaveLength(1);
        expect(creates).toEqual([]);
        expect(hook.result.current.controller.workspaceCwd).toBe("/current-project");
        expect(elements().find((element) => element.type === PanelHost)!.key).toBe(panelKey);
        accept = true;
        await act(async () => {
          draftButton()!.props.onClick();
        });
        expect(confirmations).toHaveLength(2);
        expect(creates).toEqual([{ projectId: draftCwd === null ? null : "draft" }]);
        expect(hook.result.current.controller.workspaceCwd).toBe(draftCwd);
        expect(hook.result.current.controller.draft).toBe("Original local draft");
        expect(elements().some((element) => element.type === PanelHost)).toBe(false);
      } finally {
        await hook.unmount();
      }
    },
  );

  test("failed send restores text and images and keeps later edits after them", async () => {
    let pending = deferred<boolean>();
    const app = remoteApp({ activeSessionId: "existing", sendChat: () => pending.promise });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    await act(async () => {
      hook.result.current.setDraft("keep on failure");
      hook.result.current.addFiles([
        new File(["image"], "kept.png", { type: "image/png" }),
      ] as unknown as FileList);
    });
    await act(async () => {
      hook.result.current.send();
    });
    await act(async () => {
      pending.resolve(false);
      await flushMicrotasks();
    });
    expect(hook.result.current.draft).toBe("keep on failure");
    expect(hook.result.current.files[0]?.name).toBe("kept.png");
    pending = deferred<boolean>();
    await act(async () => {
      hook.result.current.send();
    });
    await act(async () => {
      hook.result.current.setDraft("replacement");
      pending.resolve(false);
      await flushMicrotasks();
    });
    // The failed task is put back before the newer text; neither is lost.
    expect(hook.result.current.draft).toBe("keep on failure\n\nreplacement");
    expect(hook.result.current.files.map((file) => file.name)).toEqual(["kept.png"]);
    await hook.unmount();
  });

  test("workspace switches use the selected root before fetching and discard a stale configuration response", async () => {
    ensureMiniDom();
    const old = deferred<Response>();
    const requests: string[] = [];
    globalThis.fetch = (async (_path, init) => {
      const cwd = decodeURIComponent(new Headers(init?.headers).get("X-CodeShell-Workspace") ?? "");
      requests.push(cwd);
      return cwd === "/old" ? old.promise : Response.json(configuration(cwd));
    }) as typeof fetch;
    const created: unknown[] = [];
    const app = remoteApp({
      activeCwd: "/old",
      activeProjectCwd: "/old",
      activeProjectId: "old",
      projects: [
        { id: "old", name: "Old", path: "/old" },
        {
          id: "new",
          name: "New",
          path: "/new",
          primaryRootId: "primary",
          roots: [
            { id: "primary", name: "main", path: "/new", role: "primary" },
            { id: "extra", name: "extra", path: "/new-extra", role: "attached" },
          ],
        },
      ],
      newSession: (target) => {
        created.push(target);
      },
    });
    const hook = await renderHook(() => useDesktopController(app, session, noop));
    let sidebar = hook.result.current.renderSidebar!({
      guard: (action) => action(),
      conversation: (action) => action(),
    }) as React.ReactElement<{ app: RemoteApp }>;
    await act(async () => {
      sidebar.props.app.newSession({ projectId: "new", rootId: "extra" });
      await flushMicrotasks();
    });
    expect(getApiWorkspace()).toBe("/new-extra");
    expect(requests.at(-1)).toBe("/new-extra");
    expect(hook.result.current.configuration?.workspace.path).toBe("/new-extra");
    await act(async () => {
      old.resolve(Response.json(configuration("/old")));
      await flushMicrotasks();
    });
    expect(hook.result.current.configuration?.workspace.path).toBe("/new-extra");
    await act(async () => {
      hook.result.current.newSession();
    });
    expect(created.at(-1)).toEqual({ projectId: "new", rootId: "extra" });
    sidebar = hook.result.current.renderSidebar!({
      guard: (action) => action(),
      conversation: (action) => action(),
    }) as React.ReactElement<{ app: RemoteApp }>;
    await act(async () => {
      sidebar.props.app.newSession({ projectId: null });
    });
    expect(getApiWorkspace()).toBeUndefined();
    expect(hook.result.current.workspaceCwd).toBeNull();
    await hook.unmount();
  });

  for (const workspace of [
    "/project",
    "/secondary-root",
    "/project/.code-shell/worktrees/session",
    "/external-worktrees/session",
  ])
    test(`configuration notifications refresh the current workspace at ${workspace}`, async () => {
      ensureMiniDom();
      const requests: string[] = [];
      globalThis.fetch = (async (_path, init) => {
        const cwd = decodeURIComponent(
          new Headers(init?.headers).get("X-CodeShell-Workspace") ?? "",
        );
        requests.push(cwd);
        return Response.json(configuration(cwd));
      }) as typeof fetch;
      const app = remoteApp({ activeCwd: workspace });
      const hook = await renderHook(() => useDesktopController(app, session, noop));
      try {
        for (const params of [{ cwd: "/project" }, { cwd: "/other-project" }, {}]) {
          const count = requests.length;
          const revision = hook.result.current.configurationVersion;
          await act(async () => {
            hook.result.current.onHostNotification("serve/configurationChanged", params);
            await flushMicrotasks();
          });
          expect(requests).toHaveLength(count + 1);
          expect(requests.at(-1)).toBe(workspace);
          expect(hook.result.current.workspaceCwd).toBe(workspace);
          expect(hook.result.current.configuration?.workspace.path).toBe(workspace);
          expect(hook.result.current.configurationVersion).toBeGreaterThan(revision);
        }
      } finally {
        await hook.unmount();
      }
    });

  test("a delayed configuration notification refresh cannot replace a newly selected workspace", async () => {
    ensureMiniDom();
    const old = deferred<Response>();
    let holdOld = false;
    let heldRequests = 0;
    globalThis.fetch = (async (_path, init) => {
      const cwd = decodeURIComponent(new Headers(init?.headers).get("X-CodeShell-Workspace") ?? "");
      if (cwd === "/secondary-root" && holdOld) {
        heldRequests++;
        return old.promise;
      }
      return Response.json(configuration(cwd));
    }) as typeof fetch;
    let app = remoteApp({ activeCwd: "/secondary-root" });
    const hook = await renderHook(() => useDesktopController(app, session, noop));
    try {
      holdOld = true;
      await act(async () => {
        hook.result.current.onHostNotification("serve/configurationChanged", { cwd: "/primary" });
        await flushMicrotasks();
      });
      expect(heldRequests).toBe(1);
      app = remoteApp({ activeCwd: "/new-project" });
      await hook.rerender();
      const revision = hook.result.current.configurationVersion;
      expect(hook.result.current.configuration?.workspace.path).toBe("/new-project");
      await act(async () => {
        old.resolve(Response.json(configuration("/secondary-root")));
        await flushMicrotasks();
      });
      expect(hook.result.current.workspaceCwd).toBe("/new-project");
      expect(getApiWorkspace()).toBe("/new-project");
      expect(hook.result.current.configuration?.workspace.path).toBe("/new-project");
      expect(hook.result.current.configurationVersion).toBe(revision);
    } finally {
      await hook.unmount();
    }
  });

  test("Desktop and Hub render the same conversation controls with host-specific capabilities", async () => {
    ensureMiniDom();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false }),
    });
    const hook = await renderHook(() => useDesktopController(remoteApp(), undefined, noop));
    const desktop = renderToStaticMarkup(
      <Workbench controller={{ ...hook.result.current, session, workspaceApi: true }} />,
    );
    const recovering = renderToStaticMarkup(
      <Workbench
        controller={{
          ...hook.result.current,
          connection: "closed",
          connectionMessage: "正在恢复与电脑的连接…",
        }}
      />,
    );
    expect(recovering).toContain("正在恢复与电脑的连接…");
    expect(recovering).not.toContain("连接已断开，重连中…");
    const hub = renderToStaticMarkup(
      <Workbench
        controller={{
          ...hook.result.current,
          host: "hub",
          session,
          workspaceApi: true,
          renderSidebar: undefined,
          chatControls: undefined,
          composerControls: undefined,
          cameraAttachments: false,
        }}
      />,
    );
    for (const html of [desktop, hub]) {
      expect(html).toContain('class="workbench');
      expect(html).toContain("Skills");
      // Link connections open from settings, not the sidebar.
      expect(html).not.toContain("<span>Link</span>");
      expect(html).toContain('aria-label="任务内容"');
    }
    expect(desktop).toContain('aria-label="项目会话"');
    expect(desktop).toContain("无项目对话");
    expect(desktop).not.toContain('aria-label="选择项目"');
    expect(desktop).toContain('aria-label="拍照"');
    expect(
      desktop.slice(desktop.indexOf('<footer class="composer'), desktop.indexOf("</footer>")),
    ).toContain('aria-label="权限模式"');
    expect(
      desktop.slice(
        desktop.indexOf('<div class="transcript"'),
        desktop.indexOf('<footer class="composer'),
      ),
    ).not.toContain('aria-label="权限模式"');
    expect(hub).not.toContain('aria-label="权限模式"');
    expect(desktop).not.toContain("设备与退出");
    expect(hub).toContain("设备与退出");
    await hook.unmount();
  });

  test("preparing a send does not expose a stop control and accepts image files with missing picker MIME", async () => {
    const pending = deferred<boolean>();
    const hook = await renderHook(() =>
      useDesktopController(remoteApp({ sendChat: () => pending.promise }), undefined, noop),
    );
    await act(async () => {
      hook.result.current.addFiles([
        new File(["synthetic HEIC"], "image.heic"),
      ] as unknown as FileList);
    });
    expect(hook.result.current.files).toHaveLength(1);
    await act(async () => {
      hook.result.current.send();
    });
    expect(hook.result.current.uploading).toBe(true);
    expect(hook.result.current.running).toBe(false);
    await act(async () => {
      pending.resolve(false);
      await flushMicrotasks();
    });
    await hook.unmount();
  });

  test("selecting a saved session synchronizes CLI discovery with its actual project", async () => {
    const selectedProjects: string[] = [];
    const hook = await renderHook(() =>
      useDesktopController(
        remoteApp({
          activeProjectCwd: "/a",
          projects: [{ id: "b", name: "B", path: "/b" }],
          sessions: [
            { id: "saved-b", title: "B session", cwd: "/b", updatedAt: 1, origin: "desktop" },
          ],
          selectProject: (id) => selectedProjects.push(id),
        }),
        undefined,
        noop,
      ),
    );
    await act(async () => {
      hook.result.current.selectSession("saved-b");
    });
    expect(selectedProjects).toEqual(["b"]);
    expect(hook.result.current.workspaceCwd).toBe("/b");
    await hook.unmount();
  });

  test("leaving this device is immediate even while the HTTP logout is still pending", async () => {
    const logoutResponse = deferred<Response>();
    const requests: string[] = [];
    globalThis.fetch = (async (path: string | URL | Request) => {
      requests.push(String(path));
      return logoutResponse.promise;
    }) as typeof fetch;
    let loggedOut = 0;
    const app = remoteApp({ logout: () => loggedOut++ });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    try {
      await act(async () => {
        hook.result.current.logout?.();
        await flushMicrotasks();
      });
      expect(requests).toEqual(["/api/v1/auth/logout"]);
      expect(loggedOut).toBe(1);
      await act(async () => {
        logoutResponse.resolve(Response.json({ ok: true }));
        await flushMicrotasks();
      });
      expect(loggedOut).toBe(1);
    } finally {
      await hook.unmount();
    }
  });

  test("offline approvals cannot be submitted and CLI roots remain available", () => {
    const app = remoteApp({ status: "offline" });
    const markup = renderToStaticMarkup(
      <DesktopApproval
        app={app}
        approval={{
          requestId: "r",
          toolName: "Read",
          summary: "fixture",
          description: "",
          risk: "low",
          pathScoped: true,
        }}
      />,
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("授权范围");
    const sidebar = renderToStaticMarkup(
      <DesktopSidebar app={app} navigation={{ guard: noop, conversation: noop }} />,
    );
    expect(sidebar).toContain("Claude Code");
    expect(sidebar).toContain("Codex");
  });
});

function reactProps(node: unknown): Record<string, any> {
  const key = Object.keys(node as object).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as Record<string, any>)[key] : {};
}
function elementsByTag(node: any, tag: string): any[] {
  return [
    ...(node.tagName === tag ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child: any) => elementsByTag(child, tag)),
  ];
}
function textOf(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? "";
  return node.childNodes?.length ? node.childNodes.map(textOf).join("") : (node.textContent ?? "");
}

test("CLI room permission picker explains the next turn and retains the Host-confirmed mode", () => {
  const room = {
    id: "room-1",
    name: "CLI",
    cwd: "/repo",
    kind: "codex" as const,
    permissionMode: "default" as const,
    createdAt: 1,
    lastActiveAt: 1,
    open: true,
    observing: false,
    sessionId: "thread-1",
  };
  const markup = (patch: Partial<RemoteApp> = {}) =>
    renderToStaticMarkup(
      <DesktopChatControls
        app={remoteApp({
          activeRoomId: room.id,
          activeRoom: room,
          setCcRoomPermissionMode: noop,
          ...patch,
        })}
      />,
    );
  const idle = markup();
  expect(idle).toContain('aria-haspopup="dialog"');
  expect(idle).toContain('value="default"');
  expect(idle).toContain("只读");
  expect(idle).toContain("下一条消息");
  expect(idle).not.toContain("<select");
  expect(idle).not.toContain('disabled=""');
  const pending = markup({ ccModeRequest: { mode: "bypassPermissions", switching: true } });
  expect(pending).toMatch(/<button[^>]*disabled=""/);
  expect(pending).toContain('value="default"');
  expect(pending).toContain("等待电脑确认");
  expect(cliModeSwitchNotice("codex", "bypassPermissions")).toContain("关闭沙箱");
  expect(cliModeSwitchNotice("codex", "bypassPermissions")).toContain("从下一条消息开始生效");
  expect(cliModeSwitchNotice("claude-code", "bypassPermissions")).toContain("跳过工具操作确认");
  const native = renderToStaticMarkup(
    <DesktopChatControls
      app={remoteApp({
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "t",
            cwd: "/repo",
            updatedAt: 1,
            origin: "desktop",
            provider: "codex",
          },
        ],
      })}
    />,
  );
  expect(native).toContain("下次发送生效；运行中变更需先停止");
});

test("CLI room chat controls show the room's actual mode and cannot change it natively", () => {
  const room = {
    id: "room-1",
    name: "CLI",
    cwd: "/repo",
    kind: "claude-code" as const,
    permissionMode: "bypassPermissions" as const,
    createdAt: 1,
    lastActiveAt: 1,
    open: true,
    observing: false,
  };
  const markup = (patch: Partial<RemoteApp>) =>
    renderToStaticMarkup(<DesktopChatControls app={remoteApp(patch)} />);
  const inRoom = markup({ activeRoomId: room.id, activeRoom: room, permissionMode: "default" });
  expect(inRoom).toMatch(/<button[^>]*disabled=""/);
  expect(inRoom).toContain('value="bypassPermissions"');
  expect(inRoom).toContain("跳过确认");
  expect(inRoom).not.toContain('value="default"');
  // Metadata not loaded yet: show no mode rather than the stricter native one.
  const pending = markup({ activeRoomId: room.id, permissionMode: "default" });
  expect(pending).toMatch(/<button[^>]*disabled=""/);
  expect(pending).not.toContain('value="default"');
  expect(pending).toContain("读取中…");
  const native = markup({ permissionMode: "acceptEdits" });
  expect(native).not.toMatch(/<button[^>]*disabled=""/);
  expect(native).toContain('value="acceptEdits"');
  expect(native).toContain("允许编辑");
});

test("a multi-question CLI clarification answers every question in one response", async () => {
  ensureMiniDom();
  const responses: unknown[] = [];
  const app = remoteApp({
    respondCcApproval: (roomId, requestId, decision) =>
      responses.push({ roomId, requestId, decision }),
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const question = (text: string) => ({ question: text, options: ["A", "B"], multiSelect: false });
  await act(async () => {
    root.render(
      <DesktopApproval
        app={app}
        approval={{
          requestId: "ask-many",
          roomId: "room-1",
          toolName: "AskUserQuestion",
          summary: "First?",
          description: "First?",
          risk: "low",
          options: ["A", "B"],
          optionsOnly: false,
          pathScoped: false,
          questions: [question("First?"), question("Second?")],
        }}
      />,
    );
    await flushMicrotasks();
  });
  try {
    expect(textOf(container)).toContain("Second?");
    const button = (label: string) =>
      elementsByTag(container, "BUTTON").filter((node) => textOf(node).endsWith(label));
    await act(async () => {
      reactProps(button("B")[0]).onClick();
      await flushMicrotasks();
    });
    expect(responses).toEqual([]);
    expect(reactProps(button("提交回答")[0]).disabled).toBe(true);
    await act(async () => {
      reactProps(elementsByTag(container, "TEXTAREA")[1]).onChange({
        target: { value: "My own" },
      });
      await flushMicrotasks();
    });
    await act(async () => {
      reactProps(button("提交回答")[0]).onClick();
      await flushMicrotasks();
    });
    expect(responses).toEqual([
      {
        roomId: "room-1",
        requestId: "ask-many",
        decision: { behavior: "allow", answers: { "First?": "B", "Second?": "My own" } },
      },
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("Link return restores its original management workspace and cannot send into another active project", async () => {
  ensureMiniDom();
  const previous = Object.getOwnPropertyDescriptor(window, "location");
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      pathname: "/mobile/",
      search: "?view=links&workspace=%2Foriginal",
    },
  });
  let sends = 0;
  const app = remoteApp({
    activeCwd: "/other",
    activeProjectCwd: "/other",
    sendChat: async () => {
      sends++;
      return true;
    },
  });
  const hook = await renderHook(() => useDesktopController(app, undefined, noop));
  try {
    expect(getApiWorkspace()).toBe("/original");
    await act(async () => {
      hook.result.current.setDraft("keep in the original project");
    });
    await act(async () => {
      expect(hook.result.current.send()).toBe(false);
    });
    expect(sends).toBe(0);
    expect(hook.result.current.draft).toBe("keep in the original project");
    expect(hook.result.current.error).toContain("另一个工作区");
  } finally {
    await hook.unmount();
    if (previous) Object.defineProperty(window, "location", previous);
    else Reflect.deleteProperty(window, "location");
  }
});

const runtimeModels = [
  {
    key: "codex/fixture",
    label: "Codex · Fixture",
    provider: "codex",
    kind: "codex" as const,
    maxContextTokens: 1000,
  },
  {
    key: "claude-code/sonnet",
    label: "Claude Code · Sonnet",
    provider: "claude-code",
    kind: "claude-code" as const,
    maxContextTokens: 1000,
  },
];
function modelPicker(controller: ReturnType<typeof useDesktopController>) {
  return (
    controller.modelSelector as React.ReactElement<React.ComponentProps<typeof DesktopModelPicker>>
  ).props;
}

test("native choices keep connection identity, leave old model labels truthful, and freeze retry intent", async () => {
  ensureMiniDom();
  let currentConfiguration = {
    ...configuration("/owned"),
    defaults: { text: "first" },
    catalog: [
      {
        id: "fixture",
        displayName: "Owned provider",
        adapterKind: "openai",
        defaultBaseUrl: "",
        needsKey: true,
      },
    ],
    connections: ["first", "second"].map((id) => ({
      id,
      catalogId: "fixture",
      tag: "text",
      model: "same-model",
      baseUrl: "",
      hasApiKey: true,
      needsKey: true,
    })),
  };
  globalThis.fetch = (async () => Response.json(currentConfiguration)) as typeof fetch;
  const sent: Array<Record<string, unknown>> = [];
  let reloaded = 0;
  let app = remoteApp({
    nativeModelSelection: true,
    reloadHistory: () => {
      reloaded++;
    },
    activeSessionId: "native-saved",
    activeCwd: "/owned",
    permissionMode: "default",
    sessions: [
      {
        id: "native-saved",
        title: "Owned",
        cwd: "/owned",
        updatedAt: 1,
        provider: "actual-provider",
        model: "codex/custom-native",
      },
    ],
    sendChat: async (input) => {
      sent.push(input);
      input.onUncertain?.("owned-intent");
      return false;
    },
  });
  const hook = await renderHook(() => useDesktopController(app, session, noop));
  try {
    expect(modelPicker(hook.result.current).value).toBe(CURRENT_NATIVE_MODEL);
    expect(modelPicker(hook.result.current).currentNativeLabel).toBe(
      "actual-provider · codex/custom-native",
    );
    expect(modelPicker(hook.result.current).nativeChoices?.map((item) => item.value)).toEqual([
      "native:first",
      "native:second",
    ]);
    await act(async () => {
      modelPicker(hook.result.current).onChange("native:second");
      hook.result.current.setDraft("owned native task");
    });
    expect(sent).toEqual([]);
    expect(app.permissionMode).toBe("default");
    await act(async () => {
      hook.result.current.send({ modelTraceSource: "owned-trace" });
      await flushMicrotasks();
    });
    expect(sent[0]).toMatchObject({ nativeConnectionId: "second", permissionMode: "default" });
    expect(sent[0].modelKey).toBeUndefined();
    app = { ...app, permissionMode: "bypassPermissions" };
    currentConfiguration = {
      ...currentConfiguration,
      defaults: { text: "first" },
      connections: currentConfiguration.connections.slice(0, 1),
    };
    await hook.rerender();
    await act(async () => {
      hook.result.current.refreshConfiguration();
      await flushMicrotasks();
    });
    await act(async () => modelPicker(hook.result.current).onChange("native:first"));
    expect(modelPicker(hook.result.current).value).toBe("native:second");
    await act(async () => {
      hook.result.current.send();
      await flushMicrotasks();
    });
    expect(sent[1]).toMatchObject({
      nativeConnectionId: "second",
      permissionMode: "default",
      clientMessageId: "owned-intent",
      modelTraceSource: "owned-trace",
    });
    expect(hook.result.current.draft).toBe("owned native task");
    const reload = workbenchElements(hook.result.current.chatControls).find(
      (element) => element.type === "button" && element.props.children === "重新载入会话核对记录",
    );
    expect(reload).toBeDefined();
    await act(async () => reload!.props.onClick());
    expect(reloaded).toBe(1);
    expect(sent).toHaveLength(2);
    expect(hook.result.current.draft).toBe("owned native task");
    app = { ...app, nativeModelSelection: false };
    await hook.rerender();
    await act(async () => expect(hook.result.current.send()).toBe(false));
    expect(sent).toHaveLength(2);
    expect(hook.result.current.uncertain).toBe(true);
    expect(hook.result.current.error).toContain("不支持这项原生模型选择");
    expect(hook.result.current.draft).toBe("owned native task");
  } finally {
    await hook.unmount();
  }
});

test("native choices wait for their current workspace snapshot after creation ACK and ignore old callbacks", async () => {
  ensureMiniDom();
  const snapshot = (cwd: string) => ({
    ...configuration(cwd),
    defaults: { text: "shared-id" },
    catalog: [
      {
        id: "fixture",
        displayName: "Owned",
        adapterKind: "openai",
        defaultBaseUrl: "",
        needsKey: false,
      },
    ],
    connections: [
      {
        id: "shared-id",
        catalogId: "fixture",
        tag: "text",
        model: cwd === "/A" ? "custom-A" : "custom-B",
        baseUrl: "",
        hasApiKey: false,
        needsKey: false,
      },
    ],
  });
  const lateA = deferred<ReturnType<typeof snapshot>>();
  const pendingB = deferred<ReturnType<typeof snapshot>>();
  let holdA = false;
  globalThis.fetch = (async (_path, init) => {
    const cwd = decodeURIComponent(new Headers(init?.headers).get("X-CodeShell-Workspace") ?? "");
    return Response.json(
      cwd === "/B" ? await pendingB.promise : holdA ? await lateA.promise : snapshot("/A"),
    );
  }) as typeof fetch;
  const sends: unknown[] = [];
  let app = remoteApp({
    nativeModelSelection: true,
    activeSessionId: "A",
    activeCwd: "/A",
    projects: [
      { id: "A", path: "/A", name: "A" },
      { id: "B", path: "/B", name: "B" },
    ],
    sendChat: async (input) => {
      sends.push(input);
      return true;
    },
  });
  const hook = await renderHook(() => useDesktopController(app, session, noop));
  try {
    const stalePicker = modelPicker(hook.result.current);
    expect(stalePicker.nativeChoices?.[0].label).toBe("custom-A · shared-id");
    holdA = true;
    await act(async () => {
      void hook.result.current.refreshConfiguration();
      await flushMicrotasks();
    });
    await act(async () => hook.result.current.selectProject!("B"));
    app = { ...app, activeSessionId: "B-new", activeCwd: "/B" };
    await hook.rerender();
    expect(hook.result.current.configuration).toBeNull();
    expect(modelPicker(hook.result.current).nativeChoices).toEqual([]);
    await act(async () => {
      hook.result.current.setDraft("B-only draft");
      stalePicker.onChange("native:shared-id");
      modelPicker(hook.result.current).onChange("native:shared-id");
    });
    expect(modelPicker(hook.result.current).value).toBe("");
    await act(async () => {
      lateA.resolve(snapshot("/A"));
      await flushMicrotasks();
    });
    expect(hook.result.current.configuration).toBeNull();
    expect(modelPicker(hook.result.current).nativeChoices).toEqual([]);
    await act(async () => {
      pendingB.resolve(snapshot("/B"));
      await flushMicrotasks();
    });
    expect(modelPicker(hook.result.current).nativeChoices?.[0].label).toBe("custom-B · shared-id");
    await act(async () => modelPicker(hook.result.current).onChange("native:shared-id"));
    expect(sends).toEqual([]);
    expect(hook.result.current.draft).toBe("B-only draft");
    await act(async () => {
      hook.result.current.send();
      await flushMicrotasks();
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ nativeConnectionId: "shared-id", permissionMode: "default" });
  } finally {
    await hook.unmount();
  }
});

test("choosing a native connection from an external session requires a fresh session ACK and preserves the draft", async () => {
  ensureMiniDom();
  globalThis.fetch = (async () =>
    Response.json({
      ...configuration("/owned"),
      defaults: { text: "first" },
      catalog: [
        {
          id: "fixture",
          displayName: "Owned",
          adapterKind: "openai",
          defaultBaseUrl: "",
          needsKey: false,
        },
      ],
      connections: [
        {
          id: "first",
          catalogId: "fixture",
          tag: "text",
          model: "native-model",
          baseUrl: "",
          hasApiKey: false,
          needsKey: false,
        },
      ],
    })) as typeof fetch;
  const sent: Array<Record<string, unknown>> = [],
    creates: unknown[] = [];
  let app = remoteApp({
    nativeModelSelection: true,
    activeSessionId: "external",
    activeCwd: "/owned",
    runtimeModels,
    sessions: [
      {
        id: "external",
        title: "External",
        cwd: "/owned",
        updatedAt: 1,
        provider: "codex",
        model: "fixture",
      },
    ],
    newSession: (target) => creates.push(target),
    sendChat: async (input) => {
      sent.push(input);
      return true;
    },
  });
  const hook = await renderHook(() => useDesktopController(app, session, noop));
  try {
    await act(async () => {
      hook.result.current.setDraft("keep across producer change");
      modelPicker(hook.result.current).onChange("native:first");
    });
    expect(creates).toHaveLength(1);
    expect(hook.result.current.send()).toBe(false);
    expect(sent).toEqual([]);
    app = { ...app, activeSessionId: "fresh-native", sessions: [] };
    await hook.rerender();
    expect(hook.result.current.draft).toBe("keep across producer change");
    await act(async () => {
      hook.result.current.send();
      await flushMicrotasks();
    });
    expect(sent[0]).toMatchObject({ nativeConnectionId: "first", permissionMode: "default" });
    expect(sent[0].modelKey).toBeUndefined();
    expect(modelPicker(hook.result.current).value).toBe("");
    // ACK does not fabricate model metadata. A fresh authoritative row is what
    // makes the actual provider/model visible, including after a new mount.
    app = {
      ...app,
      sessions: [
        {
          id: "fresh-native",
          title: "Owned",
          cwd: "/owned",
          updatedAt: 2,
          provider: "resolved-provider",
          model: "resolved-custom-model",
        },
      ],
    };
    await hook.rerender();
    expect(modelPicker(hook.result.current).value).toBe(CURRENT_NATIVE_MODEL);
    expect(modelPicker(hook.result.current).currentNativeLabel).toBe(
      "resolved-provider · resolved-custom-model",
    );
    const remounted = await renderHook(() => useDesktopController(app, session, noop));
    try {
      expect(modelPicker(remounted.result.current).value).toBe(CURRENT_NATIVE_MODEL);
      expect(modelPicker(remounted.result.current).currentNativeLabel).toBe(
        "resolved-provider · resolved-custom-model",
      );
      expect(sent).toHaveLength(1);
    } finally {
      await remounted.unmount();
    }
    app = { ...app, chat: { ...app.chat, run: "running" } };
    await hook.rerender();
    expect(modelPicker(hook.result.current).disabled).toBe(true);
    await act(async () => modelPicker(hook.result.current).onChange("native:first"));
    expect(modelPicker(hook.result.current).value).toBe(CURRENT_NATIVE_MODEL);
    app = { ...app, chat: { ...app.chat, run: "idle" } };
    await hook.rerender();
    await act(async () => hook.result.current.setDraft("ordinary follow-up"));
    await act(async () => {
      hook.result.current.send();
      await flushMicrotasks();
    });
    expect(sent).toHaveLength(2);
    expect(sent[1].nativeConnectionId).toBeUndefined();
    expect(sent[1].modelKey).toBeUndefined();
  } finally {
    await hook.unmount();
  }
});

test("external model selection waits for creation and follows the newly accepted session", async () => {
  const sent: Array<Record<string, unknown>> = [];
  let app = remoteApp({
    runtimeModels,
    sendChat: async (input) => {
      sent.push(input);
      return true;
    },
  });
  const hook = await renderHook(() => useDesktopController(app, undefined, noop));
  try {
    await act(async () => {
      hook.result.current.setDraft("run with the chosen provider");
      modelPicker(hook.result.current).onChange("codex/fixture");
    });
    await act(async () => {
      expect(hook.result.current.send()).toBe(false);
    });
    app = { ...app, activeSessionId: "accepted-external" };
    await hook.rerender();
    await act(async () => {
      expect(hook.result.current.send()).toBe(true);
      await flushMicrotasks();
    });
    expect(sent[0].modelKey).toBe("codex/fixture");
    expect(modelPicker(hook.result.current).value).toBe("codex/fixture");
    app = { ...app, activeSessionId: "another-native" };
    await hook.rerender();
    expect(modelPicker(hook.result.current).value).toBe("");
  } finally {
    await hook.unmount();
  }
});

test("refreshing page one preserves an older external selection and choosing native retains its draft", async () => {
  const creates: unknown[] = [];
  const sent: Array<Record<string, unknown>> = [];
  let app = remoteApp({
    runtimeModels,
    activeSessionId: "saved-codex",
    sessions: [
      {
        id: "saved-codex",
        title: "Saved",
        cwd: null,
        updatedAt: 1,
        provider: "codex",
        model: "fixture",
      },
    ],
    newSession: (target) => creates.push(target),
    sendChat: async (input) => {
      sent.push(input);
      return true;
    },
  });
  const hook = await renderHook(() => useDesktopController(app, undefined, noop));
  try {
    expect(modelPicker(hook.result.current).value).toBe("codex/fixture");
    app = { ...app, sessions: [] };
    await hook.rerender();
    expect(modelPicker(hook.result.current).value).toBe("codex/fixture");
    await act(async () => hook.result.current.setDraft("preserve this task"));
    await act(async () => modelPicker(hook.result.current).onChange(""));
    expect(creates).toEqual([{ projectId: null }]);
    app = { ...app, activeSessionId: undefined };
    await hook.rerender();
    expect(hook.result.current.draft).toBe("preserve this task");
    expect(modelPicker(hook.result.current).value).toBe("");
    app = { ...app, activeSessionId: "new-native" };
    await hook.rerender();
    expect(hook.result.current.draft).toBe("preserve this task");
    await act(async () => {
      hook.result.current.send();
      await flushMicrotasks();
    });
    expect(sent[0].modelKey).toBeUndefined();
  } finally {
    await hook.unmount();
  }
});

test("model controls refuse unadvertised choices and changes during an uncertain send", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const app = remoteApp({
    runtimeModels,
    activeSessionId: "native",
    sendChat: async (input) => {
      sent.push(input);
      input.onUncertain?.("unconfirmed-external");
      return false;
    },
  });
  const hook = await renderHook(() => useDesktopController(app, undefined, noop));
  try {
    await act(async () => modelPicker(hook.result.current).onChange("codex/not-advertised"));
    expect(modelPicker(hook.result.current).value).toBe("");
    await act(async () => {
      modelPicker(hook.result.current).onChange("codex/fixture");
      hook.result.current.setDraft("send once");
    });
    await act(async () => {
      hook.result.current.send();
      await flushMicrotasks();
    });
    expect(modelPicker(hook.result.current).disabled).toBe(true);
    await act(async () => modelPicker(hook.result.current).onChange("claude-code/sonnet"));
    expect(modelPicker(hook.result.current).value).toBe("codex/fixture");
    await act(async () => {
      hook.result.current.send();
      await flushMicrotasks();
    });
    expect(sent[1].modelKey).toBe("codex/fixture");
    expect(sent[1].clientMessageId).toBe("unconfirmed-external");
  } finally {
    await hook.unmount();
  }
});

test("the mobile model trigger preserves the saved unavailable model identity", () => {
  const html = renderToStaticMarkup(
    <DesktopModelPicker
      models={runtimeModels}
      value="codex/old-saved"
      defaultLabel="Default"
      disabled={false}
      onChange={noop}
    />,
  );
  expect(html).toContain('aria-label="选择模型或外部运行时"');
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).toContain('value="codex/old-saved"');
  expect(html).toContain("codex/old-saved · 当前会话");
});

test("failed session creation exposes a retry that retains the external model and draft", async () => {
  let creates = 0;
  const sent: Array<Record<string, unknown>> = [];
  let app = remoteApp({
    runtimeModels,
    sessionCreationFailures: 0,
    newSession: () => {
      creates++;
    },
    sendChat: async (input) => {
      sent.push(input);
      return true;
    },
  });
  const hook = await renderHook(() => useDesktopController(app, undefined, noop));
  try {
    await act(async () => {
      hook.result.current.setDraft("keep across a lost creation reply");
      modelPicker(hook.result.current).onChange("codex/fixture");
    });
    expect(hook.result.current.loading).toBe(true);
    app = { ...app, sessionCreationFailures: 1 };
    await hook.rerender();
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.draft).toBe("keep across a lost creation reply");
    expect(modelPicker(hook.result.current).value).toBe("codex/fixture");
    expect(hook.result.current.send()).toBe(false);
    await act(async () => modelPicker(hook.result.current).onRetryCreation!());
    expect(creates).toBe(2);
    expect(hook.result.current.draft).toBe("keep across a lost creation reply");
    app = { ...app, activeSessionId: "retry-created" };
    await hook.rerender();
    await act(async () => {
      expect(hook.result.current.send()).toBe(true);
      await flushMicrotasks();
    });
    expect(sent[0].modelKey).toBe("codex/fixture");
    expect(sent[0].text).toBe("keep across a lost creation reply");
  } finally {
    await hook.unmount();
  }
});

test("an immediately failed creation restores the visible draft and chosen model without overwriting later input", async () => {
  let creates = 0;
  const sent: Array<Record<string, unknown>> = [];
  let app = remoteApp({
    runtimeModels,
    sessionCreationFailures: 0,
    activeSessionId: "saved-external",
    sessions: [
      {
        id: "saved-external",
        cwd: "",
        title: "Saved",
        updatedAt: 1,
        origin: "desktop",
        provider: "codex",
        model: "fixture",
      },
    ],
    newSession: () => {
      creates++;
    },
    sendChat: async (input) => {
      sent.push(input);
      return true;
    },
  });
  const hook = await renderHook(() => useDesktopController(app, undefined, noop));
  const firstFile = new File(["first"], "first.png", { type: "image/png" });
  const secondFile = new File(["second"], "second.png", { type: "image/png" });
  try {
    await act(async () => {
      hook.result.current.setDraft("original task");
      hook.result.current.addFiles([firstFile] as unknown as FileList);
    });
    await act(async () => modelPicker(hook.result.current).onChange(""));
    // The socket rejected the create before the hook cleared its previous ID.
    expect(hook.result.current.activeId).toBe("saved-external");
    await act(async () => {
      hook.result.current.setDraft("later input");
      hook.result.current.addFiles([secondFile] as unknown as FileList);
    });
    app = { ...app, sessionCreationFailures: 1 };
    await hook.rerender();
    expect(hook.result.current.draft).toBe("original task\n\nlater input");
    expect(hook.result.current.files.map((file) => file.name)).toEqual(["first.png", "second.png"]);
    expect(modelPicker(hook.result.current).value).toBe("");
    expect(hook.result.current.localDrafts).toEqual([]);
    expect(hook.result.current.send()).toBe(false);
    await act(async () => modelPicker(hook.result.current).onRetryCreation!());
    expect(creates).toBe(2);
    app = { ...app, activeSessionId: undefined };
    await hook.rerender();
    expect(hook.result.current.draft).toBe("original task\n\nlater input");
    app = { ...app, activeSessionId: "retry-native" };
    await hook.rerender();
    await act(async () => {
      expect(hook.result.current.send()).toBe(true);
      await flushMicrotasks();
    });
    expect(sent[0].text).toBe("original task\n\nlater input");
    expect(sent[0].modelKey).toBeUndefined();
    expect((sent[0].attachments as Array<{ file: File }>).map((item) => item.file.name)).toEqual([
      "first.png",
      "second.png",
    ]);
  } finally {
    await hook.unmount();
  }
});

test("history loading exposes verified progress without declaring completion or dropping drafts", async () => {
  let app = remoteApp({
    activeSessionId: "native",
    sessions: [{ id: "native", title: "Saved conversation", updatedAt: 1, cwd: null }],
    loading: {
      sessions: false,
      sessionHistory: true,
      rooms: false,
      projects: false,
      roomHistory: false,
      ccSessions: false,
    },
    sessionHistoryProgress: { phase: "journal", pages: 2, receivedBytes: 50, totalBytes: 100 },
  });
  const hook = await renderHook(() => useDesktopController(app, undefined, noop));
  try {
    await act(async () => hook.result.current.setDraft("manual draft"));
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.loadingLabel).toContain("50%");
    expect(hook.result.current.loadingProgress).toBe(50);
    expect(hook.result.current.title).toBe("Saved conversation");
    app = {
      ...app,
      sessionHistoryProgress: { phase: "journal", pages: 3, receivedBytes: 100, totalBytes: 100 },
    };
    await hook.rerender();
    expect(hook.result.current.loadingLabel).toContain("99%");
    expect(hook.result.current.loadingProgress).toBe(99);
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.draft).toBe("manual draft");
    app = {
      ...app,
      loading: { ...app.loading, sessionHistory: false },
      sessionHistoryProgress: undefined,
    };
    await hook.rerender();
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.loadingLabel).toBeUndefined();
    expect(hook.result.current.loadingProgress).toBeUndefined();
    expect(hook.result.current.draft).toBe("manual draft");
  } finally {
    await hook.unmount();
  }
});

test("history loading distinguishes retained content, unknown progress and blocked creation", () => {
  const loading = renderToStaticMarkup(<SessionLoadingState progress={100} />);
  expect(loading).toContain('role="status"');
  expect(loading).toContain('aria-valuenow="99"');
  expect(loading).toContain('class="session-loading-skeleton" aria-hidden="true"');
  const retained = renderToStaticMarkup(<SessionLoadingState retained progress={Number.NaN} />);
  expect(retained).toContain("session-loading-retained");
  expect(retained).not.toContain("session-loading-skeleton");
  expect(retained).not.toContain('role="progressbar"');
  const failed = renderToStaticMarkup(
    <SessionLoadingState failed label="建立会话失败，请重试。" progress={25} />,
  );
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("建立会话失败，请重试。");
  expect(failed).not.toContain("session-loading-skeleton");
  expect(failed).not.toContain('role="progressbar"');
});

test("empty-session replacement retains editable input through failure and retries without sending", async () => {
  const sent: Array<Record<string, unknown>> = [];
  let retries = 0;
  let creates = 0;
  let app = remoteApp({
    activeSessionId: "empty-old",
    runtimeModels,
    newSession: () => {
      creates++;
    },
    retryEmptySessionReplacement: () => {
      retries++;
    },
    sendChat: async (input) => {
      sent.push(input);
      return true;
    },
  });
  const hook = await renderHook(() => useDesktopController(app, undefined, noop));
  try {
    await act(async () => {
      hook.result.current.setDraft("unsent task");
      modelPicker(hook.result.current).onChange("codex/fixture");
      hook.result.current.addFiles([
        new File(["owned"], "kept.png", { type: "image/png" }),
      ] as unknown as FileList);
    });
    app = { ...app, emptySessionReplacement: { fromSessionId: "empty-old", status: "pending" } };
    await hook.rerender();
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.readOnly).toBeFalsy();
    expect(hook.result.current.send()).toBe(false);
    expect(modelPicker(hook.result.current).disabled).toBe(true);
    await act(async () => hook.result.current.setDraft("unsent task plus later typing"));
    app = { ...app, emptySessionReplacement: { fromSessionId: "empty-old", status: "failed" } };
    await hook.rerender();
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.loadingLabel).toContain("重试建立会话");
    expect(hook.result.current.loadingFailed).toBe(true);
    expect(hook.result.current.loadingProgress).toBeUndefined();
    expect(hook.result.current.send()).toBe(false);
    expect(modelPicker(hook.result.current).disabled).toBe(false);
    await act(async () => modelPicker(hook.result.current).onRetryCreation!());
    expect(retries).toBe(1);
    expect(creates).toBe(0);
    expect(sent).toEqual([]);
    app = {
      ...app,
      activeSessionId: "empty-new",
      emptySessionReplacement: {
        fromSessionId: "empty-old",
        toSessionId: "empty-new",
        status: "complete",
      },
    };
    await hook.rerender();
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.draft).toBe("unsent task plus later typing");
    expect(hook.result.current.files.map((file) => file.name)).toEqual(["kept.png"]);
    expect(modelPicker(hook.result.current).value).toBe("codex/fixture");
    expect(sent).toEqual([]);
    await hook.rerender();
    expect(hook.result.current.files).toHaveLength(1);
    await act(async () => {
      expect(hook.result.current.send()).toBe(true);
      await flushMicrotasks();
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("unsent task plus later typing");
    expect(sent[0].modelKey).toBe("codex/fixture");
    expect((sent[0].attachments as Array<{ file: File }>).map((item) => item.file.name)).toEqual([
      "kept.png",
    ]);
  } finally {
    await hook.unmount();
  }
});

test("empty-session replacement merges destination edits and preserves its newer model choice", async () => {
  let app = remoteApp({ activeSessionId: "replacement", runtimeModels });
  const hook = await renderHook(() => useDesktopController(app, undefined, noop));
  try {
    await act(async () => {
      hook.result.current.setDraft("destination typing");
      hook.result.current.addFiles([
        new File(["new"], "new.png", { type: "image/png" }),
      ] as unknown as FileList);
      modelPicker(hook.result.current).onChange("claude-code/sonnet");
    });
    app = { ...app, activeSessionId: "empty" };
    await hook.rerender();
    await act(async () => {
      hook.result.current.setDraft("source typing");
      hook.result.current.addFiles([
        new File(["old"], "old.png", { type: "image/png" }),
      ] as unknown as FileList);
      modelPicker(hook.result.current).onChange("codex/fixture");
    });
    app = { ...app, emptySessionReplacement: { fromSessionId: "empty", status: "pending" } };
    await hook.rerender();
    app = {
      ...app,
      activeSessionId: "replacement",
      emptySessionReplacement: {
        fromSessionId: "empty",
        toSessionId: "replacement",
        status: "complete",
      },
    };
    await hook.rerender();
    expect(hook.result.current.draft).toBe("source typing\n\ndestination typing");
    expect(hook.result.current.files.map((file) => file.name)).toEqual(["old.png", "new.png"]);
    expect(modelPicker(hook.result.current).value).toBe("claude-code/sonnet");
    await hook.rerender();
    expect(hook.result.current.draft).toBe("source typing\n\ndestination typing");
    app = { ...app, activeSessionId: "empty", emptySessionReplacement: undefined };
    await hook.rerender();
    expect(hook.result.current.draft).toBe("");
    expect(hook.result.current.files).toEqual([]);
  } finally {
    await hook.unmount();
  }
});

test.each(["session", "new", "cli"])(
  "late empty-session replacement after %s navigation never moves the old draft",
  async (navigation) => {
    let app = remoteApp({ activeSessionId: "empty" });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    try {
      await act(async () => hook.result.current.setDraft("keep on old draft"));
      app = { ...app, emptySessionReplacement: { fromSessionId: "empty", status: "pending" } };
      await hook.rerender();
      await act(async () => {
        if (navigation === "session") hook.result.current.selectSession("other");
        else if (navigation === "new") hook.result.current.newSession();
        else {
          const sidebar = hook.result.current.renderSidebar!({
            guard: noop,
            conversation: noop,
          }) as React.ReactElement<{ app: RemoteApp }>;
          sidebar.props.app.openCcSession("cli", "/owned", "default");
        }
      });
      // Even a late producer that changes activeId cannot authorize draft migration
      // after the controller has observed an explicit navigation intent.
      app = {
        ...app,
        activeSessionId: "replacement",
        emptySessionReplacement: {
          fromSessionId: "empty",
          toSessionId: "replacement",
          status: "complete",
        },
      };
      await hook.rerender();
      expect(hook.result.current.draft).toBe("");
      app = { ...app, activeSessionId: "empty", emptySessionReplacement: undefined };
      await hook.rerender();
      expect(hook.result.current.draft).toBe("keep on old draft");
    } finally {
      await hook.unmount();
    }
  },
);

test.each([false, true])(
  "the active Desktop approval UI shows the deadline (multiple questions: %s)",
  (multiple) => {
    const expiresAt = 2_000_000;
    const markup = renderToStaticMarkup(
      <DesktopApproval
        app={remoteApp({ status: "online" })}
        approval={{
          requestId: "deadline",
          toolName: "Read",
          summary: "fixture",
          description: "",
          risk: "low",
          expiresAt,
          ...(multiple
            ? {
                roomId: "room",
                questions: [
                  { question: "A?", options: ["Yes"], multiSelect: false },
                  { question: "B?", options: ["Yes"], multiSelect: false },
                ],
              }
            : {}),
        }}
      />,
    );
    expect(markup).toContain("请在");
    expect(markup).toContain(new Date(expiresAt).toLocaleTimeString());
    expect(markup).toContain("超时后需要重新发起");
  },
);

test("CLI composer blocks both settings during pending work and uses confirmed values", () => {
  const room = {
    id: "cli-room",
    name: "Long CLI title",
    cwd: "/repo",
    kind: "codex" as const,
    permissionMode: "default" as const,
    modelKey: "codex/current",
    createdAt: 1,
    lastActiveAt: 1,
    open: true,
    observing: false,
    sessionId: "thread",
  };
  const app = remoteApp({
    activeRoomId: room.id,
    activeRoom: room,
    ccRoomModelSelection: true,
    setCcRoomPermissionMode: noop,
    setCcRoomModel: noop,
  });
  expect(cliSessionControlBlock(app)).toBeUndefined();
  const cases: Partial<RemoteApp>[] = [
    { status: "offline" },
    { activeRoom: undefined },
    { activeRoom: { ...room, observing: true } },
    { chat: { ...app.chat, run: "running" } },
    { loading: { ...app.loading, roomHistory: true } },
    { ccModeRequest: { switching: true, mode: "default", modelKey: "codex/next" } },
    {
      approvals: [
        {
          roomId: room.id,
          requestId: "approval",
          toolName: "Read",
          summary: "test",
          description: "",
          risk: "low",
        },
      ],
    },
  ];
  for (const patch of cases) {
    const current = { ...app, ...patch };
    expect(cliSessionControlBlock(current)).toBeTruthy();
    const permissions = renderToStaticMarkup(<DesktopChatControls app={current} />);
    expect(permissions).toMatch(/<button[^>]*disabled=""/);
    const model = renderToStaticMarkup(<DesktopCliModelPicker app={current} />);
    expect(model).toMatch(/<button[^>]*disabled=""/);
    if (current.activeRoom) expect(model).toContain('value="codex/current"');
  }
  const oldHost = renderToStaticMarkup(
    <DesktopCliModelPicker app={{ ...app, ccRoomModelSelection: false }} />,
  );
  expect(oldHost).toContain("更新电脑端后");
  expect(oldHost).toMatch(/<button[^>]*disabled=""/);
  const metadata = renderToStaticMarkup(
    <DesktopCliModelPicker app={{ ...app, activeRoom: undefined }} />,
  );
  expect(metadata).not.toContain("模型设置");
  expect(metadata).toContain("正在读取模型");
});

test("CLI sidebar distinguishes unknown counts and marks the active CLI thread", () => {
  const app = remoteApp({
    activeProjectCwd: "/repo",
    ccCliKind: "codex",
    ccProbe: { available: true },
    activeRoomId: "room",
    activeRoom: {
      id: "room",
      name: "Known",
      cwd: "/repo",
      kind: "codex",
      permissionMode: "default",
      createdAt: 1,
      lastActiveAt: 1,
      open: true,
      observing: false,
      sessionId: "known",
    },
    ccSessions: [
      { sessionId: "known", cwd: "/repo", firstMessage: "Known", lastModified: 1, messageCount: 6 },
      { sessionId: "unknown", cwd: "/repo", firstMessage: "Unknown", lastModified: 1 },
    ],
  });
  const markup = renderToStaticMarkup(
    <DesktopSidebar app={app} navigation={{ guard: noop, conversation: noop }} />,
  );
  expect(markup).toContain('aria-current="page"');
  expect(markup).toContain('class="session active"');
  expect(markup).toContain("6 条消息");
  expect(markup).not.toContain("0 条消息");
  expect(markup).not.toContain("undefined");
});

test("CLI rooms needing attention show badges, a jump list and a cross-room approval target", async () => {
  const opened: unknown[][] = [];
  const kinds: string[] = [];
  const waiting = {
    roomId: "room-wait",
    kind: "codex" as const,
    sessionId: "known",
    cwd: "/repo",
    name: "Waiting room",
    permissionMode: "acceptEdits" as const,
    unread: true,
    approvalIds: ["a-1", "a-2"],
  };
  const app = remoteApp({
    activeProjectCwd: "/repo",
    ccCliKind: "codex",
    ccProbe: { available: true },
    ccSessions: [
      { sessionId: "known", cwd: "/repo", firstMessage: "Known", lastModified: 1 },
      { sessionId: "quiet", cwd: "/repo", firstMessage: "Quiet", lastModified: 1 },
    ],
    roomAttention: [
      waiting,
      {
        ...waiting,
        roomId: "room-unread",
        sessionId: "other",
        name: "Unread room",
        approvalIds: [],
      },
    ],
    setCcCliKind: (kind) => void kinds.push(kind),
    openCcSession: (...args) => void opened.push(args),
  });
  const markup = renderToStaticMarkup(
    <DesktopSidebar app={app} navigation={{ guard: noop, conversation: noop }} />,
  );
  expect(markup).toContain("2 个 CLI 会话需要处理");
  expect(markup).toContain("Waiting room");
  expect(markup).toContain("Codex · 2 项待审批");
  expect(markup).toContain("Unread room");
  expect(markup).toContain("Codex · 有新消息");
  // The matching discovered session row carries the same badge.
  expect(markup.match(/2 项待审批/g)).toHaveLength(2);

  const hook = await renderHook(() => useDesktopController(app, undefined, noop));
  try {
    const target = hook.result.current.approvals.find((item) => item.label === "Waiting room");
    expect(target).toEqual({ id: "a-1", sessionId: "room:room-wait", label: "Waiting room" });
    await act(async () => {
      hook.result.current.selectSession(target!.sessionId!);
    });
    expect(kinds).toEqual(["codex"]);
    expect(opened).toEqual([["known", "/repo", "acceptEdits", "codex"]]);
  } finally {
    await hook.unmount();
  }
});

test("an observed CLI session offers take-over with a confirm step and shows the Host refusal", async () => {
  const room = {
    id: "room-observed",
    name: "Observed",
    cwd: "/repo",
    kind: "codex" as const,
    permissionMode: "default" as const,
    createdAt: 1,
    lastActiveAt: 1,
    open: false,
    observing: true,
    sessionId: "thread",
  };
  let takeOvers = 0;
  const app = remoteApp({
    status: "online",
    activeRoomId: room.id,
    activeRoom: room,
    takeOverCcRoom: () => void takeOvers++,
    ccTakeOverError: "无法接管：该外部会话正由后台任务使用",
  });
  const hook = await renderHook(() => useDesktopController(app, undefined, noop));
  try {
    expect(hook.result.current.readOnly).toBe(true);
    expect(hook.result.current.readOnlyNote).toContain("继续前需要明确接管");
    const markup = renderToStaticMarkup(<>{hook.result.current.readOnlyAction}</>);
    expect(markup).toContain("继续对话 / 接管");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("正由后台任务使用");
  } finally {
    await hook.unmount();
  }
  // The confirm step explains the handoff before anything is sent.
  ensureMiniDom();
  const container = document.createElement("div");
  const root = createRoot(container);
  const button = (label: string) =>
    elementsByTag(container, "BUTTON").find((node) => textOf(node) === label);
  try {
    await act(async () => {
      root.render(<DesktopTakeOver app={app} />);
      await flushMicrotasks();
    });
    await act(async () => {
      reactProps(button("继续对话 / 接管")).onClick();
      await flushMicrotasks();
    });
    expect(takeOvers).toBe(0);
    expect(textOf(container)).toContain("逐次确认");
    expect(textOf(container)).toContain("Codex");
    await act(async () => {
      reactProps(button("确认接管")).onClick();
      await flushMicrotasks();
    });
    expect(takeOvers).toBe(1);
  } finally {
    await act(async () => root.unmount());
  }
  // A writable room has nothing to take over.
  expect(
    renderToStaticMarkup(
      <DesktopTakeOver
        app={remoteApp({ activeRoom: { ...room, observing: false, open: true } })}
      />,
    ),
  ).toBe("");
});

test("a subagent row in the parent feed opens its read-only detail, and back returns", async () => {
  ensureMiniDom();
  const previousMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true }), // narrow phone layout
  });
  browserRestores.push(() =>
    previousMatchMedia
      ? Object.defineProperty(window, "matchMedia", previousMatchMedia)
      : Reflect.deleteProperty(window, "matchMedia"),
  );
  const calls: unknown[][] = [];
  const subagents = {
    view: undefined as RemoteApp["subagents"] extends infer T
      ? T extends { view: infer V }
        ? V
        : never
      : never,
    open: (...args: unknown[]) => void calls.push(["open", ...args]),
    select: (id: string) => void calls.push(["select", id]),
    openRoomAgent: noop,
    back: () => void calls.push(["back"]),
    close: noop,
    refresh: noop,
    observe: noop,
  };
  const chat = {
    ...initialChatState(),
    items: [
      { kind: "assistant" as const, id: "a1", text: "parent text", reasoning: "", done: true },
      {
        kind: "subagent" as const,
        id: "sub-child",
        agentId: "child",
        label: "Explorer",
        status: "running",
        toolCount: 2,
      },
    ],
  };
  const parent = remoteApp({ activeSessionId: "parent", chat, subagents });
  const hook = await renderHook(() => useDesktopController(parent, undefined, noop));
  try {
    const markup = renderToStaticMarkup(<Workbench controller={hook.result.current} />);
    expect(markup).toContain('aria-label="查看子代理 Explorer"');
    expect(markup).toContain("2 次工具调用");
    expect(markup).toContain("子代理 · 1");
    expect(markup).not.toContain('data-subagent-view="detail"');
    hook.result.current.openSubagent!("child");
    expect(calls).toEqual([["open", "parent", "child"]]);
  } finally {
    await hook.unmount();
  }

  subagents.view = {
    kind: "session",
    trail: [],
    parentSessionId: "parent",
    selectedId: "child",
    catalog: [{ sessionId: "child", title: "Explorer", status: "active" }],
    listLoading: false,
    transcriptLoading: false,
    transcript: {
      ...initialChatState(),
      items: [{ kind: "assistant", id: "c1", text: "child prose", reasoning: "", done: true }],
    },
  };
  const detailApp = remoteApp({ activeSessionId: "parent", chat, subagents });
  const detailHook = await renderHook(() => useDesktopController(detailApp, undefined, noop));
  try {
    const markup = renderToStaticMarkup(<Workbench controller={detailHook.result.current} />);
    expect(markup).toContain('data-subagent-view="detail"');
    expect(markup).toContain("child prose");
    expect(markup).toContain("返回列表");
  } finally {
    await detailHook.unmount();
  }

  ensureMiniDom();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<SubagentView app={detailApp} />);
      await flushMicrotasks();
    });
    const back = elementsByTag(container, "BUTTON").find((node) => textOf(node) === "返回列表");
    await act(async () => {
      reactProps(back).onClick();
      await flushMicrotasks();
    });
    expect(calls.at(-1)).toEqual(["back"]);
    // The list groups children like Desktop's subagent panel.
    subagents.view = { ...subagents.view!, selectedId: undefined } as never;
    await act(async () => {
      root.render(<SubagentView app={{ ...detailApp, subagents: { ...subagents } }} />);
      await flushMicrotasks();
    });
    expect(textOf(container)).toContain("运行中 · 1");
    const child = elementsByTag(container, "BUTTON").find((node) =>
      textOf(node).includes("Explorer"),
    );
    await act(async () => {
      reactProps(child).onClick();
      await flushMicrotasks();
    });
    expect(calls.at(-1)).toEqual(["select", "child"]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a restored CLI approval card shows why the last response failed", () => {
  const markup = renderToStaticMarkup(
    <DesktopApproval
      approval={{
        requestId: "a-1",
        roomId: "room",
        toolName: "Bash",
        description: "",
        summary: "ls",
        risk: "low",
        pathScoped: false,
        error: "bridge unavailable",
      }}
      app={remoteApp({ status: "online" })}
    />,
  );
  expect(markup).toContain('role="alert"');
  expect(markup).toContain("上次回复没有送达：bridge unavailable");
  expect(markup).toContain("允许");
});

test("CLI settings handoff keeps editable drafts and the sidebar while blocking submission", async () => {
  const sent: unknown[] = [];
  const room = {
    id: "r",
    name: "CLI",
    cwd: "/repo",
    kind: "codex" as const,
    permissionMode: "default" as const,
    createdAt: 1,
    lastActiveAt: 1,
    open: true,
    observing: false,
    sessionId: "t",
  };
  let app = remoteApp({
    activeRoomId: room.id,
    activeRoom: room,
    activeCwd: "/repo",
    activeProjectCwd: "/repo",
    ccModeRequest: { switching: true, mode: "default", modelKey: "codex/next" },
    sendChat: async (input) => {
      sent.push(input);
      return true;
    },
  });
  const hook = await renderHook(() => useDesktopController(app, undefined, noop));
  try {
    await act(async () => {
      hook.result.current.setDraft("keep this draft");
    });
    expect(hook.result.current.sendBlockedReason).toContain("正在应用 CLI 设置");
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.readOnly).toBeFalsy();
    await act(async () => {
      expect(hook.result.current.send()).toBe(false);
    });
    expect(sent).toHaveLength(0);
    expect(hook.result.current.draft).toBe("keep this draft");
    app = { ...app, ccModeRequest: undefined };
    await hook.rerender();
    expect(hook.result.current.sendBlockedReason).toBeUndefined();
    expect(hook.result.current.draft).toBe("keep this draft");
  } finally {
    await hook.unmount();
  }
});

const newChatProjects = [
  { id: "p-1", name: "codeshell", path: "/repo/codeshell" },
  { id: "p-2", name: "panels", path: "/repo/panels" },
];

function newChatApp(patch: Partial<RemoteApp> = {}): RemoteApp {
  return {
    status: "online",
    chat: initialChatState(),
    sessions: [],
    projects: newChatProjects,
    permissionMode: "default",
    loading: { sessions: false, sessionHistory: false, roomHistory: false, ccSessions: false },
    ...patch,
  } as unknown as RemoteApp;
}

test("a new conversation shows a project picker; one with turns does not", () => {
  const fresh = renderToStaticMarkup(<DesktopChatControls app={newChatApp()} projectId="p-1" />);
  expect(fresh).toContain("desktop-new-chat-project");
  expect(fresh).toContain("codeshell");
  const started = renderToStaticMarkup(
    <DesktopChatControls
      app={newChatApp({
        chat: {
          ...initialChatState(),
          items: [{ id: "m1", kind: "user", text: "hi" }],
        } as RemoteApp["chat"],
      })}
      projectId="p-1"
    />,
  );
  expect(started).not.toContain("desktop-new-chat-project");
  // Adapters that do not pass the workspace keep the previous controls.
  expect(renderToStaticMarkup(<DesktopChatControls app={newChatApp()} />)).not.toContain(
    "desktop-new-chat-project",
  );
});

test("each project heading starts a conversation in that project", async () => {
  ensureMiniDom();
  const started: Array<[string | null, string | null]> = [];
  const row = (sessionId: string, cwd: string) =>
    ({
      sessionId,
      cwd,
      title: sessionId,
      startedAt: 1,
      lastActiveAt: 1,
      status: "completed",
      turnCount: 1,
    }) as SessionSummary;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ProjectSessionNavigation
        sessions={[row("a", "/repo/codeshell"), row("b", "")]}
        projects={newChatProjects}
        activeId=""
        renderSession={(session) => <li key={session.sessionId}>{session.sessionId}</li>}
        onNewSession={(target, cwd) => started.push([target, cwd])}
      />,
    );
  });
  const buttons = elementsByTag(container, "BUTTON").filter((button) =>
    String(reactProps(button)["aria-label"] ?? "").includes("中新建对话"),
  );
  expect(buttons).toHaveLength(2);
  await act(async () => {
    for (const button of buttons) reactProps(button).onClick();
  });
  expect(started).toEqual([
    ["p-1", "/repo/codeshell"],
    [null, null],
  ]);
  await act(async () => root.unmount());
});

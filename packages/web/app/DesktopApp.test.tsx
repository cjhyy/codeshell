import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../src/test-utils/renderHook.js";
import { initialChatState } from "../src/lib/streamReducer.js";
import type { RemoteApp } from "../src/hooks/useRemoteApp.js";
import { useDesktopController } from "./DesktopApp.js";
import { getApiWorkspace } from "./api-context.js";
import { Workbench } from "./Workbench.js";
import { DesktopApproval, DesktopChatControls, DesktopSidebar } from "./DesktopControls.js";
import { DesktopModelPicker } from "./DesktopModelPicker.js";

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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Desktop workbench controller", () => {
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
      { text: "first task", attachments: [], onUncertain: expect.any(Function) },
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
    await act(async () => {
      hook.result.current.selectSession(originalId);
    });
    expect(hook.result.current.workspaceCwd).toBe("/project-a");
    expect(created.at(-1)).toEqual({ projectId: "a" });
    expect(hook.result.current.draft).toBe("belongs to project A");
    await hook.unmount();
  });

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
    const hub = renderToStaticMarkup(
      <Workbench
        controller={{
          ...hook.result.current,
          host: "hub",
          session,
          workspaceApi: true,
          renderSidebar: undefined,
          chatControls: undefined,
          cameraAttachments: false,
        }}
      />,
    );
    for (const html of [desktop, hub]) {
      expect(html).toContain('class="workbench');
      expect(html).toContain("Skills");
      expect(html).toContain("Link");
      expect(html).toContain('aria-label="任务内容"');
    }
    expect(desktop).toContain('aria-label="选择项目"');
    expect(desktop).toContain('aria-label="拍照"');
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
  expect(inRoom).toMatch(/<select[^>]*disabled=""/);
  expect(inRoom).toContain('<option value="bypassPermissions" selected="">');
  expect(inRoom).not.toContain('<option value="default" selected="">');
  // Metadata not loaded yet: show no mode rather than the stricter native one.
  const pending = markup({ activeRoomId: room.id, permissionMode: "default" });
  expect(pending).toMatch(/<select[^>]*disabled=""/);
  expect(pending).not.toContain('<option value="default" selected="">');
  const native = markup({ permissionMode: "acceptEdits" });
  expect(native).not.toMatch(/<select[^>]*disabled=""/);
  expect(native).toContain('<option value="acceptEdits" selected="">');
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

test("the mobile model selector exposes both external providers and a saved unavailable model", () => {
  const html = renderToStaticMarkup(
    <DesktopModelPicker
      models={runtimeModels}
      value="codex/old-saved"
      defaultLabel="Default"
      disabled={false}
      onChange={noop}
    />,
  );
  expect(html).toContain('label="Codex"');
  expect(html).toContain('label="Claude Code"');
  expect(html).toContain('value="codex/old-saved" selected=""');
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

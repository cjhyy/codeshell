import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../src/test-utils/renderHook.js";
import { initialChatState } from "../src/lib/streamReducer.js";
import type { RemoteApp } from "../src/hooks/useRemoteApp.js";
import { useDesktopController } from "./DesktopApp.js";
import { getApiWorkspace } from "./api-context.js";
import { Workbench } from "./Workbench.js";
import { DesktopApproval, DesktopSidebar } from "./DesktopControls.js";

const noop = () => {};
const session = { id: "paired-session", username: "synthetic", deviceName: "Fixture" };
function remoteApp(patch: Partial<RemoteApp> = {}): RemoteApp {
  return {
    status: "online",
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
    expect(sent).toEqual([{ text: "first task", attachments: [] }]);
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

  test("failed send restores untouched text and images but never overwrites later edits", async () => {
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
    expect(hook.result.current.draft).toBe("replacement");
    expect(hook.result.current.files).toHaveLength(0);
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

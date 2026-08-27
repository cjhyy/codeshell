import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import type { RendererConfigurationTarget, SessionWorkspaceAuthority } from "../preload/types";
import type { ModelOption } from "./chat/ModelPill";
import type { PermissionMode } from "./chat/PermissionPill";

interface ChatProps {
  compacting?: boolean;
  onCompactCommand?: () => void;
  activeProjectId?: string | null;
  activeModelKey?: string | null;
  modelOptions?: ModelOption[];
  permissionMode?: PermissionMode | null;
  imageDetail?: "low" | "standard" | "high";
  configurationTarget?: RendererConfigurationTarget;
  configurationAvailable?: boolean;
  conversationRoot?: string | null;
  conversationRootId?: string | null;
  conversationRootStatus?: SessionWorkspaceAuthority["rootStatus"] | "loading" | "unavailable";
  onPrepareAttachmentSession?: () => { cwd: string; sessionId: string } | null;
}

let chatProps: ChatProps | null = null;
let topBarProps: Record<string, any> | null = null;
let sidebarProps: Record<string, any> | null = null;

mock.module("./ChatView", () => ({
  ChatView(props: ChatProps) {
    chatProps = props;
    return (
      <div>
        <textarea data-testid="composer" disabled={props.compacting === true} />
        <button type="button" data-testid="compact" onClick={() => props.onCompactCommand?.()}>
          /compact
        </button>
      </div>
    );
  },
}));

mock.module("./app/AppSidebar", () => ({
  Sidebar: (props: Record<string, any>) => {
    sidebarProps = props;
    return <div data-testid="sidebar" />;
  },
}));
mock.module("./TopBar", () => ({
  TopBar: (props: Record<string, any>) => {
    topBarProps = props;
    return <div data-testid="topbar" />;
  },
}));
mock.module("./panels/PanelArea", () => ({ PanelArea: () => <div data-testid="panel" /> }));
mock.module("./workspace-trust/TrustGate", () => ({ TrustGate: () => null }));
mock.module("./shell/SearchBar", () => ({ SearchBar: () => <div data-testid="search" /> }));
mock.module("./shell/CommandPalette", () => ({
  CommandPalette: () => <div data-testid="palette" />,
  buildCommands: () => [],
}));
mock.module("./shell/SessionSearchModal", () => ({
  SessionSearchModal: () => <div data-testid="session-search" />,
}));
const { App } = await import("./App");

class MemoryLocalStorage {
  private readonly store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElement(
  node: unknown,
  predicate: (node: { tagName?: string; childNodes?: unknown[] }) => boolean,
): { tagName?: string; childNodes?: unknown[] } | null {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  if (predicate(current)) return current;
  for (const child of current.childNodes ?? []) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

const localStorageMock = new MemoryLocalStorage();
const compactCalls: string[] = [];
const compactResponses: Array<ReturnType<typeof deferred<unknown>>> = [];
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

function restoreGlobalProperty(
  key: "localStorage" | "window",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }
  delete (globalThis as Record<string, unknown>)[key];
}

function seedActiveSession(): void {
  localStorageMock.setItem(
    "codeshell.repos",
    JSON.stringify([{ id: "repoA", name: "Repo A", path: "/tmp/repo-a", addedAt: 1 }]),
  );
  localStorageMock.setItem("codeshell.activeRepoId", "repoA");
  localStorageMock.setItem(
    "codeshell.view",
    JSON.stringify({ viewMode: "chat", sidebarCollapsed: true, inspectorCollapsed: false }),
  );
  localStorageMock.setItem(
    "codeshell.sessionIndex.repoA",
    JSON.stringify({
      activeSessionId: "session-a",
      sessions: [
        {
          id: "session-a",
          engineSessionId: "engine-a",
          title: "Session A",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    }),
  );
}

function installCodeshellStub(): void {
  const unsubscribe = () => undefined;
  const project = {
    id: "repoA",
    name: "Repo A",
    roots: [{ id: "root-a", path: "/tmp/repo-a", name: "Repo A", addedAt: 1 }],
    primaryRootId: "root-a",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    revision: 1,
  };
  (window as unknown as { codeshell: Record<string, any>; innerWidth: number }).innerWidth = 1200;
  (window as unknown as { codeshell: Record<string, any> }).codeshell = {
    platform: "linux",
    log: () => undefined,
    isWindowFullscreen: async () => false,
    onWindowFullscreenChange: () => unsubscribe,
    projectRegistry: {
      list: async () => [project],
      beginLegacyMigration: async () => ({ completed: true }),
      authorizeLegacyMigration: async () => ({ status: "migrated" }),
      completeLegacyMigration: async () => undefined,
      resolveForCwdBatch: async () => [],
      onChanged: () => unsubscribe,
    },
    mobileRemote: {
      updatePermissionModes: async () => undefined,
      notifyApprovalResolved: async () => undefined,
    },
    noRepoCwd: async () => "/tmp",
    configure: async () => undefined,
    registerBrowserSessionBucket: () => undefined,
    setGitPrefs: async () => undefined,
    getProjectGitStatus: async () => ({ branch: "main", entries: [], clean: true }),
    getSessionGitStatus: async () => ({ branch: "main", entries: [], clean: true }),
    getProjectGitBranches: async () => ({ isRepo: true, current: "main", branches: ["main"] }),
    getSessionWorkspace: async () => ({ root: "/tmp/repo-a", kind: "main" }),
    listSessionWorktrees: async () => ({
      current: { root: "/tmp/repo-a", kind: "main" },
      mainRoot: "/tmp/repo-a",
      worktrees: [
        {
          path: "/tmp/repo-a",
          branch: "main",
          head: "abc123",
          isMain: true,
        },
      ],
    }),
    getSessionWorktreeDiff: async () => ({
      changedFiles: 0,
      aheadCommits: 0,
      hasUncommittedChanges: false,
    }),
    getSessionTranscript: async () => [],
    subscribeSession: async () => ({ entries: [], nextSeq: 0 }),
    goalGet: async () => ({ goal: null }),
    listRuns: async () => [],
    listDiskSessions: async () => ({ sessions: [], nextCursor: null }),
    onStreamEvent: () => unsubscribe,
    onAutomationSession: () => unsubscribe,
    onMobileSession: () => unsubscribe,
    onApprovalRequest: () => unsubscribe,
    onApprovalResolved: () => unsubscribe,
    onMobilePermissionMode: () => unsubscribe,
    onStatus: () => unsubscribe,
    onAgentLifecycle: () => unsubscribe,
    onWorktreeCleanupSkipped: () => unsubscribe,
    onBrowserAnchorFromPopout: () => unsubscribe,
    onBrowserAnchorRemoveFromPopout: () => unsubscribe,
    onBrowserAnchorUpdateFromPopout: () => unsubscribe,
    syncBrowserAnchors: () => undefined,
    onMenuEvent: () => unsubscribe,
    getSettings: async () => ({}),
    getModelCatalog: async () => [],
    resolveModelMeta: async () => [],
    setBadgeCount: async () => undefined,
    notify: async () => undefined,
    compactSession: (sessionId: string) => {
      compactCalls.push(sessionId);
      const next = deferred<unknown>();
      compactResponses.push(next);
      return next.promise;
    },
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

afterAll(() => {
  mock.restore();
});

beforeEach(async () => {
  ensureMiniDom();
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: localStorageMock,
    configurable: true,
    writable: true,
  });
  localStorageMock.clear();
  seedActiveSession();
  compactCalls.length = 0;
  compactResponses.length = 0;
  chatProps = null;
  topBarProps = null;
  sidebarProps = null;
  installCodeshellStub();
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root?.render(<App />);
    await flushMicrotasks();
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
  container = null;
  localStorageMock.clear();
  restoreGlobalProperty("localStorage", originalLocalStorageDescriptor);
  restoreGlobalProperty("window", originalWindowDescriptor);
});

describe("App compact session UI", () => {
  test("disables the composer, ignores duplicate compact commands, and clears after failure", async () => {
    expect(chatProps?.compacting).toBe(false);
    const composer = findElement(container, (node) => node.tagName === "TEXTAREA");
    expect(composer).not.toBeNull();
    expect(reactPropsOf(composer).disabled).toBe(false);

    await act(async () => {
      chatProps?.onCompactCommand?.();
      chatProps?.onCompactCommand?.();
      await flushMicrotasks();
    });

    expect(compactCalls).toEqual(["engine-a"]);
    expect(chatProps?.compacting).toBe(true);
    expect(reactPropsOf(composer).disabled).toBe(true);

    await act(async () => {
      compactResponses[0]?.reject(new Error("compact failed"));
      await flushMicrotasks();
    });

    expect(chatProps?.compacting).toBe(false);
    expect(reactPropsOf(composer).disabled).toBe(false);
  });

  test("keeps every Session UI/config consumer on its authoritative root after Make primary", async () => {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
    root = null;
    container = null;
    localStorageMock.clear();

    const fixtureRoot = mkdtempSync(join(tmpdir(), "codeshell-session-ui-authority-"));
    const oldRoot = join(fixtureRoot, "old-git-root");
    const newRoot = join(fixtureRoot, "new-plain-root");
    const writeRoot = (
      cwd: string,
      fixture: {
        model: string;
        permissionMode: string;
        imageDetail: string;
        profile: string;
        pluginCommand: string;
        skill: string;
        relativeFile: string;
      },
    ): void => {
      mkdirSync(join(cwd, ".code-shell"), { recursive: true });
      writeFileSync(
        join(cwd, ".code-shell", "settings.json"),
        JSON.stringify({
          defaults: { text: fixture.model },
          permissionMode: fixture.permissionMode,
          images: { detail: fixture.imageDetail },
          modelConnections: [
            {
              id: fixture.model,
              catalogId: "fixture-provider",
              tag: "text",
              model: fixture.model,
            },
          ],
        }),
      );
      writeFileSync(join(cwd, ".code-shell", "profiles.json"), JSON.stringify([fixture.profile]));
      writeFileSync(
        join(cwd, ".code-shell", "plugin-commands.json"),
        JSON.stringify([fixture.pluginCommand]),
      );
      writeFileSync(join(cwd, ".code-shell", "skills.json"), JSON.stringify([fixture.skill]));
      writeFileSync(join(cwd, "same-relative.md"), fixture.relativeFile);
    };
    writeRoot(oldRoot, {
      model: "old-model",
      permissionMode: "bypass",
      imageDetail: "high",
      profile: "old-profile",
      pluginCommand: "old:review",
      skill: "old-skill",
      relativeFile: "old relative file",
    });
    mkdirSync(join(oldRoot, ".git"));
    writeRoot(newRoot, {
      model: "new-model",
      permissionMode: "plan",
      imageDetail: "low",
      profile: "new-profile",
      pluginCommand: "new:review",
      skill: "new-skill",
      relativeFile: "new relative file",
    });

    try {
      const project = {
        id: "repoA",
        name: "Two Roots",
        roots: [
          { id: "old-root", path: oldRoot, name: "old", addedAt: 1 },
          { id: "new-root", path: newRoot, name: "new", addedAt: 2 },
        ],
        primaryRootId: "old-root",
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1,
        revision: 1,
      };
      localStorageMock.setItem(
        "codeshell.repos",
        JSON.stringify([
          {
            id: project.id,
            name: project.name,
            path: oldRoot,
            roots: project.roots,
            primaryRootId: project.primaryRootId,
            addedAt: 1,
          },
        ]),
      );
      localStorageMock.setItem("codeshell.activeRepoId", project.id);
      localStorageMock.setItem(
        "codeshell.view",
        JSON.stringify({ viewMode: "chat", sidebarCollapsed: false, inspectorCollapsed: false }),
      );
      localStorageMock.setItem(
        "codeshell.sessionIndex.repoA",
        JSON.stringify({
          activeSessionId: "session-old",
          sessions: [
            {
              id: "session-old",
              engineSessionId: "engine-old",
              title: "Old Session",
              workspaceProfile: "old-profile",
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        }),
      );

      installCodeshellStub();
      let registryListener: ((projects: any[]) => void) | null = null;
      let workspaceListener: ((event: { sessionId: string }) => void) | null = null;
      let oldSessionRootStatus: "ok" | "root_removed" = "ok";
      let oldSessionMainRootId = "old-root";
      const configurationCalls: RendererConfigurationTarget[] = [];
      const profileCalls: RendererConfigurationTarget[] = [];
      const resolveTargetRoot = (target: RendererConfigurationTarget): string => {
        if ("sessionId" in target) {
          return target.sessionId === "engine-old" && oldSessionMainRootId === "old-root"
            ? oldRoot
            : newRoot;
        }
        if ("projectId" in target) {
          return project.primaryRootId === "old-root" ? oldRoot : newRoot;
        }
        throw new Error("unexpected no-repo target");
      };
      const readJson = <T,>(cwd: string, name: string): T =>
        JSON.parse(readFileSync(join(cwd, ".code-shell", name), "utf8")) as T;
      Object.assign(window.codeshell, {
        projectRegistry: {
          list: async () => [project],
          beginLegacyMigration: async () => ({ completed: true }),
          authorizeLegacyMigration: async () => ({ status: "migrated" }),
          completeLegacyMigration: async () => undefined,
          resolveForCwdBatch: async () => [],
          onChanged: (listener: (projects: any[]) => void) => {
            registryListener = listener;
            return () => undefined;
          },
        },
        externalRuntime: { available: async () => [] },
        getSessionWorkspaceAuthority: async (sessionId: string) =>
          sessionId === "engine-old" && oldSessionRootStatus !== "ok"
            ? {
                workspace: { root: oldRoot, kind: "main" as const },
                projectId: project.id,
                mainRootId: oldSessionMainRootId,
                mainRoot: oldRoot,
                mainRootName: "old",
                rootStatus: oldSessionRootStatus,
                rootStatusReason: "root_not_mounted" as const,
                rootStatusMessage: "old Session root was removed",
              }
            : {
                workspace: {
                  root:
                    sessionId === "engine-old" && oldSessionMainRootId === "old-root"
                      ? oldRoot
                      : newRoot,
                  kind: "main" as const,
                },
                projectId: project.id,
                mainRootId: sessionId === "engine-old" ? oldSessionMainRootId : "new-root",
                mainRoot:
                  sessionId === "engine-old" && oldSessionMainRootId === "old-root"
                    ? oldRoot
                    : newRoot,
                mainRootName:
                  sessionId === "engine-old" && oldSessionMainRootId === "old-root" ? "old" : "new",
                rootStatus: "ok" as const,
              },
        onWorkspaceChanged: (listener: (event: { sessionId: string }) => void) => {
          workspaceListener = listener;
          return () => undefined;
        },
        getConfigurationSettings: async (target: RendererConfigurationTarget) => {
          configurationCalls.push(target);
          return readJson<Record<string, unknown>>(resolveTargetRoot(target), "settings.json");
        },
        listProfiles: async (target: RendererConfigurationTarget) => {
          profileCalls.push(target);
          return readJson<string[]>(resolveTargetRoot(target), "profiles.json").map((name) => ({
            name,
            label: name,
            description: undefined,
            basePreset: "general",
            plugins: [],
            skills: [],
            mcp: [],
            agents: [],
            mainInstruction: undefined,
            active: false,
            portableMemory: false,
            exclusiveCapabilities: false,
            version: undefined,
          }));
        },
        listPluginCommands: async (target: RendererConfigurationTarget) =>
          readJson<string[]>(resolveTargetRoot(target), "plugin-commands.json"),
        listSkills: async (target: RendererConfigurationTarget) =>
          readJson<string[]>(resolveTargetRoot(target), "skills.json"),
        getModelCatalog: async () => [
          {
            id: "fixture-provider",
            displayName: "Fixture",
            modelPresets: [],
          },
        ],
      });

      container = document.createElement("div");
      root = createRoot(container);
      await act(async () => {
        root?.render(<App />);
        await flushMicrotasks();
      });

      expect(chatProps?.configurationTarget).toEqual({ sessionId: "engine-old" });
      expect(chatProps?.configurationAvailable).toBe(true);
      expect(chatProps?.conversationRoot).toBe(oldRoot);
      expect(chatProps?.conversationRootId).toBe("old-root");
      expect(chatProps?.conversationRootStatus).toBe("ok");
      expect(chatProps?.activeModelKey).toBe("old-model");
      expect(chatProps?.modelOptions?.map((option) => option.key)).toEqual(["old-model"]);
      expect(chatProps?.permissionMode).toBe("bypass");
      expect(chatProps?.imageDetail).toBe("high");
      expect(topBarProps?.workspaceProfiles).toEqual([
        { name: "old-profile", label: "old-profile" },
      ]);
      expect(topBarProps?.projectPath).toBe(oldRoot);
      expect(readFileSync(join(chatProps!.conversationRoot!, "same-relative.md"), "utf8")).toBe(
        "old relative file",
      );
      expect(await window.codeshell.listPluginCommands(chatProps!.configurationTarget!)).toEqual([
        "old:review",
      ]);
      expect(await window.codeshell.listSkills(chatProps!.configurationTarget!)).toEqual([
        "old-skill",
      ]);

      project.primaryRootId = "new-root";
      project.updatedAt = 2;
      project.revision = 2;
      await act(async () => {
        registryListener?.([project]);
        await flushMicrotasks();
      });

      expect(chatProps?.configurationTarget).toEqual({ sessionId: "engine-old" });
      expect(chatProps?.conversationRoot).toBe(oldRoot);
      expect(chatProps?.conversationRootId).toBe("old-root");
      expect(chatProps?.conversationRootStatus).toBe("ok");
      expect(chatProps?.activeModelKey).toBe("old-model");
      expect(topBarProps?.workspaceProfiles).toEqual([
        { name: "old-profile", label: "old-profile" },
      ]);
      expect(topBarProps?.projectPath).toBe(oldRoot);
      expect(configurationCalls.at(-1)).toEqual({ sessionId: "engine-old" });
      expect(profileCalls.at(-1)).toEqual({ sessionId: "engine-old" });

      const configurationCallCount = configurationCalls.length;
      const profileCallCount = profileCalls.length;
      oldSessionRootStatus = "root_removed";
      await act(async () => {
        workspaceListener?.({ sessionId: "engine-old" });
        await flushMicrotasks();
      });
      expect(chatProps?.configurationAvailable).toBe(false);
      expect(chatProps?.conversationRoot).toBeNull();
      expect(chatProps?.conversationRootId).toBe("old-root");
      expect(chatProps?.conversationRootStatus).toBe("root_removed");
      expect(chatProps?.activeModelKey).toBeNull();
      expect(chatProps?.modelOptions).toEqual([]);
      expect(topBarProps?.workspaceProfiles).toEqual([]);
      expect(topBarProps?.projectPath).toBeNull();
      expect(configurationCalls).toHaveLength(configurationCallCount);
      expect(profileCalls).toHaveLength(profileCallCount);

      oldSessionRootStatus = "ok";
      oldSessionMainRootId = "new-root";
      await act(async () => {
        workspaceListener?.({ sessionId: "engine-old" });
        await flushMicrotasks();
      });
      expect(chatProps?.configurationTarget).toEqual({ sessionId: "engine-old" });
      expect(chatProps?.configurationAvailable).toBe(true);
      expect(chatProps?.conversationRoot).toBe(newRoot);
      expect(chatProps?.conversationRootId).toBe("new-root");
      expect(chatProps?.conversationRootStatus).toBe("ok");
      expect(readFileSync(join(chatProps!.conversationRoot!, "same-relative.md"), "utf8")).toBe(
        "new relative file",
      );

      await act(async () => {
        sidebarProps?.onNewConversation?.();
        await flushMicrotasks();
      });

      expect(chatProps?.configurationTarget).toEqual({ projectId: project.id });
      expect(chatProps?.conversationRoot).toBe(newRoot);
      expect(chatProps?.conversationRootId).toBe("new-root");
      expect(chatProps?.activeModelKey).toBe("new-model");
      expect(chatProps?.permissionMode).toBe("plan");
      expect(chatProps?.imageDetail).toBe("low");
      expect(topBarProps?.workspaceProfiles).toEqual([
        { name: "new-profile", label: "new-profile" },
      ]);
      expect(topBarProps?.projectPath).toBe(newRoot);
      expect(readFileSync(join(chatProps!.conversationRoot!, "same-relative.md"), "utf8")).toBe(
        "new relative file",
      );
      expect(await window.codeshell.listPluginCommands(chatProps!.configurationTarget!)).toEqual([
        "new:review",
      ]);
      expect(await window.codeshell.listSkills(chatProps!.configurationTarget!)).toEqual([
        "new-skill",
      ]);

      let createdContext: { cwd: string; sessionId: string } | null = null;
      await act(async () => {
        createdContext = chatProps?.onPrepareAttachmentSession?.() ?? null;
        await flushMicrotasks();
      });
      expect(createdContext?.cwd).toBe(newRoot);
      expect(chatProps?.configurationTarget).toEqual({
        sessionId: createdContext?.sessionId,
      });
      expect(chatProps?.configurationAvailable).toBe(true);
      expect(chatProps?.conversationRoot).toBe(newRoot);
      expect(chatProps?.conversationRootId).toBe("new-root");
      expect(chatProps?.activeModelKey).toBe("new-model");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

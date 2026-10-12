import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import { saveProjects } from "./projects";
import { bucketKey } from "./transcripts";

type SendFn = (
  text: string,
  sendOpts?: { bucket?: string; clientMessageId?: string },
) => Promise<void> | void;

interface ChatProps {
  sendBucket?: string;
  onSend: SendFn;
}

let chatProps: ChatProps | null = null;

mock.module("./ChatView", () => ({
  ChatView(props: ChatProps) {
    chatProps = props;
    return React.createElement("div");
  },
}));

mock.module("./assets/codeshell-dog-icon.png", () => ({ default: "dog.png" }));
mock.module("./app/AppSidebar", () => ({ Sidebar: () => null }));
mock.module("./TopBar", () => ({ TopBar: () => null }));
mock.module("./panels/PanelArea", () => ({ PanelArea: () => null }));
mock.module("./workspace-trust/TrustGate", () => ({ TrustGate: () => null }));
mock.module("./shell/SearchBar", () => ({ SearchBar: () => null }));
mock.module("./shell/CommandPalette", () => ({
  CommandPalette: () => null,
  buildCommands: () => [],
}));
mock.module("./shell/SessionSearchModal", () => ({ SessionSearchModal: () => null }));
mock.module("./app/useAppPetSprite", () => ({ usePetSprite: () => "dog.png" }));

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

const localStorageMock = new MemoryLocalStorage();
const runCalls: Array<{ text: string; opts: Record<string, unknown> }> = [];
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
    cloudEnvironment: {
      listBindings: async () => [],
      getSelection: async (localProjectId: string) => ({ localProjectId, bindingId: null }),
      select: async () => undefined,
    },
    log: () => undefined,
    isWindowFullscreen: async () => false,
    onWindowFullscreenChange: () => unsubscribe,
    externalRuntime: {
      available: async () => [],
      models: async () => [],
      onSessionState: () => unsubscribe,
    },
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
    run: async (text: string, opts: Record<string, unknown>) => {
      runCalls.push({ text, opts });
      return { ok: true };
    },
  };
}

let root: Root | null = null;
let restoreWindowProperties: (() => void) | undefined;

async function renderApp(): Promise<void> {
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root?.render(<App />);
    await flushMicrotasks();
  });
}

const { App } = await import("./App");

describe("App send draft overrides", () => {
  afterAll(() => {
    mock.restore();
    restoreGlobalProperty("localStorage", originalLocalStorageDescriptor);
    restoreGlobalProperty("window", originalWindowDescriptor);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
        await flushMicrotasks();
      });
      root = null;
    }
    restoreWindowProperties?.();
    restoreWindowProperties = undefined;
    restoreGlobalProperty("localStorage", originalLocalStorageDescriptor);
  });

  beforeEach(() => {
    ensureMiniDom();
    const testWindow = window;
    const windowProperties = ["codeshell", "localStorage", "innerWidth"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(testWindow, key)] as const,
    );
    restoreWindowProperties = () => {
      for (const [key, descriptor] of windowProperties) {
        if (descriptor) Object.defineProperty(testWindow, key, descriptor);
        else delete (testWindow as unknown as Record<string, unknown>)[key];
      }
    };
    for (const target of [globalThis, window]) {
      Object.defineProperty(target, "localStorage", {
        value: localStorageMock,
        configurable: true,
        writable: true,
      });
    }
    installCodeshellStub();
    chatProps = null;
    runCalls.length = 0;
    localStorageMock.clear();
    saveProjects([
      {
        id: "repoA",
        name: "Repo A",
        path: "/tmp/repo-a",
        roots: [{ id: "root-a", path: "/tmp/repo-a", name: "Repo A", addedAt: 1 }],
        primaryRootId: "root-a",
        addedAt: 1,
      },
    ]);
  });

  test("passes the rendered session bucket to ChatView send callbacks", async () => {
    const repoId = "repoA";
    const sessionA = "session-a";
    const sessionB = "session-b";
    localStorageMock.setItem(
      "codeshell.repos",
      JSON.stringify([{ id: repoId, name: "Repo A", path: "/tmp/repo-a", addedAt: 1 }]),
    );
    localStorageMock.setItem("codeshell.activeRepoId", repoId);
    localStorageMock.setItem(
      "codeshell.view",
      JSON.stringify({ viewMode: "chat", sidebarCollapsed: true, inspectorCollapsed: false }),
    );
    localStorageMock.setItem(
      `codeshell.sessionIndex.${repoId}`,
      JSON.stringify({
        activeSessionId: sessionA,
        sessions: [
          { id: sessionA, title: "A", createdAt: 1, updatedAt: 2 },
          { id: sessionB, title: "B", createdAt: 1, updatedAt: 1 },
        ],
      }),
    );

    await renderApp();

    expect(chatProps).not.toBeNull();
    expect(chatProps!.sendBucket).toBe(bucketKey(repoId, sessionA));

    await chatProps!.onSend("from A");

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.text).toBe("from A");
    expect(runCalls[0]!.opts).toMatchObject({
      cwd: "/tmp/repo-a",
      sessionId: sessionA,
    });
    expect(runCalls[0]!.opts.sessionId).not.toBe(sessionB);
  });

  test("first send from a draft reads goal, permission, and model from the draft bucket", async () => {
    const repoId = "repoA";
    const draftBucket = bucketKey(repoId, null);
    localStorageMock.setItem(
      "codeshell.repos",
      JSON.stringify([{ id: repoId, name: "Repo A", path: "/tmp/repo-a", addedAt: 1 }]),
    );
    localStorageMock.setItem("codeshell.activeRepoId", repoId);
    localStorageMock.setItem(
      "codeshell.view",
      JSON.stringify({ viewMode: "chat", sidebarCollapsed: true, inspectorCollapsed: false }),
    );
    localStorageMock.setItem(
      "codeshell.overrides.permission",
      JSON.stringify({ [draftBucket]: "bypass" }),
    );
    localStorageMock.setItem("codeshell.overrides.goal", JSON.stringify({ [draftBucket]: true }));
    localStorageMock.setItem(
      "codeshell.overrides.model",
      JSON.stringify({ [draftBucket]: "draft-model" }),
    );

    await renderApp();

    expect(chatProps).not.toBeNull();
    await chatProps!.onSend("draft goal");

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.text).toBe("draft goal");
    expect(runCalls[0]!.opts).toMatchObject({
      cwd: "/tmp/repo-a",
      permissionMode: "bypassPermissions",
      goal: "draft goal",
      model: "draft-model",
    });
    expect(typeof runCalls[0]!.opts.sessionId).toBe("string");
  });
});

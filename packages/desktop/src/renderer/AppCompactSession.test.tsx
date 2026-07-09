import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";

interface ChatProps {
  compacting?: boolean;
  onCompactCommand?: () => void;
}

let chatProps: ChatProps | null = null;

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

mock.module("./Sidebar", () => ({ Sidebar: () => <div data-testid="sidebar" /> }));
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
mock.module("./assets/codeshell-dog-icon.png", () => ({ default: "dog.png" }));

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
  const project = { path: "/tmp/repo-a", name: "Repo A", addedAt: 1 };
  (window as unknown as { codeshell: Record<string, any>; innerWidth: number }).innerWidth = 1200;
  (window as unknown as { codeshell: Record<string, any> }).codeshell = {
    platform: "linux",
    log: () => undefined,
    isWindowFullscreen: async () => false,
    onWindowFullscreenChange: () => unsubscribe,
    projects: {
      list: async () => [project],
      resolveRoot: async () => project,
      add: async () => undefined,
      onChanged: () => unsubscribe,
    },
    mobileRemote: {
      updateProjects: async () => undefined,
      updatePermissionModes: async () => undefined,
      notifyApprovalResolved: async () => undefined,
    },
    noRepoCwd: async () => "/tmp",
    configure: async () => undefined,
    registerBrowserSessionBucket: () => undefined,
    setGitPrefs: async () => undefined,
    getGitStatus: async () => ({ branch: "main", entries: [], clean: true }),
    getGitBranches: async () => ({ isRepo: true, current: "main", branches: ["main"] }),
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
});

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApprovalRequestEnvelope } from "../preload/types";
import type { Message } from "./types";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import type { PermissionMode } from "./chat/PermissionPill";

interface QuickChatPanelProps {
  sessionId: string;
  messages: Message[];
  busy: boolean;
  creationStatus: "creating" | "ready" | "error";
  contextMode: "full" | "blank";
  sourceTitle?: string;
  draft: string;
  permissionMode: PermissionMode;
  onPermissionChange: (mode: PermissionMode) => void;
  onDraftChange: (text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onUseBlank: () => void;
  onAskUserAnswer?: (requestId: string, answer: string) => void;
  pendingApproval?: ApprovalRequestEnvelope | null;
  onApprovalDecide?: (decision: "approve" | "deny", reason?: string) => void;
}

interface ChatProps {
  messages: Message[];
  busy: boolean;
  draft: string;
  permissionMode: PermissionMode | null;
  onPermissionChange: (mode: PermissionMode) => void;
  onDraftChange: (text: string) => void;
  onAskUserAnswer?: (requestId: string, answer: string) => void;
  pendingApproval?: ApprovalRequestEnvelope | null;
  onApprovalDecide?: (decision: "approve" | "deny", reason?: string) => void;
}

interface PanelAreaProps {
  bucket: string;
  cwd: string | null;
  tabs: Array<{ id: string; kind: string }>;
  setTabs: React.Dispatch<React.SetStateAction<Array<{ id: string; kind: string }>>>;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  renderQuickChatPanel?: (args: {
    ownerBucket: string;
    tabId: string;
    cwd: string | null;
  }) => React.ReactNode;
}

let chatProps: ChatProps | null = null;
const quickChatProps = new Map<string, QuickChatPanelProps>();
const panelAreaProps = new Map<string, PanelAreaProps>();

mock.module("./ChatView", () => ({
  ChatView(props: ChatProps) {
    chatProps = props;
    return <div data-testid="chat" />;
  },
}));

mock.module("./panels/QuickChatPanel", () => ({
  QuickChatPanel(props: QuickChatPanelProps) {
    quickChatProps.set(props.sessionId, props);
    React.useEffect(
      () => () => {
        quickChatProps.delete(props.sessionId);
      },
      [props.sessionId],
    );
    return <div data-session-id={props.sessionId} />;
  },
}));

mock.module("./panels/PanelArea", () => ({
  PanelArea(props: PanelAreaProps) {
    panelAreaProps.set(props.bucket, props);
    return (
      <div data-bucket={props.bucket}>
        {props.tabs
          .filter((tab) => tab.kind === "quickChat")
          .map((tab) => (
            <React.Fragment key={tab.id}>
              {props.renderQuickChatPanel?.({
                ownerBucket: props.bucket,
                tabId: tab.id,
                cwd: props.cwd,
              })}
            </React.Fragment>
          ))}
      </div>
    );
  },
}));

mock.module("./Sidebar", () => ({ Sidebar: () => <div data-testid="sidebar" /> }));
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

const localStorageMock = new MemoryLocalStorage();
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

let root: Root | null = null;
let container: HTMLElement | null = null;
let streamListener: ((env: any) => void) | null = null;
let approvalListener: ((env: ApprovalRequestEnvelope) => void) | null = null;
let listDiskSessionsCalls = 0;
let deleteSessionCalls: string[] = [];
let cleanupQuickChatSessionCalls: string[] = [];
let claimQuickChatSessionCalls: string[] = [];
let activeQuickChatClaims = new Map<string, string>();
let cancelCalls: Array<string | undefined> = [];
let approveCalls: unknown[][] = [];
let forkSessionCalls: Array<Record<string, unknown>> = [];
let getSessionTranscriptCalls: string[] = [];
let runCalls: Array<{ prompt: string; opts: Record<string, unknown> }> = [];

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

function seedApp(options: {
  withNormalSession: boolean;
  panelTabs: Array<{ id: string; kind: string }>;
}): string {
  const bucket = options.withNormalSession ? "repoA::session-a" : "repoA::_none_";
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
      activeSessionId: options.withNormalSession ? "session-a" : null,
      sessions: options.withNormalSession
        ? [
            {
              id: "session-a",
              engineSessionId: "engine-a",
              title: "Session A",
              createdAt: 1,
              updatedAt: 2,
            },
          ]
        : [],
    }),
  );
  localStorageMock.setItem(
    `codeshell.panelState.${bucket}`,
    JSON.stringify({
      open: true,
      tabs: options.panelTabs,
      activeId: options.panelTabs[0]?.id ?? null,
    }),
  );
  return bucket;
}

function installCodeshellStub(
  listDiskSessions: () => Promise<any>,
  forkSession: (params: Record<string, unknown>) => Promise<any>,
  getSessionTranscript: (sessionId: string) => Promise<any> = async () => [],
): void {
  const unsubscribe = () => undefined;
  const project = { path: "/tmp/repo-a", name: "Repo A", addedAt: 1 };
  (window as unknown as { innerWidth: number }).innerWidth = 1200;
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
      worktrees: [{ path: "/tmp/repo-a", branch: "main", head: "abc123", isMain: true }],
    }),
    getSessionWorktreeDiff: async () => ({
      changedFiles: 0,
      aheadCommits: 0,
      hasUncommittedChanges: false,
    }),
    getSessionTranscript: async (sessionId: string) => {
      getSessionTranscriptCalls.push(sessionId);
      return getSessionTranscript(sessionId);
    },
    subscribeSession: async () => ({ events: [], nextSeq: 0 }),
    goalGet: async () => ({ goal: null }),
    listRuns: async () => [],
    listDiskSessions: async () => {
      listDiskSessionsCalls += 1;
      return listDiskSessions();
    },
    deleteSession: async (sessionId: string) => {
      deleteSessionCalls.push(sessionId);
    },
    claimQuickChatSession: async (sessionId: string, claimId: string) => {
      claimQuickChatSessionCalls.push(sessionId);
      activeQuickChatClaims.set(sessionId, claimId);
    },
    isQuickChatClaimActive: async (sessionId: string, claimId: string) => {
      return activeQuickChatClaims.get(sessionId) === claimId;
    },
    forkSession: async (params: Record<string, unknown>) => {
      forkSessionCalls.push(params);
      return forkSession(params);
    },
    cleanupQuickChatSession: async (sessionId: string, claimId: string) => {
      cleanupQuickChatSessionCalls.push(sessionId);
      if (activeQuickChatClaims.get(sessionId) === claimId) {
        activeQuickChatClaims.delete(sessionId);
      }
      return { deleted: true };
    },
    cancel: async (sessionId?: string) => {
      cancelCalls.push(sessionId);
    },
    approve: async (...args: unknown[]) => {
      approveCalls.push(args);
    },
    run: async (prompt: string, opts: Record<string, unknown>) => {
      runCalls.push({ prompt, opts });
      return new Promise(() => undefined);
    },
    onStreamEvent: (listener: (env: any) => void) => {
      streamListener = listener;
      return unsubscribe;
    },
    onAutomationSession: () => unsubscribe,
    onMobileSession: () => unsubscribe,
    onApprovalRequest: (listener: (env: ApprovalRequestEnvelope) => void) => {
      approvalListener = listener;
      return unsubscribe;
    },
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
    compactSession: async () => undefined,
  };
}

async function flushApp(waitMs = 0): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    await flushMicrotasks();
  });
}

async function mountApp(options: {
  withNormalSession: boolean;
  panelTabs: Array<{ id: string; kind: string }>;
  listDiskSessions?: () => Promise<any>;
  forkSession?: (params: Record<string, unknown>) => Promise<any>;
  getSessionTranscript?: (sessionId: string) => Promise<any>;
}): Promise<string> {
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
  const bucket = seedApp(options);
  installCodeshellStub(
    options.listDiskSessions ?? (async () => ({ sessions: [], nextCursor: null })),
    options.forkSession ??
      (async (params) => ({
        sessionId: params.targetSessionId,
        mode: "full",
        forkedFrom: {
          sessionId: params.sourceSessionId,
          mode: "full",
          sourceEventCount: 0,
          createdAt: 1,
        },
        workspace: { root: "/tmp/repo-a", kind: "main" },
        copiedEventCount: 0,
      })),
    options.getSessionTranscript,
  );
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root?.render(<App />);
    await flushMicrotasks();
  });
  await flushApp();
  return bucket;
}

function currentQuickPanels(): QuickChatPanelProps[] {
  return Array.from(quickChatProps.values());
}

function emitStream(sessionId: string, event: Record<string, unknown>): void {
  if (!streamListener) throw new Error("stream listener was not registered");
  streamListener({ sessionId, event });
}

function emitApproval(env: ApprovalRequestEnvelope): void {
  if (!approvalListener) throw new Error("approval listener was not registered");
  approvalListener(env);
}

function approvalEnvelope(
  sessionId: string,
  requestId: string,
  toolName = "Bash",
): ApprovalRequestEnvelope {
  return {
    sessionId,
    requestId,
    request: {
      toolName,
      args:
        toolName === "__ask_user__"
          ? { question: `question-${requestId}`, optionsOnly: false }
          : { command: `echo ${requestId}` },
      description: `request-${requestId}`,
    },
  } as ApprovalRequestEnvelope;
}

afterAll(() => {
  mock.restore();
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
  streamListener = null;
  approvalListener = null;
  listDiskSessionsCalls = 0;
  deleteSessionCalls = [];
  cleanupQuickChatSessionCalls = [];
  claimQuickChatSessionCalls = [];
  activeQuickChatClaims = new Map();
  cancelCalls = [];
  approveCalls = [];
  forkSessionCalls = [];
  getSessionTranscriptCalls = [];
  runCalls = [];
  chatProps = null;
  quickChatProps.clear();
  panelAreaProps.clear();
  localStorageMock.clear();
  restoreGlobalProperty("localStorage", originalLocalStorageDescriptor);
  restoreGlobalProperty("window", originalWindowDescriptor);
});

describe("App quick-chat integration", () => {
  test("round-trips one quick chat through every elevation while another quick chat and main stay unchanged", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [
        { id: "quickChat-permission-one", kind: "quickChat" },
        { id: "quickChat-permission-two", kind: "quickChat" },
      ],
    });
    const [quickOne, quickTwo] = currentQuickPanels();
    if (!quickOne || !quickTwo || !chatProps) throw new Error("chat surfaces were not created");
    const mainMode = chatProps.permissionMode;

    expect(quickOne.permissionMode).toBe("plan");
    expect(quickTwo.permissionMode).toBe("plan");

    for (const mode of ["default", "accept_edits", "bypass", "plan"] as const) {
      await act(async () => {
        quickChatProps.get(quickOne.sessionId)?.onPermissionChange(mode);
        await flushMicrotasks();
      });
      expect(quickChatProps.get(quickOne.sessionId)?.permissionMode).toBe(mode);
      expect(quickChatProps.get(quickTwo.sessionId)?.permissionMode).toBe("plan");
      expect(chatProps.permissionMode).toBe(mainMode);
    }
  });

  test("defaults quick chat to restricted access and only lifts it after an explicit pill change", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [{ id: "quickChat-restricted", kind: "quickChat" }],
    });
    const [quick] = currentQuickPanels();
    if (!quick) throw new Error("quick chat session was not created");

    expect(quick.permissionMode).toBe("plan");
    await act(async () => {
      quick.onSend("inspect only");
      await flushMicrotasks();
    });
    expect(runCalls.at(-1)).toEqual({
      prompt: "inspect only",
      opts: expect.objectContaining({
        sessionId: quick.sessionId,
        permissionMode: "plan",
        behaviorMode: "quickChatRestricted",
      }),
    });

    await act(async () => {
      quickChatProps.get(quick.sessionId)?.onPermissionChange("bypass");
      await flushMicrotasks();
    });
    const elevated = quickChatProps.get(quick.sessionId);
    expect(elevated?.permissionMode).toBe("bypass");

    await act(async () => {
      elevated?.onSend("make the requested edit");
      await flushMicrotasks();
    });
    expect(runCalls.at(-1)).toEqual({
      prompt: "make the requested edit",
      opts: expect.objectContaining({
        sessionId: quick.sessionId,
        permissionMode: "bypassPermissions",
      }),
    });
    expect(runCalls.at(-1)?.opts).not.toHaveProperty("behaviorMode");
  });

  test("defaults to a full fork of the owner engine session before becoming ready", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [{ id: "quickChat-context", kind: "quickChat" }],
    });
    const [panel] = currentQuickPanels();
    if (!panel) throw new Error("quick chat session was not created");
    expect(forkSessionCalls).toEqual([
      expect.objectContaining({
        sourceSessionId: "engine-a",
        targetSessionId: panel.sessionId,
        mode: "full",
        forkKind: "side",
        quickChatClaimId: expect.any(String),
      }),
    ]);
    expect(panel.creationStatus).toBe("ready");
    expect(panel.contextMode).toBe("full");
    expect(panel.sourceTitle).toBe("Session A");
    expect(claimQuickChatSessionCalls[0]).toBe(panel.sessionId);
  });

  test("starts the full quick-chat UI empty without reading the inherited target transcript", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [{ id: "quickChat-hidden-parent-history", kind: "quickChat" }],
      getSessionTranscript: async () => [
        { kind: "user", text: "parent request still running", clientMessageId: "parent-live" },
      ],
    });

    const [panel] = currentQuickPanels();
    if (!panel) throw new Error("quick chat session was not created");
    expect(panel.creationStatus).toBe("ready");
    expect(panel.messages).toEqual([]);
    expect(getSessionTranscriptCalls).not.toContain(panel.sessionId);
  });

  test("keeps parent turns emitted after opening out of the existing quick chat", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [{ id: "quickChat-parent-snapshot", kind: "quickChat" }],
    });
    const [quick] = currentQuickPanels();
    if (!quick || !chatProps) throw new Error("parent and quick-chat surfaces were not ready");

    await act(async () => {
      emitStream("engine-a", { type: "session_started", sessionId: "engine-a" });
      emitStream("engine-a", {
        type: "stream_request_start",
        messageId: "parent-after-side-opened",
      });
      emitStream("engine-a", { type: "text_delta", text: "parent context added later" });
      emitStream("engine-a", { type: "turn_complete", reason: "completed" });
    });
    await flushApp(70);

    const parentText = chatProps.messages.flatMap((message) =>
      message.kind === "assistant" ? [message.text] : [],
    );
    const childText = quickChatProps
      .get(quick.sessionId)
      ?.messages.flatMap((message) => (message.kind === "assistant" ? [message.text] : []));
    expect(parentText).toContain("parent context added later");
    expect(childText).not.toContain("parent context added later");
    expect(quickChatProps.get(quick.sessionId)?.busy).toBe(false);
  });

  test("a failed fork can explicitly fall back to a blank quick chat", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [{ id: "quickChat-failure", kind: "quickChat" }],
      forkSession: async () => {
        throw new Error("source session is still producing");
      },
    });
    const [failed] = currentQuickPanels();
    if (!failed) throw new Error("failed quick chat was not rendered");
    expect(failed.creationStatus).toBe("error");

    await act(async () => {
      failed.onUseBlank();
      await flushMicrotasks();
    });
    await flushApp();
    const [blank] = currentQuickPanels();
    expect(blank?.creationStatus).toBe("ready");
    expect(blank?.contextMode).toBe("blank");
    expect(blank?.sessionId).not.toBe(failed.sessionId);
    expect(forkSessionCalls).toHaveLength(1);
  });

  test("switching to blank while a fork is pending ignores and cleans the late fork", async () => {
    const pendingFork = deferred<any>();
    await mountApp({
      withNormalSession: true,
      panelTabs: [{ id: "quickChat-pending", kind: "quickChat" }],
      forkSession: () => pendingFork.promise,
    });
    const [creating] = currentQuickPanels();
    if (!creating) throw new Error("creating quick chat was not rendered");
    expect(creating.creationStatus).toBe("creating");

    await act(async () => {
      creating.onUseBlank();
      await flushMicrotasks();
    });
    await flushApp();
    const [blank] = currentQuickPanels();
    expect(blank.contextMode).toBe("blank");
    expect(blank.creationStatus).toBe("ready");

    pendingFork.resolve({
      sessionId: creating.sessionId,
      mode: "full",
      forkedFrom: {
        sessionId: "engine-a",
        mode: "full",
        sourceEventCount: 1,
        createdAt: 1,
      },
      workspace: { root: "/tmp/repo-a", kind: "main" },
      copiedEventCount: 1,
    });
    await flushApp();
    expect(cleanupQuickChatSessionCalls).toContain(creating.sessionId);
    expect(currentQuickPanels()[0]?.sessionId).toBe(blank.sessionId);
  });

  test("closing a tab while fork is deferred prevents late hydrate and cleans the claim", async () => {
    const pendingFork = deferred<any>();
    const ownerBucket = await mountApp({
      withNormalSession: true,
      panelTabs: [{ id: "quickChat-close-pending", kind: "quickChat" }],
      forkSession: () => pendingFork.promise,
    });
    const [creating] = currentQuickPanels();
    const panel = panelAreaProps.get(ownerBucket);
    if (!creating || !panel) throw new Error("pending quick chat was not rendered");

    await act(async () => {
      panel.setTabs([]);
      panel.setActiveId(null);
      await flushMicrotasks();
    });
    await flushApp();
    expect(currentQuickPanels()).toEqual([]);
    expect(activeQuickChatClaims.has(creating.sessionId)).toBe(false);

    pendingFork.resolve({
      sessionId: creating.sessionId,
      mode: "full",
      forkedFrom: { sessionId: "engine-a", mode: "full", sourceEventCount: 1, createdAt: 1 },
      workspace: { root: "/tmp/repo-a", kind: "main" },
      copiedEventCount: 1,
    });
    await flushApp();

    expect(currentQuickPanels()).toEqual([]);
    expect(cleanupQuickChatSessionCalls).toContain(creating.sessionId);
  });

  test("unmount while fork is deferred prevents late hydrate and cleans the claim", async () => {
    const pendingFork = deferred<any>();
    await mountApp({
      withNormalSession: true,
      panelTabs: [{ id: "quickChat-unmount-pending", kind: "quickChat" }],
      forkSession: () => pendingFork.promise,
    });
    const [creating] = currentQuickPanels();
    if (!creating) throw new Error("pending quick chat was not rendered");

    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
    root = null;
    expect(activeQuickChatClaims.has(creating.sessionId)).toBe(false);

    pendingFork.resolve({
      sessionId: creating.sessionId,
      mode: "full",
      forkedFrom: { sessionId: "engine-a", mode: "full", sourceEventCount: 1, createdAt: 1 },
      workspace: { root: "/tmp/repo-a", kind: "main" },
      copiedEventCount: 1,
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(currentQuickPanels()).toEqual([]);
    expect(cleanupQuickChatSessionCalls).toContain(creating.sessionId);
  });

  test("a delayed disk rebuild deletes stale qchat sessions but preserves one opened mid-scan", async () => {
    const diskScan = deferred<any>();
    const ownerBucket = await mountApp({
      withNormalSession: false,
      panelTabs: [{ id: "files-1", kind: "files" }],
      listDiskSessions: () => diskScan.promise,
    });

    expect(listDiskSessionsCalls).toBe(1);
    const panel = panelAreaProps.get(ownerBucket);
    if (!panel) throw new Error("panel area was not rendered");

    await act(async () => {
      panel.setTabs([{ id: "quickChat-live", kind: "quickChat" }]);
      panel.setActiveId("quickChat-live");
      await flushMicrotasks();
    });
    await flushApp();

    const [livePanel] = currentQuickPanels();
    if (!livePanel) throw new Error("quick chat session was not created");
    const staleSessionId = "qchat-crash-leftover";

    diskScan.resolve({
      sessions: [
        {
          id: livePanel.sessionId,
          engineSessionId: livePanel.sessionId,
          cwd: "/tmp/repo-a",
          title: "live quick chat",
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: staleSessionId,
          engineSessionId: staleSessionId,
          cwd: "/tmp/repo-a",
          title: "stale quick chat",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      nextCursor: null,
    });
    await flushApp();

    expect(claimQuickChatSessionCalls).toContain(livePanel.sessionId);
    expect(cleanupQuickChatSessionCalls).toEqual([staleSessionId]);
  });

  test("two quick chats and a normal chat isolate drafts, text, tools, busy state, and stop", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [
        { id: "quickChat-one", kind: "quickChat" },
        { id: "quickChat-two", kind: "quickChat" },
      ],
    });
    const [quickOne, quickTwo] = currentQuickPanels();
    if (!quickOne || !quickTwo || !chatProps) throw new Error("three chat surfaces were not ready");

    await act(async () => {
      quickOne.onDraftChange("draft-one");
      quickTwo.onDraftChange("draft-two");
      chatProps?.onDraftChange("draft-normal");
      await flushMicrotasks();
    });

    expect(quickChatProps.get(quickOne.sessionId)?.draft).toBe("draft-one");
    expect(quickChatProps.get(quickTwo.sessionId)?.draft).toBe("draft-two");
    expect(chatProps?.draft).toBe("draft-normal");

    const sessions = [
      { id: quickOne.sessionId, text: "text-one", tool: "ToolOne" },
      { id: quickTwo.sessionId, text: "text-two", tool: "ToolTwo" },
      { id: "engine-a", text: "text-normal", tool: "ToolNormal" },
    ];
    await act(async () => {
      for (const session of sessions) {
        emitStream(session.id, { type: "session_started", sessionId: session.id });
        emitStream(session.id, {
          type: "stream_request_start",
          messageId: `assistant-${session.id}`,
        });
        emitStream(session.id, { type: "text_delta", text: session.text });
        emitStream(session.id, {
          type: "tool_use_start",
          toolCall: {
            id: `tool-${session.id}`,
            toolName: session.tool,
            args: { owner: session.id },
          },
        });
      }
    });
    await flushApp(70);

    const surfaces = [
      { props: quickChatProps.get(quickOne.sessionId), text: "text-one", tool: "ToolOne" },
      { props: quickChatProps.get(quickTwo.sessionId), text: "text-two", tool: "ToolTwo" },
      { props: chatProps, text: "text-normal", tool: "ToolNormal" },
    ];
    for (const surface of surfaces) {
      const assistantTexts = surface.props?.messages.flatMap((message) =>
        message.kind === "assistant" ? [message.text] : [],
      );
      const toolNames = surface.props?.messages.flatMap((message) =>
        message.kind === "tool" ? [message.toolName] : [],
      );
      expect(assistantTexts).toEqual([surface.text]);
      expect(toolNames).toEqual([surface.tool]);
      expect(surface.props?.busy).toBe(true);
    }

    await act(async () => {
      quickChatProps.get(quickOne.sessionId)?.onStop();
      await flushMicrotasks();
    });

    expect(cancelCalls).toEqual([quickOne.sessionId]);
    expect(quickChatProps.get(quickOne.sessionId)?.busy).toBe(false);
    expect(quickChatProps.get(quickTwo.sessionId)?.busy).toBe(true);
    expect(chatProps?.busy).toBe(true);
  });

  test("closing a quick-chat tab immediately evicts its buffered transcript state", async () => {
    const ownerBucket = await mountApp({
      withNormalSession: true,
      panelTabs: [
        { id: "quickChat-one", kind: "quickChat" },
        { id: "quickChat-two", kind: "quickChat" },
      ],
    });
    const [quickOne, quickTwo] = currentQuickPanels();
    const panel = panelAreaProps.get(ownerBucket);
    if (!quickOne || !quickTwo || !chatProps || !panel) {
      throw new Error("quick-chat close test surfaces were not ready");
    }

    await act(async () => {
      for (const [sessionId, text] of [
        [quickOne.sessionId, "one-kept-until-close"],
        [quickTwo.sessionId, "two-must-survive"],
        ["engine-a", "normal-must-survive"],
      ]) {
        emitStream(sessionId, { type: "stream_request_start", messageId: `msg-${sessionId}` });
        emitStream(sessionId, { type: "text_delta", text });
      }
    });
    await flushApp(70);

    // Leave one more event buffered inside quickOne's 50ms coalescer window.
    await act(async () => {
      emitStream(quickOne.sessionId, { type: "text_delta", text: "orphan-buffer" });
    });

    const cleanup = deferred<{ deleted: boolean }>();
    (window.codeshell as any).cleanupQuickChatSession = async (
      sessionId: string,
      claimId: string,
    ) => {
      cleanupQuickChatSessionCalls.push(sessionId);
      if (activeQuickChatClaims.get(sessionId) === claimId) {
        activeQuickChatClaims.delete(sessionId);
      }
      return cleanup.promise;
    };
    await act(async () => {
      panel.setTabs((tabs) => tabs.filter((tab) => tab.id !== "quickChat-one"));
      await flushMicrotasks();
    });
    await flushApp();

    expect(cleanupQuickChatSessionCalls).toEqual([quickOne.sessionId]);
    expect(quickChatProps.has(quickOne.sessionId)).toBe(false);

    // Neither the buffered event nor a later event from the deleted engine may
    // revive the old bucket while main-side deletion is still pending.
    await act(async () => {
      emitStream(quickOne.sessionId, { type: "text_delta", text: "late-orphan" });
      emitStream("engine-a", {
        type: "stream_request_start",
        messageId: "parent-after-side-close",
      });
      emitStream("engine-a", { type: "text_delta", text: "parent-late-stays-parent" });
    });
    await flushApp(70);
    expect(quickChatProps.has(quickOne.sessionId)).toBe(false);
    expect(
      quickChatProps
        .get(quickTwo.sessionId)
        ?.messages.some(
          (message) =>
            message.kind === "assistant" &&
            (message.text.includes("late-orphan") || message.text.includes("parent-late")),
        ),
    ).toBe(false);
    expect(
      quickChatProps
        .get(quickTwo.sessionId)
        ?.messages.some(
          (message) => message.kind === "assistant" && message.text === "two-must-survive",
        ),
    ).toBe(true);
    expect(
      chatProps.messages.some(
        (message) =>
          message.kind === "assistant" && message.text.includes("parent-late-stays-parent"),
      ),
    ).toBe(true);
    expect(
      chatProps.messages.some(
        (message) => message.kind === "assistant" && message.text.includes("late-orphan"),
      ),
    ).toBe(false);

    // Reusing the same panel tab id must allocate a fresh, empty transcript.
    await act(async () => {
      panel.setTabs((tabs) => [...tabs, { id: "quickChat-one", kind: "quickChat" }]);
      await flushMicrotasks();
    });
    await flushApp();
    const replacement = currentQuickPanels().find(
      (candidate) => candidate.sessionId !== quickTwo.sessionId,
    );
    if (!replacement) throw new Error("replacement quick chat was not created");
    expect(replacement.sessionId).not.toBe(quickOne.sessionId);
    expect(replacement.messages).toEqual([]);

    cleanup.resolve({ deleted: true });
    await flushApp();
  });

  test("late approvals and AskUser from a closed quick chat fail closed while parent approval routes normally", async () => {
    const ownerBucket = await mountApp({
      withNormalSession: true,
      panelTabs: [{ id: "quickChat-close-approval", kind: "quickChat" }],
    });
    const [closed] = currentQuickPanels();
    const panel = panelAreaProps.get(ownerBucket);
    if (!closed || !panel || !chatProps) throw new Error("quick chat close surface was not ready");

    await act(async () => {
      panel.setTabs([]);
      panel.setActiveId(null);
      await flushMicrotasks();
    });
    await flushApp();
    expect(currentQuickPanels()).toEqual([]);

    await act(async () => {
      emitApproval(approvalEnvelope(closed.sessionId, "late-tool-closed"));
      emitApproval(approvalEnvelope(closed.sessionId, "late-ask-closed", "__ask_user__"));
      emitApproval(approvalEnvelope("engine-a", "parent-tool-after-close"));
      await flushMicrotasks();
    });
    await flushApp();

    expect(chatProps.pendingApproval?.requestId).toBe("parent-tool-after-close");
    expect(
      chatProps.messages.some(
        (message) => message.kind === "ask_user" && message.requestId === "late-ask-closed",
      ),
    ).toBe(false);
    expect(approveCalls.map((args) => args.slice(0, 3))).toEqual([
      [closed.sessionId, "late-tool-closed", "deny"],
      [closed.sessionId, "late-ask-closed", "deny"],
    ]);
  });

  test("late approvals and AskUser from a replaced quick chat cannot enter its replacement or parent", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [{ id: "quickChat-replace-approval", kind: "quickChat" }],
    });
    const [oldQuick] = currentQuickPanels();
    if (!oldQuick || !chatProps) throw new Error("quick chat replacement surface was not ready");

    await act(async () => {
      oldQuick.onUseBlank();
      await flushMicrotasks();
    });
    await flushApp();
    const [replacement] = currentQuickPanels();
    if (!replacement) throw new Error("replacement quick chat was not ready");
    expect(replacement.sessionId).not.toBe(oldQuick.sessionId);

    await act(async () => {
      emitApproval(approvalEnvelope(oldQuick.sessionId, "late-tool-replaced"));
      emitApproval(approvalEnvelope(oldQuick.sessionId, "late-ask-replaced", "__ask_user__"));
      emitApproval(approvalEnvelope(replacement.sessionId, "replacement-tool"));
      emitApproval(approvalEnvelope(replacement.sessionId, "replacement-ask", "__ask_user__"));
      await flushMicrotasks();
    });
    await flushApp();

    const currentReplacement = quickChatProps.get(replacement.sessionId);
    expect(currentReplacement?.pendingApproval?.requestId).toBe("replacement-tool");
    expect(
      currentReplacement?.messages.flatMap((message) =>
        message.kind === "ask_user" ? [message.requestId] : [],
      ),
    ).toEqual(["replacement-ask"]);
    expect(
      chatProps.messages.some(
        (message) =>
          message.kind === "ask_user" &&
          (message.requestId === "late-ask-replaced" || message.requestId === "replacement-ask"),
      ),
    ).toBe(false);
    expect(chatProps.pendingApproval?.requestId).not.toBe("late-tool-replaced");
    expect(approveCalls.map((args) => args.slice(0, 3))).toEqual([
      [oldQuick.sessionId, "late-tool-replaced", "deny"],
      [oldQuick.sessionId, "late-ask-replaced", "deny"],
    ]);
  });

  test("tool approvals stay on their owning quick or normal session", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [
        { id: "quickChat-one", kind: "quickChat" },
        { id: "quickChat-two", kind: "quickChat" },
      ],
    });
    const [quickOne, quickTwo] = currentQuickPanels();
    if (!quickOne || !quickTwo || !chatProps) throw new Error("three chat surfaces were not ready");

    await act(async () => {
      emitApproval(approvalEnvelope("engine-a", "approval-normal"));
      emitApproval(approvalEnvelope(quickOne.sessionId, "approval-one"));
      emitApproval(approvalEnvelope(quickTwo.sessionId, "approval-two"));
      await flushMicrotasks();
    });

    expect(chatProps?.pendingApproval?.requestId).toBe("approval-normal");
    expect(quickChatProps.get(quickOne.sessionId)?.pendingApproval?.requestId).toBe("approval-one");
    expect(quickChatProps.get(quickTwo.sessionId)?.pendingApproval?.requestId).toBe("approval-two");

    for (const [sessionId, getDecide] of [
      ["engine-a", () => chatProps?.onApprovalDecide],
      [quickOne.sessionId, () => quickChatProps.get(quickOne.sessionId)?.onApprovalDecide],
      [quickTwo.sessionId, () => quickChatProps.get(quickTwo.sessionId)?.onApprovalDecide],
    ] as const) {
      const decide = getDecide();
      if (!decide) throw new Error(`missing approval callback for ${sessionId}`);
      await act(async () => {
        decide("approve");
        await flushMicrotasks();
      });
    }

    expect(approveCalls.map((args) => args.slice(0, 3))).toEqual([
      ["engine-a", "approval-normal", "approve"],
      [quickOne.sessionId, "approval-one", "approve"],
      [quickTwo.sessionId, "approval-two", "approve"],
    ]);
  });

  test("AskUser prompts and answers stay on their owning quick or normal session", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [
        { id: "quickChat-one", kind: "quickChat" },
        { id: "quickChat-two", kind: "quickChat" },
      ],
    });
    const [quickOne, quickTwo] = currentQuickPanels();
    if (!quickOne || !quickTwo || !chatProps) throw new Error("three chat surfaces were not ready");

    await act(async () => {
      emitApproval(approvalEnvelope("engine-a", "ask-normal", "__ask_user__"));
      emitApproval(approvalEnvelope(quickOne.sessionId, "ask-one", "__ask_user__"));
      emitApproval(approvalEnvelope(quickTwo.sessionId, "ask-two", "__ask_user__"));
      await flushMicrotasks();
    });

    const askIds = (messages: Message[] | undefined) =>
      messages?.flatMap((message) => (message.kind === "ask_user" ? [message.requestId] : []));
    expect(askIds(chatProps?.messages)).toEqual(["ask-normal"]);
    expect(askIds(quickChatProps.get(quickOne.sessionId)?.messages)).toEqual(["ask-one"]);
    expect(askIds(quickChatProps.get(quickTwo.sessionId)?.messages)).toEqual(["ask-two"]);

    for (const [sessionId, requestId, answer, getAnswer] of [
      ["engine-a", "ask-normal", "answer-normal", () => chatProps?.onAskUserAnswer],
      [
        quickOne.sessionId,
        "ask-one",
        "answer-one",
        () => quickChatProps.get(quickOne.sessionId)?.onAskUserAnswer,
      ],
      [
        quickTwo.sessionId,
        "ask-two",
        "answer-two",
        () => quickChatProps.get(quickTwo.sessionId)?.onAskUserAnswer,
      ],
    ] as const) {
      const answerRequest = getAnswer();
      if (!answerRequest) throw new Error(`missing AskUser callback for ${sessionId}`);
      await act(async () => {
        answerRequest(requestId, answer);
        await flushMicrotasks();
      });
    }

    expect(approveCalls.map((args) => args.slice(0, 5))).toEqual([
      ["engine-a", "ask-normal", "approve", undefined, "answer-normal"],
      [quickOne.sessionId, "ask-one", "approve", undefined, "answer-one"],
      [quickTwo.sessionId, "ask-two", "approve", undefined, "answer-two"],
    ]);

    const answers = (messages: Message[] | undefined) =>
      messages?.flatMap((message) =>
        message.kind === "ask_user" ? [{ id: message.requestId, answer: message.answer }] : [],
      );
    expect(answers(chatProps?.messages)).toEqual([{ id: "ask-normal", answer: "answer-normal" }]);
    expect(answers(quickChatProps.get(quickOne.sessionId)?.messages)).toEqual([
      { id: "ask-one", answer: "answer-one" },
    ]);
    expect(answers(quickChatProps.get(quickTwo.sessionId)?.messages)).toEqual([
      { id: "ask-two", answer: "answer-two" },
    ]);
  });
});

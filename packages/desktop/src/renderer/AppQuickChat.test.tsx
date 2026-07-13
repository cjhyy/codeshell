import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApprovalRequestEnvelope } from "../preload/types";
import type { Message } from "./types";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import type { PermissionMode } from "./chat/PermissionPill";
import type { ModelOption } from "./chat/ModelPill";

interface QuickChatPanelProps {
  sessionId: string;
  creationNonce: string;
  messages: Message[];
  busy: boolean;
  creationStatus: "creating" | "ready" | "error";
  contextMode: "full" | "blank";
  sourceTitle?: string;
  draft: string;
  attachments: unknown[];
  permissionMode: PermissionMode;
  modelOptions: ModelOption[];
  activeModelKey: string | null;
  onPermissionChange: (mode: PermissionMode) => void;
  onModelChange: (option: ModelOption) => void;
  onDraftChange: (next: React.SetStateAction<string>) => void;
  onAttachmentsChange: (next: React.SetStateAction<unknown[]>) => void;
  onSend: (
    text: string,
    opts?: { attachments?: Array<Record<string, unknown>>; displayText?: string },
  ) => void;
  onStop: () => void;
  onRetry: () => void;
  onUseBlank: () => void;
  onAskUserAnswer?: (requestId: string, answer: string) => void;
  pendingApproval?: ApprovalRequestEnvelope | null;
  onApprovalDecide?: (decision: "approve" | "deny", reason?: string) => void;
}

interface ChatProps {
  variant?: "main" | "quickChat";
  messages: Message[];
  awaitingHydration?: boolean;
  sendBucket?: string;
  busy: boolean;
  draft: string;
  permissionMode: PermissionMode | null;
  activeModelKey: string | null;
  onPermissionChange: (mode: PermissionMode) => void;
  onDraftChange: (text: string) => void;
  onSend: (text: string, opts?: { bucket?: string }) => Promise<void> | void;
  onAskUserAnswer?: (requestId: string, answer: string) => void;
  pendingApproval?: ApprovalRequestEnvelope | null;
  onApprovalDecide?: (decision: "approve" | "deny", reason?: string) => void;
}

interface SidebarProps {
  onNewConversation: () => void;
  onSelectSession: (repoId: string | null, sessionId: string) => void;
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
let sidebarProps: SidebarProps | null = null;
const quickChatProps = new Map<string, QuickChatPanelProps>();
const panelAreaProps = new Map<string, PanelAreaProps>();

mock.module("./ChatView", () => ({
  ChatView(props: ChatProps) {
    chatProps = props;
    const variant = props.variant ?? "main";
    return (
      <div data-testid="chat" data-chat-variant={variant}>
        <span data-composer-control="model" />
        <span data-composer-control="voice" />
        <span data-composer-control="permission">
          当前对话权限：
          {props.permissionMode === "plan"
            ? "计划模式"
            : props.permissionMode === "bypass"
              ? "完全访问权限"
              : "默认权限"}
        </span>
        {variant === "main" && <span data-composer-control="goal" />}
        {variant === "main" && <span data-composer-control="context-usage" />}
      </div>
    );
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

mock.module("./Sidebar", () => ({
  Sidebar(props: SidebarProps) {
    sidebarProps = props;
    return <div data-testid="sidebar" />;
  },
}));
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
let markAttachmentsSentCalls: Array<Record<string, unknown>> = [];

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
  sidebarCollapsed?: boolean;
  startInDraft?: boolean;
  savedTranscript?: Record<string, unknown>;
}): string {
  const hasActiveSession = options.withNormalSession && !options.startInDraft;
  const bucket = hasActiveSession ? "repoA::session-a" : "repoA::_none_";
  localStorageMock.setItem(
    "codeshell.repos",
    JSON.stringify([{ id: "repoA", name: "Repo A", path: "/tmp/repo-a", addedAt: 1 }]),
  );
  localStorageMock.setItem("codeshell.activeRepoId", "repoA");
  localStorageMock.setItem(
    "codeshell.view",
    JSON.stringify({
      viewMode: "chat",
      sidebarCollapsed: options.sidebarCollapsed ?? true,
      inspectorCollapsed: false,
    }),
  );
  localStorageMock.setItem(
    "codeshell.sessionIndex.repoA",
    JSON.stringify({
      activeSessionId: hasActiveSession ? "session-a" : null,
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
  if (hasActiveSession && options.savedTranscript) {
    localStorageMock.setItem(
      "codeshell.transcript.repoA.session-a",
      JSON.stringify(options.savedTranscript),
    );
  }
  return bucket;
}

function installCodeshellStub(
  listDiskSessions: () => Promise<any>,
  forkSession: (params: Record<string, unknown>) => Promise<any>,
  getSessionTranscript: (sessionId: string) => Promise<any> = async () => [],
  subscribeSession: (sessionId: string, sinceSeq?: number) => Promise<any> = async () => ({
    events: [],
    nextSeq: 1,
  }),
  goalGet: (sessionId: string) => Promise<any> = async () => ({ ok: true, goal: null }),
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
    markAttachmentsSent: async (payload: Record<string, unknown>) => {
      markAttachmentsSentCalls.push(payload);
      return { ok: true };
    },
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
    subscribeSession,
    goalGet,
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
  sidebarCollapsed?: boolean;
  startInDraft?: boolean;
  savedTranscript?: Record<string, unknown>;
  listDiskSessions?: () => Promise<any>;
  forkSession?: (params: Record<string, unknown>) => Promise<any>;
  getSessionTranscript?: (sessionId: string) => Promise<any>;
  subscribeSession?: (sessionId: string, sinceSeq?: number) => Promise<any>;
  goalGet?: (sessionId: string) => Promise<any>;
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
    options.subscribeSession,
    options.goalGet,
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
  markAttachmentsSentCalls = [];
  chatProps = null;
  sidebarProps = null;
  quickChatProps.clear();
  panelAreaProps.clear();
  localStorageMock.clear();
  restoreGlobalProperty("localStorage", originalLocalStorageDescriptor);
  restoreGlobalProperty("window", originalWindowDescriptor);
});

describe("App quick-chat integration", () => {
  test("moves same-tick composer callbacks to the draft bucket when starting a new conversation", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [],
      sidebarCollapsed: false,
    });
    if (!chatProps || !sidebarProps) throw new Error("main chat controls were not rendered");
    const previousChat = chatProps;
    expect(previousChat.sendBucket).toBe("repoA::session-a");

    await act(async () => {
      sidebarProps?.onNewConversation();
      previousChat.onDraftChange("fresh draft");
      await flushMicrotasks();
    });

    expect(chatProps?.sendBucket).toBe("repoA::_none_");
    expect(chatProps?.draft).toBe("fresh draft");
  });

  test("routes a same-tick send after new conversation away from the previous session", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [],
      sidebarCollapsed: false,
    });
    if (!chatProps || !sidebarProps) throw new Error("main chat controls were not rendered");
    const previousChat = chatProps;

    await act(async () => {
      sidebarProps?.onNewConversation();
      void previousChat.onSend("fresh send", { bucket: previousChat.sendBucket });
      await flushMicrotasks();
    });

    expect(runCalls).toHaveLength(1);
    const nextIndex = JSON.parse(
      localStorageMock.getItem("codeshell.sessionIndex.repoA") ?? "null",
    ) as { activeSessionId: string | null };
    expect(nextIndex.activeSessionId).not.toBeNull();
    expect(runCalls[0]?.opts).toEqual(
      expect.objectContaining({
        bucket: `repoA::${nextIndex.activeSessionId}`,
        sessionId: nextIndex.activeSessionId,
      }),
    );
  });

  test("routes a same-tick send from a draft callback to the selected existing session", async () => {
    await mountApp({
      withNormalSession: true,
      startInDraft: true,
      panelTabs: [],
      sidebarCollapsed: false,
    });
    if (!chatProps || !sidebarProps) throw new Error("main chat controls were not rendered");
    const previousChat = chatProps;
    expect(previousChat.sendBucket).toBe("repoA::_none_");

    await act(async () => {
      sidebarProps?.onSelectSession("repoA", "session-a");
      void previousChat.onSend("selected send", { bucket: previousChat.sendBucket });
      await flushMicrotasks();
    });

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.opts).toEqual(
      expect.objectContaining({
        bucket: "repoA::session-a",
        sessionId: "engine-a",
      }),
    );
  });

  test("marks an existing session as awaiting hydration after it is selected from draft", async () => {
    const diskTranscript = deferred<any>();
    await mountApp({
      withNormalSession: true,
      startInDraft: true,
      panelTabs: [],
      sidebarCollapsed: false,
      getSessionTranscript: () => diskTranscript.promise,
    });
    if (!sidebarProps) throw new Error("sidebar was not rendered");

    await act(async () => {
      sidebarProps?.onSelectSession("repoA", "session-a");
      await flushMicrotasks();
    });

    expect(chatProps?.sendBucket).toBe("repoA::session-a");
    expect(chatProps?.messages).toEqual([]);
    expect(chatProps?.awaitingHydration).toBe(true);
  });

  test("restores busy when the remount snapshot contains an unfinished turn", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [],
      subscribeSession: async () => ({
        events: [
          {
            seq: 1,
            event: { type: "stream_request_start", messageId: "assistant-running" },
          },
        ],
        nextSeq: 2,
      }),
    });

    expect(chatProps?.messages).toEqual([
      expect.objectContaining({ kind: "assistant", id: "assistant-running" }),
    ]);
    expect(chatProps?.busy).toBe(true);
  });

  test("hydrates a persisted paused goal before rendering the top-bar projection", async () => {
    const goalGetCalls: string[] = [];
    await mountApp({
      withNormalSession: true,
      panelTabs: [],
      goalGet: async (sessionId) => {
        goalGetCalls.push(sessionId);
        return {
          ok: true,
          goal: "pause-aware goal",
          goalId: "goal-a",
          revision: 3,
          paused: true,
        };
      },
    });

    expect(goalGetCalls).toEqual(["engine-a"]);
    await flushApp(650);
    const saved = JSON.parse(
      localStorageMock.getItem("codeshell.transcript.repoA.session-a") ?? "null",
    ) as { activeGoal?: Record<string, unknown> } | null;
    expect(saved?.activeGoal).toEqual({
      objective: "pause-aware goal",
      goalId: "goal-a",
      revision: 3,
      round: 0,
      paused: true,
    });
  });

  test("restores busy from a session_started-only snapshot", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [],
      subscribeSession: async () => ({
        events: [{ seq: 1, event: { type: "session_started", sessionId: "engine-a" } }],
        nextSeq: 2,
      }),
    });

    expect(chatProps?.busy).toBe(true);
  });

  test("restores busy from the authoritative marker after the start event was evicted", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [],
      subscribeSession: async () => ({
        events: [{ seq: 20, event: { type: "text_delta", text: "still working" } }],
        nextSeq: 21,
        topLevelRunning: true,
      }),
    });

    expect(chatProps?.busy).toBe(true);
  });

  test("keeps idle when the authoritative marker overrides an unterminated start", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [],
      subscribeSession: async () => ({
        events: [{ seq: 1, event: { type: "session_started", sessionId: "engine-a" } }],
        nextSeq: 2,
        topLevelRunning: false,
      }),
    });

    expect(chatProps?.busy).toBe(false);
  });

  test("keeps busy after a streaming tombstone while the top-level turn is unfinished", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [],
      subscribeSession: async () => ({
        events: [
          {
            seq: 1,
            event: { type: "stream_request_start", messageId: "assistant-fallback" },
          },
          { seq: 2, event: { type: "tombstone", messageId: "assistant-fallback" } },
        ],
        nextSeq: 3,
      }),
    });

    expect(chatProps?.messages).toEqual([]);
    expect(chatProps?.busy).toBe(true);
  });

  test("restores busy from the full snapshot when the persisted cursor has no new tail", async () => {
    const subscribeCalls: Array<number | undefined> = [];
    await mountApp({
      withNormalSession: true,
      panelTabs: [],
      savedTranscript: {
        messages: [
          {
            kind: "assistant",
            id: "assistant-persisted",
            text: "",
            done: false,
            createdAt: 1,
          },
        ],
        streamingAssistantId: "assistant-persisted",
        streamingThinkingId: null,
        snapshotSeq: 1,
      },
      subscribeSession: async (_sessionId, sinceSeq) => {
        subscribeCalls.push(sinceSeq);
        return {
          events:
            sinceSeq === 0
              ? [
                  {
                    seq: 1,
                    event: {
                      type: "stream_request_start",
                      messageId: "assistant-persisted",
                    },
                  },
                ]
              : [],
          nextSeq: 2,
        };
      },
    });

    expect(subscribeCalls).toContain(0);
    expect(chatProps?.messages).toEqual([
      expect.objectContaining({ kind: "assistant", id: "assistant-persisted" }),
    ]);
    expect(chatProps?.busy).toBe(true);
  });

  test("does not restore busy when the snapshot top-level turn completed", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [],
      subscribeSession: async () => ({
        events: [
          { seq: 1, event: { type: "session_started", sessionId: "engine-a" } },
          {
            seq: 2,
            event: { type: "stream_request_start", messageId: "assistant-complete" },
          },
          { seq: 3, event: { type: "turn_complete", reason: "completed" } },
        ],
        nextSeq: 4,
      }),
    });

    expect(chatProps?.busy).toBe(false);
  });

  test("routes composer attachments only to the owning quick-chat run", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [{ id: "quickChat-attachment", kind: "quickChat" }],
    });
    const [quick] = currentQuickPanels();
    if (!quick) throw new Error("quick chat session was not created");
    const attachment = {
      id: "quick-image",
      sessionId: quick.sessionId,
      kind: "image",
      origin: "picker",
      path: ".code-shell/attachments/quick-image.png",
      absPath: "/tmp/repo-a/.code-shell/attachments/quick-image.png",
      size: 12,
      sha256: "abc",
      originalName: "quick-image.png",
      createdAt: 1,
      vision: { include: true },
    };

    await act(async () => {
      quick.onSend("describe this", {
        attachments: [attachment],
        displayText: "describe this\n[image:quick-image.png]",
      });
      await flushMicrotasks();
    });

    expect(runCalls.at(-1)).toEqual({
      prompt: "describe this",
      opts: expect.objectContaining({
        sessionId: quick.sessionId,
        attachments: [attachment],
      }),
    });
    expect(markAttachmentsSentCalls).toEqual([
      expect.objectContaining({
        sessionId: quick.sessionId,
        quickChatClaimId: quick.creationNonce,
        attachments: [attachment],
      }),
    ]);
    expect(quickChatProps.get(quick.sessionId)?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "describe this\n[image:quick-image.png]" }),
      ]),
    );
  });

  test("keeps a quick-chat model selection local and uses it for that side session", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [
        { id: "quickChat-model-one", kind: "quickChat" },
        { id: "quickChat-model-two", kind: "quickChat" },
      ],
    });
    const [quickOne, quickTwo] = currentQuickPanels();
    if (!quickOne || !quickTwo || !chatProps) throw new Error("chat surfaces were not created");
    const mainModel = chatProps.activeModelKey;
    const siblingModel = quickTwo.activeModelKey;
    const sideModel: ModelOption = {
      key: "side-only-model",
      label: "Side only",
      provider: "test",
      supportsVision: true,
    };

    await act(async () => {
      quickOne.onModelChange(sideModel);
      await flushMicrotasks();
    });

    expect(quickChatProps.get(quickOne.sessionId)?.activeModelKey).toBe("side-only-model");
    expect(quickChatProps.get(quickTwo.sessionId)?.activeModelKey).toBe(siblingModel);
    expect(chatProps.activeModelKey).toBe(mainModel);

    await act(async () => {
      quickChatProps.get(quickOne.sessionId)?.onSend("inspect with side model");
      await flushMicrotasks();
    });
    expect(runCalls.at(-1)).toEqual({
      prompt: "inspect with side model",
      opts: expect.objectContaining({
        sessionId: quickOne.sessionId,
        model: "side-only-model",
      }),
    });
  });

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

    expect(quickOne.permissionMode).toBe(mainMode);
    expect(quickTwo.permissionMode).toBe(mainMode);

    const modes = [
      ["plan", "plan"],
      ["default", "default"],
      ["accept_edits", "acceptEdits"],
      ["bypass", "bypassPermissions"],
    ] as const;
    for (const [mode, coreMode] of modes) {
      await act(async () => {
        quickChatProps.get(quickOne.sessionId)?.onPermissionChange(mode);
        await flushMicrotasks();
      });
      expect(quickChatProps.get(quickOne.sessionId)?.permissionMode).toBe(mode);
      expect(quickChatProps.get(quickTwo.sessionId)?.permissionMode).toBe(mainMode);
      expect(chatProps.permissionMode).toBe(mainMode);

      const prompt = `send with ${mode}`;
      await act(async () => {
        quickChatProps.get(quickOne.sessionId)?.onSend(prompt);
        await flushMicrotasks();
      });
      expect(runCalls.at(-1)).toEqual({
        prompt,
        opts: expect.objectContaining({
          sessionId: quickOne.sessionId,
          permissionMode: coreMode,
          behaviorMode: "quickChatRestricted",
        }),
      });
    }
  });

  test("always sends side guidance while the pill changes only the real permission mode", async () => {
    await mountApp({
      withNormalSession: true,
      panelTabs: [{ id: "quickChat-restricted", kind: "quickChat" }],
    });
    const [quick] = currentQuickPanels();
    if (!quick) throw new Error("quick chat session was not created");

    expect(quick.permissionMode).toBe(chatProps?.permissionMode);
    await act(async () => {
      quick.onSend("inspect only");
      await flushMicrotasks();
    });
    expect(runCalls.at(-1)).toEqual({
      prompt: "inspect only",
      opts: expect.objectContaining({
        sessionId: quick.sessionId,
        permissionMode: "default",
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
        behaviorMode: "quickChatRestricted",
      }),
    });
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

  test("late composer setters cannot restore state after close or replacement", async () => {
    const ownerBucket = await mountApp({
      withNormalSession: true,
      panelTabs: [{ id: "quickChat-late-composer", kind: "quickChat" }],
    });
    const [oldQuick] = currentQuickPanels();
    const panel = panelAreaProps.get(ownerBucket);
    if (!oldQuick || !panel) throw new Error("quick-chat composer was not ready");
    const lateDraft = oldQuick.onDraftChange;
    const lateAttachments = oldQuick.onAttachmentsChange;
    const lateModel = oldQuick.onModelChange;

    await act(async () => {
      panel.setTabs([]);
      panel.setActiveId(null);
      await flushMicrotasks();
    });
    await flushApp();
    expect(currentQuickPanels()).toEqual([]);

    await act(async () => {
      lateDraft("late private transcript");
      lateAttachments([
        {
          id: "late-image",
          name: "late.png",
          mime: "image/png",
          dataUrl: "data:image/png;base64,aA==",
          size: 1,
        },
      ]);
      lateModel({ key: "late-model", label: "Late", provider: "test" });
      panel.setTabs([{ id: "quickChat-late-composer", kind: "quickChat" }]);
      await flushMicrotasks();
    });
    await flushApp();

    const [replacement] = currentQuickPanels();
    if (!replacement) throw new Error("replacement quick chat was not created");
    expect(replacement.sessionId).not.toBe(oldQuick.sessionId);
    expect(replacement.draft).toBe("");
    expect(replacement.attachments).toEqual([]);
    expect(replacement.activeModelKey).not.toBe("late-model");
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

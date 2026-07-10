import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApprovalRequestEnvelope } from "../preload/types";
import type { Message } from "./types";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";

interface QuickChatPanelProps {
  sessionId: string;
  messages: Message[];
  busy: boolean;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onAskUserAnswer?: (requestId: string, answer: string) => void;
  pendingApproval?: ApprovalRequestEnvelope | null;
  onApprovalDecide?: (decision: "approve" | "deny", reason?: string) => void;
}

interface ChatProps {
  messages: Message[];
  busy: boolean;
  draft: string;
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
let cancelCalls: Array<string | undefined> = [];
let approveCalls: unknown[][] = [];

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

function installCodeshellStub(listDiskSessions: () => Promise<any>): void {
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
    getSessionTranscript: async () => [],
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
    cancel: async (sessionId?: string) => {
      cancelCalls.push(sessionId);
    },
    approve: async (...args: unknown[]) => {
      approveCalls.push(args);
    },
    run: async () => new Promise(() => undefined),
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
  cancelCalls = [];
  approveCalls = [];
  chatProps = null;
  quickChatProps.clear();
  panelAreaProps.clear();
  localStorageMock.clear();
  restoreGlobalProperty("localStorage", originalLocalStorageDescriptor);
  restoreGlobalProperty("window", originalWindowDescriptor);
});

describe("App quick-chat integration", () => {
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

    expect(deleteSessionCalls).toEqual([staleSessionId]);
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

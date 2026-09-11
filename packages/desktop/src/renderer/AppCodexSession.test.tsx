import { afterAll, afterEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ModelOption } from "./chat/ModelPill";
import type { SessionIndex } from "./transcripts";
import { INITIAL_STATE, type Message } from "./types";
import { resetExternalRuntimeSessions } from "./externalRuntimeRun";
import { compactSidebarSessions, sortSidebarSessions } from "./sidebarSessionVisibility";
import { externalRuntimeModelEntries } from "../shared/external-runtime-models";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import { stubPetSpriteAssets } from "./test-utils/stubPetSpriteAssets";
import { initializeSessionPersistence } from "./sessionPersistence";
import type { SessionCatalogApi, SessionCatalogSnapshot } from "../shared/session-catalog";

interface ChatProps {
  messages: Message[];
  busy: boolean;
  sendBucket?: string;
  activeModelKey: string | null;
  modelOptions: ModelOption[];
  onModelChange: (option: ModelOption) => void;
  onSend: (text: string, opts?: { bucket?: string }) => Promise<void> | void;
  onStop: () => void;
}

interface SidebarProps {
  sessions: Record<string, SessionIndex>;
  activeSessionId: string | null;
  collapsedProjects: Set<string>;
  onNewConversation: () => void;
  onSelectSession: (projectId: string | null, sessionId: string) => void;
}

let chatProps: ChatProps | null = null;
let sidebarProps: SidebarProps | null = null;
let visibleSessionIds: string[] = [];

mock.module("./ChatView", () => ({
  ChatView(props: ChatProps) {
    chatProps = props;
    return <div data-testid="chat" />;
  },
}));
mock.module("./app/AppSidebar", () => ({
  Sidebar(props: SidebarProps) {
    sidebarProps = props;
    const rows = props.collapsedProjects.has("repoA")
      ? []
      : compactSidebarSessions(
          sortSidebarSessions(props.sessions.repoA?.sessions.filter((row) => !row.archived) ?? []),
          props.activeSessionId,
          false,
          5,
        );
    visibleSessionIds = rows.map((row) => row.id);
    return (
      <div data-testid="sidebar">
        {rows.map((row) => (
          <div key={row.id} data-session-id={row.id}>
            {row.title}
          </div>
        ))}
      </div>
    );
  },
}));
mock.module("./panels/PanelArea", () => ({ PanelArea: () => null }));
mock.module("./TopBar", () => ({ TopBar: () => null }));
mock.module("./workspace-trust/TrustGate", () => ({ TrustGate: () => null }));
mock.module("./shell/SearchBar", () => ({ SearchBar: () => null }));
mock.module("./shell/CommandPalette", () => ({
  CommandPalette: () => null,
  buildCommands: () => [],
}));
mock.module("./shell/SessionSearchModal", () => ({ SessionSearchModal: () => null }));
mock.module("./app/useAppPetSprite", () => ({ usePetSprite: () => "dog.png" }));
stubPetSpriteAssets();

const { App } = await import("./App");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let root: Root | null = null;

function installStorage(): { storage: Storage; exhaustQuota: () => void } {
  const data = new Map<string, string>();
  let byteLimit = Infinity;
  const usedBytes = () =>
    [...data].reduce((total, [key, value]) => total + 2 * (key.length + value.length), 0);
  const storage: Storage = {
    get length() {
      return data.size;
    },
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      const previousBytes = data.has(key) ? 2 * (key.length + data.get(key)!.length) : 0;
      if (usedBytes() - previousBytes + 2 * (key.length + String(value).length) > byteLimit) {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      data.set(key, String(value));
    },
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
  };
  for (const target of [globalThis, window]) {
    Object.defineProperty(target, "localStorage", {
      value: storage,
      configurable: true,
      writable: true,
    });
  }
  storage.setItem(
    "codeshell.repos",
    JSON.stringify([{ id: "repoA", name: "Repo A", path: "/tmp/repo-a", addedAt: 1 }]),
  );
  storage.setItem("codeshell.activeRepoId", "repoA");
  storage.setItem(
    "codeshell.view",
    JSON.stringify({ viewMode: "chat", sidebarCollapsed: false, inspectorCollapsed: true }),
  );
  storage.setItem(
    "codeshell.sessionIndex.repoA",
    JSON.stringify({
      activeSessionId: "previous-session",
      sessions: [
        {
          id: "previous-session",
          engineSessionId: "previous-session",
          title: "Previous conversation",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
  );
  return { storage, exhaustQuota: () => (byteLimit = usedBytes()) };
}

async function flushApp(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
  chatProps = null;
  sidebarProps = null;
  visibleSessionIds = [];
  resetExternalRuntimeSessions();
  for (const [key, descriptor] of [
    ["window", originalWindow],
    ["localStorage", originalLocalStorage],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});
afterAll(() => mock.restore());

// Keep the missing-start case: a renderer-originated send must create its row
// even if an older provider omits session_started. The second case covers the
// current Codex lifecycle contract without conflating it with row creation.
test.each([
  ["keeps a new Codex conversation visible without session_started", false, false, false, "legacy"],
  ["keeps a new Codex conversation visible with session_started", true, false, false, "legacy"],
  [
    "keeps a new Codex conversation visible when localStorage is full",
    false,
    true,
    false,
    "legacy",
  ],
  [
    "backfills and opens a disk conversation when localStorage is full",
    false,
    true,
    true,
    "legacy",
  ],
  [
    "waits for Main to persist the session before starting Codex with a full browser cache",
    true,
    true,
    false,
    "delayed",
  ],
  ["keeps a failed session save visible and never starts Codex", false, false, false, "failed"],
  [
    "honors Stop while the new session is waiting for its durable save",
    false,
    false,
    false,
    "cancelled",
  ],
] as const)("%s", async (_label, emitSessionStarted, quotaFull, fromDisk, persistenceMode) => {
  ensureMiniDom();
  const { storage, exhaustQuota } = installStorage();
  const fillTranscriptCache = () => {
    storage.setItem(
      "codeshell.transcript.repoA.previous-session",
      JSON.stringify({
        ...INITIAL_STATE,
        sessionId: "previous-session",
        messages: [{ kind: "assistant", id: "old-answer", done: true, text: "x".repeat(100_000) }],
      }),
    );
    exhaustQuota();
  };
  const diskSession = {
    id: "codex-disk-session",
    engineSessionId: "codex-disk-session",
    cwd: "/tmp/repo-a",
    title: "Codex conversation recovered from disk",
    updatedAt: 2,
    origin: "desktop",
    status: "completed",
  };
  let finishDiskPage!: (page: { sessions: (typeof diskSession)[]; nextCursor: null }) => void;
  const diskPage = new Promise<{ sessions: (typeof diskSession)[]; nextCursor: null }>(
    (resolve) => {
      finishDiskPage = resolve;
    },
  );
  let stream: ((event: { sessionId: string; event: Record<string, unknown> }) => void) | undefined;
  const starts: Array<{ sessionId: string; modelKey: string }> = [];
  const sends: Array<{ sessionId: string; text: string }> = [];
  const nativeRuns: unknown[] = [];
  let catalog: SessionCatalogSnapshot = { revision: 0, indices: {} };
  let blockCatalogWrites = false;
  let releaseCatalog!: () => void;
  const catalogGate = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  const catalogApi: SessionCatalogApi = {
    load: async () => structuredClone(catalog),
    importLegacy: async (indices) => {
      catalog = { revision: 1, indices: structuredClone(indices) };
      return structuredClone(catalog);
    },
    apply: async (patch) => {
      if (blockCatalogWrites) {
        if (persistenceMode === "failed") throw new Error("disk is read-only");
        await catalogGate;
      }
      const index = catalog.indices[patch.projectKey] ?? { sessions: [], activeSessionId: null };
      for (const upsert of patch.upserts ?? []) {
        const existing = index.sessions.find((row) => row.id === upsert.id);
        if (existing) Object.assign(existing, upsert.values);
        else
          index.sessions.push({
            ...upsert.values,
            id: upsert.id,
          } as SessionIndex["sessions"][number]);
      }
      if (patch.activeSessionId !== undefined) index.activeSessionId = patch.activeSessionId;
      catalog.indices[patch.projectKey] = index;
      catalog.revision += 1;
      return structuredClone(catalog);
    },
    onChanged: () => () => undefined,
    writeTranscript: async () => undefined,
    readTranscript: async () => ({ value: null, hasEarlier: false }),
    deleteTranscript: async () => undefined,
  };
  let finishTurn!: (result: { ok: boolean; reason: string; streamed: boolean }) => void;
  const completion = new Promise<{ ok: boolean; reason: string; streamed: boolean }>((resolve) => {
    finishTurn = resolve;
  });
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
  (window as unknown as { innerWidth: number }).innerWidth = 1200;
  (window as unknown as { codeshell: unknown }).codeshell = {
    platform: "linux",
    ...(persistenceMode !== "legacy" ? { sessionCatalog: catalogApi } : {}),
    log: () => undefined,
    isWindowFullscreen: async () => false,
    onWindowFullscreenChange: () => unsubscribe,
    projectRegistry: {
      list: async () => [project],
      beginLegacyMigration: async () => ({ completed: true }),
      authorizeLegacyMigration: async () => ({ status: "migrated" }),
      completeLegacyMigration: async () => undefined,
      resolveForCwdBatch: async (cwds: string[]) =>
        cwds.map(() => ({ projectId: "repoA", rootId: "root-a", created: false })),
      onChanged: () => unsubscribe,
    },
    mobileRemote: {
      updatePermissionModes: async () => undefined,
      notifyApprovalResolved: async () => undefined,
    },
    noRepoCwd: async () => "/tmp",
    configure: async () => undefined,
    cancel: async () => undefined,
    externalRuntime: {
      available: async () => ["codex"],
      models: async () => externalRuntimeModelEntries(["codex"]),
      start: async (payload: { sessionId: string; modelKey: string }) => {
        starts.push(payload);
        if (emitSessionStarted) {
          stream?.({
            sessionId: payload.sessionId,
            event: { type: "session_started", sessionId: payload.sessionId },
          });
        }
        return { kind: "codex", runtimeSessionId: "codex-provider-thread", tools: [] };
      },
      send: (payload: { sessionId: string; text: string }) => {
        sends.push(payload);
        return completion;
      },
      stop: async () => undefined,
      onSessionState: () => unsubscribe,
    },
    registerBrowserSessionBucket: () => undefined,
    setGitPrefs: async () => undefined,
    getProjectGitStatus: async () => ({ branch: "main", entries: [], clean: true }),
    getSessionGitStatus: async () => ({ branch: "main", entries: [], clean: true }),
    getProjectGitBranches: async () => ({ isRepo: true, current: "main", branches: ["main"] }),
    getSessionWorkspaceAuthority: async () => ({
      workspace: { root: "/tmp/repo-a", kind: "main" },
      projectId: "repoA",
      mainRootId: "root-a",
      mainRoot: "/tmp/repo-a",
      mainRootName: "Repo A",
      rootStatus: "ok",
    }),
    getSessionWorkspace: async () => ({ root: "/tmp/repo-a", kind: "main" }),
    getSessionTranscript: async (sessionId: string) =>
      sessionId === diskSession.id
        ? [
            { kind: "stream", event: { type: "session_started", sessionId } },
            { kind: "user", text: "Codex question recovered from disk" },
            { kind: "stream", event: { type: "stream_request_start", turnNumber: 1 } },
            {
              kind: "stream",
              event: {
                type: "assistant_message",
                message: { role: "assistant", content: "Codex recovered answer" },
              },
            },
            { kind: "stream", event: { type: "turn_complete", reason: "completed" } },
          ]
        : [],
    subscribeSession: async () => ({ events: [], nextSeq: 1 }),
    goalGet: async () => ({ ok: true, goal: null }),
    listRuns: async () => [],
    listDiskSessions: async () => (fromDisk ? diskPage : { sessions: [], nextCursor: null }),
    run: async (...args: unknown[]) => {
      nativeRuns.push(args);
    },
    onStreamEvent: (listener: typeof stream) => {
      stream = listener;
      return unsubscribe;
    },
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
    getConfigurationSettings: async () => ({}),
    updateSettings: async () => undefined,
    updateConfigurationSettings: async () => undefined,
    getModelCatalog: async () => [],
    resolveModelMeta: async () => [],
    setBadgeCount: async () => undefined,
    notify: async () => undefined,
  };
  await initializeSessionPersistence();
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root?.render(<App />);
    await flushMicrotasks();
  });
  await flushApp();
  expect(sidebarProps?.activeSessionId).toBe("previous-session");
  if (fromDisk) {
    fillTranscriptCache();
    await act(async () => {
      finishDiskPage({ sessions: [diskSession], nextCursor: null });
      await flushMicrotasks();
    });
    await flushApp();
    expect(visibleSessionIds).toContain(diskSession.id);
    await act(async () => {
      sidebarProps?.onSelectSession("repoA", diskSession.id);
      await flushMicrotasks();
    });
    await flushApp();
    expect(sidebarProps?.activeSessionId).toBe(diskSession.id);
    expect(chatProps?.sendBucket).toBe(`repoA::${diskSession.id}`);
    expect(chatProps?.messages).toContainEqual(
      expect.objectContaining({ kind: "assistant", text: "Codex recovered answer" }),
    );
    expect(visibleSessionIds).toContain(diskSession.id);
    return;
  }
  blockCatalogWrites = persistenceMode !== "legacy";
  await act(async () => {
    sidebarProps?.onNewConversation();
    await flushMicrotasks();
  });
  expect(chatProps?.sendBucket).toBe("repoA::_none_");
  const codex = chatProps?.modelOptions.find((option) => option.key === "codex/gpt-6-astra");
  if (!codex) throw new Error("Codex model option is missing");
  await act(async () => {
    chatProps?.onModelChange(codex);
    await flushMicrotasks();
  });
  expect(chatProps?.activeModelKey).toBe(codex.key);
  if (quotaFull) fillTranscriptCache();
  let pendingSend: Promise<void> | void;
  await act(async () => {
    pendingSend = chatProps?.onSend("Codex first message", { bucket: chatProps?.sendBucket });
    await flushMicrotasks();
  });
  await flushApp();
  const sessionId = sidebarProps?.activeSessionId;
  if (!sessionId) throw new Error("New conversation did not acquire an identity");
  expect(sessionId).not.toBe("previous-session");
  if (persistenceMode !== "legacy") {
    expect(visibleSessionIds).toContain(sessionId);
    expect(starts).toHaveLength(0);
    expect(sends).toHaveLength(0);
    if (persistenceMode === "failed") {
      await pendingSend;
      await flushApp();
      expect(chatProps?.busy).toBe(false);
      expect(chatProps?.messages).toContainEqual(
        expect.objectContaining({ kind: "user", text: "Codex first message" }),
      );
      expect(catalog.indices.repoA?.sessions.some((row) => row.id === sessionId)).toBe(false);
      return;
    }
    await act(async () => {
      if (persistenceMode === "cancelled") chatProps?.onStop();
      releaseCatalog();
      await flushMicrotasks();
    });
    await flushApp();
    if (persistenceMode === "cancelled") {
      await pendingSend;
      expect(starts).toHaveLength(0);
      expect(sends).toHaveLength(0);
      expect(chatProps?.busy).toBe(false);
      return;
    }
  }
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ sessionId, modelKey: codex.key });
  expect(sends).toEqual([expect.objectContaining({ sessionId, text: "Codex first message" })]);
  expect(nativeRuns).toEqual([]);
  expect(visibleSessionIds).toContain(sessionId);
  expect(chatProps?.busy).toBe(true);
  expect(chatProps?.messages).toContainEqual(
    expect.objectContaining({ kind: "user", text: "Codex first message" }),
  );
  await act(async () => {
    stream?.({ sessionId, event: { type: "text_delta", text: "Codex completed reply" } });
    stream?.({ sessionId, event: { type: "turn_complete", reason: "completed" } });
    finishTurn({ ok: true, reason: "completed", streamed: true });
    await pendingSend;
    await flushMicrotasks();
  });
  await flushApp();
  expect(chatProps?.busy).toBe(false);
  expect(visibleSessionIds).toContain(sessionId);
  const persisted =
    persistenceMode === "legacy"
      ? JSON.parse(storage.getItem("codeshell.sessionIndex.repoA") ?? "{}")
      : catalog.indices.repoA;
  expect(persisted.sessions).toContainEqual(
    expect.objectContaining({
      id: sessionId,
      engineSessionId: sessionId,
      title: "Codex first message",
    }),
  );
  expect(
    persisted.sessions.some((session: { id: string }) => session.id === "codex-provider-thread"),
  ).toBe(false);
});

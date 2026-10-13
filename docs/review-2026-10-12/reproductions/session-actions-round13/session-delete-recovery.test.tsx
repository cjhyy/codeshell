import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
const deny = () => {
  throw Error("NETWORK_FORBIDDEN_round13");
};
globalThis.fetch = deny as any;
http.request = http.get = deny as any;
https.request = https.get = deny as any;
net.connect = net.createConnection = deny as any;
tls.connect = deny as any;
if (
  !process.env.CODE_SHELL_TEST_HOME ||
  !process.env.HOME?.includes("codeshell-bun-completion-")
)
  throw Error("guarded HOME required");
const repo = process.cwd();
import React, { act } from "react";
import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
  chmodSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { createRoot } = await import(
  `${repo}/packages/desktop/node_modules/react-dom/client`
);
const { ensureMiniDom, flushMicrotasks } = await import(
  `${repo}/packages/desktop/src/renderer/test-utils/renderHook`
);
ensureMiniDom();
// Browser scheduling missing in MiniDOM; leave production menu/dialog logic intact.
window.requestAnimationFrame = ((fn: any) =>
  setTimeout(() => fn(Date.now()), 0)) as any;
window.cancelAnimationFrame = (id: any) => clearTimeout(id);
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
Object.defineProperty(window, "innerHeight", {
  configurable: true,
  value: 768,
});
Object.defineProperty(window, "innerWidth", {
  configurable: true,
  value: 1366,
});
const elementPrototype = Object.getPrototypeOf(document.createElement("div"));
for (const [metric, value] of [["offsetWidth", 200], ["offsetHeight", 100]] as const) {
  if (typeof document.createElement("div")[metric] !== "number")
    Object.defineProperty(elementPrototype, metric, { configurable: true, get: () => value });
}
Object.defineProperty(
  Object.getPrototypeOf(document.createElement("input")),
  "select",
  { configurable: true, value() {} },
);
const { Sidebar } = await import(
  `${repo}/packages/desktop/src/renderer/Sidebar`
);
const { DialogProvider } = await import(
  `${repo}/packages/desktop/src/renderer/ui/DialogProvider`
);
const { ToastProvider } = await import(
  `${repo}/packages/desktop/src/renderer/ui/ToastProvider`
);
const { SessionsView } = await import(
  `${repo}/packages/desktop/src/renderer/sessions/SessionsView`
);
const { useSessionNavigation } = await import(
  `${repo}/packages/desktop/src/renderer/app/useSessionNavigation`
);
const { useSessionIndices } = await import(
  `${repo}/packages/desktop/src/renderer/app/useSessionIndices`
);
const { useSessionHistorySync } = await import(
  `${repo}/packages/desktop/src/renderer/app/useSessionHistorySync`
);
const {
  initializeSessionPersistence,
  flushSessionPersistence,
  getSessionPersistence,
} = await import(`${repo}/packages/desktop/src/renderer/sessionPersistence`);
const {
  saveSessionIndex,
  loadSessionIndex,
  saveTranscript,
  loadTranscript,
  upsertImportedSession,
  NO_REPO_KEY,
  bucketKey,
} = await import(`${repo}/packages/desktop/src/renderer/transcripts`);
const { foldTranscript } = await import(
  `${repo}/packages/desktop/src/renderer/automation/foldTranscript`
);
const { SessionManager } = await import(
  `${repo}/packages/core/src/session/session-manager`
);
const { SessionCatalogStore } = await import(
  `${repo}/packages/desktop/src/main/session-catalog-store`
);
const { SessionTranscriptCache } = await import(
  `${repo}/packages/desktop/src/main/session-transcript-cache`
);
const { deleteSessionDir, listSessions, listDiskSessions, archiveDiskSession } =
  await import(`${repo}/packages/server/src/sessions-service`);
const { createSessionTitlesStore } = await import(
  `${repo}/packages/server/src/session-titles-store`
);
const { __resetProjectSnapshotForTest } = await import(
  `${repo}/packages/desktop/src/renderer/projects`
);
let root: any,
  container: any,
  temporary = "",
  sessionsRoot = "";
function nodes(n: any): any[] {
  return [n, ...Array.from(n?.childNodes ?? []).flatMap(nodes)];
}
function props(n: any): any {
  const k = Object.keys(n).find((k) => k.startsWith("__reactProps$"));
  return k ? n[k] : {};
}
function text(n: any): string {
  if (n.nodeType === 3) return n.data;
  return (
    Array.from(n.childNodes ?? [])
      .map(text)
      .join("") ||
    (typeof props(n).children === "string" ? props(n).children : "")
  );
}
const settle = async () => {
  await flushMicrotasks();
  await new Promise((r) => setTimeout(r, 0));
  await flushMicrotasks();
};
async function until(fn: () => boolean) {
  const end = Date.now() + 2500;
  while (!fn()) {
    if (Date.now() > end) throw Error("fixture wait timeout");
    await act(settle);
  }
}
async function mount(component: any) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(component);
    await settle();
  });
}
async function click(n: any) {
  expect(n).toBeDefined();
  expect(props(n).disabled).not.toBe(true);
  await act(async () => {
    props(n).onClick({
      currentTarget: n,
      stopPropagation() {},
      preventDefault() {},
    });
    await settle();
  });
}
function refuseDelete() {
  chmodSync(join(sessionsRoot, "delete-A"), 0o500);
  chmodSync(sessionsRoot, 0o500);
}
function restoreDelete() {
  if (sessionsRoot && existsSync(sessionsRoot)) {
    chmodSync(sessionsRoot, 0o700);
    if (existsSync(join(sessionsRoot, "delete-A")))
      chmodSync(join(sessionsRoot, "delete-A"), 0o700);
  }
}
afterEach(async () => {
  if (root)
    await act(async () => {
      root.unmount();
      await settle();
    });
  root = undefined;
  if (container?.parentNode) container.parentNode.removeChild(container);
  container = undefined;
  getSessionPersistence()?.dispose();
  __resetProjectSnapshotForTest();
  restoreDelete();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = "";
  sessionsRoot = "";
});

async function fixture() {
  expect(process.getuid?.()).not.toBe(0);
  temporary = realpathSync(
    mkdtempSync(join(tmpdir(), "codeshell-session-actions-")),
  );
  sessionsRoot = join(temporary, "sessions");
  const cwd = join(temporary, "project");
  mkdirSync(cwd);
  const manager = new SessionManager(sessionsRoot);
  const bundle = manager.create(
    cwd,
    "fixture-model",
    "fixture-provider",
    "delete-A",
    null,
    "desktop",
  );
  bundle.transcript.appendMessage("user", "Core durable A");
  bundle.transcript.appendMessage("assistant", "Core persisted reply A");
  manager.updateSessionState("delete-A", {
    title: "Delete A",
    status: "completed",
  });
  const catalog = new SessionCatalogStore({
    file: join(temporary, "desktop", "catalog.json"),
  });
  const cache = new SessionTranscriptCache({
    directory: join(temporary, "desktop", "cache"),
    legacyDirectory: join(temporary, "desktop", "legacy"),
  });
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  const calls: string[] = [],
    logs: any[] = [];
  const api = {
    log: (...args) => logs.push(args),
    sessionCatalog: {
      load: () => catalog.load(),
      importLegacy: (input) => catalog.importLegacy(input),
      apply: (input) => catalog.apply(input),
      onChanged: (fn) => catalog.onChanged(fn),
      writeTranscript: (input) => cache.write(input),
      readTranscript: (input) => cache.read(input),
      deleteTranscript: (input) => cache.delete(input),
    },
    deleteSession: async (id) => {
      calls.push(id);
      await deleteSessionDir(id, sessionsRoot);
    },
    listSessions: () => listSessions(sessionsRoot),
    listSessionTitles: async () => ({}),
    getUpdaterStatus: async () => ({ kind: "idle" }),
    onUpdaterStatus: () => () => {},
    getPetWidgetVisible: async () => false,
    onPetWidgetVisibility: () => () => {},
  };
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: api,
  });
  await initializeSessionPersistence();
  const summary = {
    id: "delete-A",
    engineSessionId: "delete-A",
    title: "Delete A",
    createdAt: 1,
    updatedAt: 2,
  };
  saveSessionIndex(null, { sessions: [summary], activeSessionId: "delete-A" });
  const snapshot = foldTranscript([
    { kind: "user", text: "Renderer projection A", timestamp: 1 },
  ]);
  saveTranscript(null, "delete-A", snapshot);
  await flushSessionPersistence();
  expect((await catalog.load()).indices[NO_REPO_KEY].sessions).toHaveLength(1);
  expect(
    (await cache.read({ projectKey: NO_REPO_KEY, sessionId: "delete-A" }))
      .value,
  ).not.toBeNull();
  return { manager, catalog, cache, summary, api, calls, logs };
}

test("CONFIRMED real Sidebar delete hides/tombstones A before actual filesystem deletion rejects; history view can retry", async () => {
  const f = await fixture();
  let state: any;
  function Host() {
    const { sessionIndices, setSessionIndices } = useSessionIndices();
    const [panels, setPanels] = React.useState({});
    const [activeProjectId, setActiveProjectId] = React.useState(null);
    const activeSessionId =
      sessionIndices[NO_REPO_KEY]?.activeSessionId ?? null;
    const activeBucketRef = React.useRef(
      bucketKey(activeProjectId, activeSessionId),
    );
    activeBucketRef.current = bucketKey(activeProjectId, activeSessionId);
    const navigation = useSessionNavigation({
      projects: [],
      setProjects: () => {},
      activeProjectId,
      setActiveProjectId,
      sessionIndices,
      setSessionIndices,
      setCollapsedProjects: () => {},
      setUnreadBuckets: () => {},
      setPermissionOverrides: () => {},
      setModelOverrides: () => {},
      setGoalOverrides: () => {},
      panelByBucket: panels,
      setPanelByBucket: setPanels,
      activeBucketRef,
      setView: () => {},
      setRunsInitialRunId: () => {},
    });
    state = { sessionIndices, navigation };
    return (
      <DialogProvider>
        <ToastProvider>
          <Sidebar
            projects={[]}
            sessions={sessionIndices}
            activeProjectId={null}
            activeSessionId={activeSessionId}
            collapsedProjects={new Set()}
            petPendingCount={0}
            petRunningCount={0}
            petWidgetVisible={false}
            sessionHistoryLoading={false}
            hasMoreSessionHistory={false}
            onSelectProject={() => {}}
            onSelectSession={navigation.handleSelectSession}
            onToggleProject={() => {}}
            onAddProject={() => {}}
            onRemoveProject={() => {}}
            onPinProject={() => {}}
            onRenameProject={() => {}}
            onArchiveAllSessions={() => {}}
            onNewConversationForProject={() => {}}
            onNewConversation={() => {}}
            onOpenSearch={() => {}}
            onNavigate={() => {}}
            onOpenProjectConfig={() => {}}
            onOpenSettingsPage={() => {}}
            onOpenPetPage={() => {}}
            onTogglePetWidget={() => {}}
            onLoadMoreSessionHistory={() => {}}
            onRenameSession={navigation.handleRenameSession}
            onPinSession={navigation.handlePinSession}
            onArchiveSession={navigation.handleArchiveSession}
            onDeleteSession={navigation.handleDeleteSession}
            activeProjectPath={null}
            viewMode="chat"
          />
        </ToastProvider>
      </DialogProvider>
    );
  }
  await mount(<Host />);
  const row = nodes(container).find(
    (n) => props(n).onContextMenu && text(n).includes("Delete A"),
  );
  expect(row).toBeDefined();
  await act(async () => {
    props(row).onContextMenu({ preventDefault() {}, clientX: 0, clientY: 0 });
    await settle();
  });
  const menuDelete = nodes(document.body).find(
    (n) =>
      n.tagName === "BUTTON" &&
      props(n).role === "menuitem" &&
      /^删除/.test(text(n)),
  );
  await click(menuDelete);
  const confirm = nodes(document.body).find(
    (n) =>
      n.tagName === "BUTTON" &&
      text(n) === "删除" &&
      props(n).role !== "menuitem",
  );
  expect(confirm).toBeDefined();
  expect(f.calls).toEqual([]);
  refuseDelete();
  await click(confirm);
  await until(() =>
    f.logs.some((v) => v[0] === "session.delete.session.failed"),
  );
  await flushSessionPersistence();
  const failure = f.logs.find((v) => v[0] === "session.delete.session.failed");
  expect(failure[1].error).toMatch(/EACCES|EPERM/);
  expect(f.calls).toEqual(["delete-A"]);
  expect(text(container)).not.toContain("Delete A");
  expect(text(document.body)).not.toMatch(/EACCES|EPERM|删除失败/);
  expect(state.sessionIndices[NO_REPO_KEY].sessions).toEqual([]);
  expect((await f.catalog.load()).indices[NO_REPO_KEY].sessions).toEqual([]);
  expect(
    (await f.cache.read({ projectKey: NO_REPO_KEY, sessionId: "delete-A" }))
      .value,
  ).toBeNull();
  const resumed = new SessionManager(sessionsRoot).resume("delete-A");
  expect(resumed.transcript.toMessages().map((m) => m.content)).toEqual([
    "Core durable A",
    "Core persisted reply A",
  ]);
  const page = await listDiskSessions({ limit: 50 }, sessionsRoot);
  expect(page.sessions.map((s) => s.id)).toContain("delete-A");
  await act(async () => {
    upsertImportedSession(null, f.summary);
    await settle();
  });
  await flushSessionPersistence();
  expect(loadSessionIndex(null).sessions).toEqual([]);
  expect((await f.catalog.load()).indices[NO_REPO_KEY].sessions).toEqual([]);
  const durable = JSON.parse(
    readFileSync(join(temporary, "desktop", "catalog.json"), "utf8"),
  );
  expect(durable.deletedSessionIds[NO_REPO_KEY]).toContain("delete-A");
  restoreDelete();
  await act(async () => {
    root.render(<SessionsView />);
    await settle();
  });
  await until(() => text(container).includes("Delete A"));
  const retryDelete = nodes(container).find(
    (n) => n.tagName === "BUTTON" && /^删除/.test(props(n)["aria-label"] ?? ""),
  );
  await click(retryDelete);
  await until(() => !existsSync(join(sessionsRoot, "delete-A")));
  expect(f.calls).toEqual(["delete-A", "delete-A"]);
  console.log(
    JSON.stringify({
      finding: "sidebar-delete-failure",
      entry:
        "actual Sidebar context menu -> actual DialogProvider confirm -> actual useSessionNavigation",
      actualFilesystemFailure: failure[1].error,
      coreMessagesPreserved: resumed.transcript.toMessages().length,
      catalogRowsAfterFailure: durable.indices[NO_REPO_KEY].sessions.length,
      durableTombstone: true,
      ordinaryReimportRestores: false,
      recovery:
        "SessionsView still lists actual Core history; after correcting owned directory permissions, actual delete retry succeeds",
      scope:
        "React MiniDOM + actual catalog/cache/server deletion; Main IPC wiring statically traced, not native Electron",
    }),
  );
});

test("CONTROL actual SessionsView keeps A and shows filesystem refusal, then retries same id successfully", async () => {
  const f = await fixture();
  const deleted: string[] = [];
  await mount(<SessionsView onSessionDeleted={(id) => deleted.push(id)} />);
  await until(() => text(container).includes("Delete A"));
  refuseDelete();
  const deleteButton = () =>
    nodes(container).find(
      (n) =>
        n.tagName === "BUTTON" && /^删除/.test(props(n)["aria-label"] ?? ""),
    );
  await click(deleteButton());
  await until(
    () =>
      text(container).includes("EACCES") || text(container).includes("EPERM"),
  );
  expect(text(container)).toContain("Delete A");
  expect(deleted).toEqual([]);
  expect((await f.catalog.load()).indices[NO_REPO_KEY].sessions).toHaveLength(
    1,
  );
  expect(
    (await f.cache.read({ projectKey: NO_REPO_KEY, sessionId: "delete-A" }))
      .value,
  ).not.toBeNull();
  restoreDelete();
  const retry = nodes(container).find(
    (n) => n.tagName === "BUTTON" && text(n) === "重试",
  );
  await click(retry);
  await until(() => deleted.length === 1);
  expect(deleted).toEqual(["delete-A"]);
  expect(f.calls).toEqual(["delete-A", "delete-A"]);
  expect(text(container)).not.toContain("Delete A");
  expect(existsSync(join(sessionsRoot, "delete-A"))).toBe(false);
  console.log(
    JSON.stringify({
      control: "SessionsView-delete-recovery",
      actualFilesystemRefusalVisible: true,
      failedRowRetained: true,
      catalogUnchangedUntilSuccess: true,
      rendererSnapshotRetainedUntilSuccess: true,
      sameIdRetried: true,
      deleted,
    }),
  );
});

function deferred() {
  let resolve: any;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
test("CONTROL actual SessionsView late rename after leaving keeps newer active B and its draft, while synchronizing A", async () => {
  const f = await fixture();
  const b = f.manager.create(
    join(temporary, "project"),
    "fixture-model",
    "fixture-provider",
    "keep-B",
    null,
    "desktop",
  );
  b.transcript.appendMessage("user", "Core B");
  f.manager.updateSessionState("keep-B", {
    title: "Keep B",
    status: "completed",
  });
  saveSessionIndex(null, {
    sessions: [
      f.summary,
      {
        id: "keep-B",
        engineSessionId: "keep-B",
        title: "Keep B",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    activeSessionId: "delete-A",
  });
  await flushSessionPersistence();
  const titleStore = createSessionTitlesStore(
    join(temporary, "desktop", "titles.json"),
  );
  const gate = deferred();
  const renames: any[] = [];
  (f.api as any).renameSession = async (id, title) => {
    renames.push({ id, title });
    await titleStore.setTitle(id, title);
    await gate.promise;
  };
  f.api.listSessionTitles = () => titleStore.listTitles();
  let state: any;
  function Host() {
    const { sessionIndices, setSessionIndices } = useSessionIndices();
    const [showHistory, setShowHistory] = React.useState(true);
    const [drafts, setDrafts] = React.useState({
      [bucketKey(null, "keep-B")]: { text: "B unsent draft", attachments: [] },
    });
    const [activeProjectId, setActiveProjectId] = React.useState(null);
    const indicesRef = React.useRef(sessionIndices);
    indicesRef.current = sessionIndices;
    const activeBucketRef = React.useRef("");
    activeBucketRef.current = bucketKey(
      null,
      sessionIndices[NO_REPO_KEY]?.activeSessionId ?? null,
    );
    const [panels, setPanels] = React.useState({});
    const nav = useSessionNavigation({
      projects: [],
      setProjects: () => {},
      activeProjectId,
      setActiveProjectId,
      sessionIndices,
      setSessionIndices,
      setCollapsedProjects: () => {},
      setUnreadBuckets: () => {},
      setPermissionOverrides: () => {},
      setModelOverrides: () => {},
      setGoalOverrides: () => {},
      panelByBucket: panels,
      setPanelByBucket: setPanels,
      activeBucketRef,
      setView: () => {},
      setRunsInitialRunId: () => {},
    });
    const sync = useSessionHistorySync({
      untitledTitle: "Untitled",
      sessionIndicesRef: indicesRef,
      setSessionIndices,
      activeBucketRef,
      setPanelByBucket: setPanels,
      transcriptsRef: React.useRef({}),
      dispatch: () => {},
      engineToBucketRef: React.useRef(new Map()),
      runningBucketRef: React.useRef(null),
      coalescersRef: React.useRef(new Map()),
      coalescerSeqRef: React.useRef(new Map()),
      appliedSeqRef: React.useRef(new Map()),
      setBusyForKey: () => {},
      setUnreadBuckets: () => {},
      setQueuedInputs: () => {},
      setComposerDrafts: setDrafts,
    });
    state = {
      sessionIndices,
      drafts,
      leave() {
        nav.handleSelectSession(null, "keep-B");
        setShowHistory(false);
      },
    };
    return showHistory ? (
      <SessionsView onSessionRenamed={sync.onSessionRenamed} />
    ) : (
      <div>Chat B</div>
    );
  }
  await mount(<Host />);
  await until(() => text(container).includes("Delete A"));
  const aRow = nodes(container).find(
    (n) => n.tagName === "LI" && text(n).includes("Delete A"),
  );
  const rename = nodes(aRow).find(
    (n) => n.tagName === "BUTTON" && text(n) === "重命名",
  );
  await click(rename);
  const editor = nodes(container).find(
    (n) => n.tagName === "INPUT" && props(n)["aria-label"] === "会话标题",
  );
  await act(async () => {
    props(editor).onChange({ target: { value: "Renamed A" } });
    await settle();
  });
  await click(
    nodes(container).find((n) => n.tagName === "BUTTON" && text(n) === "保存"),
  );
  expect(renames).toEqual([{ id: "delete-A", title: "Renamed A" }]);
  await act(async () => {
    state.leave();
    await settle();
  });
  expect(state.sessionIndices[NO_REPO_KEY].activeSessionId).toBe("keep-B");
  expect(text(container)).toBe("Chat B");
  await act(async () => {
    gate.resolve();
    await settle();
  });
  await flushSessionPersistence();
  expect(
    state.sessionIndices[NO_REPO_KEY].sessions.find((s) => s.id === "delete-A")
      .title,
  ).toBe("Renamed A");
  expect(
    state.sessionIndices[NO_REPO_KEY].sessions.find((s) => s.id === "keep-B")
      .title,
  ).toBe("Keep B");
  expect(state.sessionIndices[NO_REPO_KEY].activeSessionId).toBe("keep-B");
  expect(state.drafts[bucketKey(null, "keep-B")].text).toBe("B unsent draft");
  expect((await titleStore.listTitles())["delete-A"]).toBe("Renamed A");
  expect((await f.catalog.load()).indices[NO_REPO_KEY].activeSessionId).toBe(
    "keep-B",
  );
  console.log(
    JSON.stringify({
      control: "late-history-rename",
      renames,
      activeSession: "keep-B",
      newerDraft: "B unsent draft",
      targetTitle: "Renamed A",
      lateCompletionAfterUnmount: true,
      actualTitleStore: true,
    }),
  );
});

test("CONTROL delayed archive A freezes target and preserves later B selection and rename; restore retains B", async () => {
  const f = await fixture();
  const b = f.manager.create(
    join(temporary, "project"),
    "fixture-model",
    "fixture-provider",
    "keep-B",
    null,
    "desktop",
  );
  b.transcript.appendMessage("user", "Core B");
  f.manager.updateSessionState("keep-B", {
    title: "Keep B",
    status: "completed",
  });
  saveSessionIndex(null, {
    sessions: [
      f.summary,
      {
        id: "keep-B",
        engineSessionId: "keep-B",
        title: "Keep B",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    activeSessionId: "delete-A",
  });
  await flushSessionPersistence();
  const gate = deferred();
  const releaseCalls: string[] = [],
    archiveCalls: any[] = [];
  (f.api as any).releaseSessionWorkspace = async (id) => {
    releaseCalls.push(id);
    await gate.promise;
    return { ok: true, status: "missing" };
  };
  (f.api as any).setSessionArchived = async (id, archived) => {
    archiveCalls.push({ id, archived });
    await archiveDiskSession(id, archived ? 1234 : undefined, sessionsRoot);
  };
  let state: any;
  function Host() {
    const { sessionIndices, setSessionIndices } = useSessionIndices();
    const [activeProjectId, setActiveProjectId] = React.useState(null);
    const [panels, setPanels] = React.useState({});
    const activeBucketRef = React.useRef("");
    activeBucketRef.current = bucketKey(
      null,
      sessionIndices[NO_REPO_KEY]?.activeSessionId ?? null,
    );
    const nav = useSessionNavigation({
      projects: [],
      setProjects: () => {},
      activeProjectId,
      setActiveProjectId,
      sessionIndices,
      setSessionIndices,
      setCollapsedProjects: () => {},
      setUnreadBuckets: () => {},
      setPermissionOverrides: () => {},
      setModelOverrides: () => {},
      setGoalOverrides: () => {},
      panelByBucket: panels,
      setPanelByBucket: setPanels,
      activeBucketRef,
      setView: () => {},
      setRunsInitialRunId: () => {},
    });
    state = { nav, sessionIndices };
    return <div>Archive control</div>;
  }
  await mount(<Host />);
  let pending: any;
  await act(async () => {
    pending = state.nav.handleArchiveSession(null, "delete-A", true);
    await settle();
  });
  expect(releaseCalls).toEqual(["delete-A"]);
  expect(archiveCalls).toEqual([]);
  await act(async () => {
    state.nav.handleSelectSession(null, "keep-B");
    state.nav.handleRenameSession(null, "keep-B", "New B");
    await settle();
  });
  await act(async () => {
    gate.resolve();
    await pending;
    await settle();
  });
  await flushSessionPersistence();
  expect(archiveCalls).toEqual([{ id: "delete-A", archived: true }]);
  expect(state.sessionIndices[NO_REPO_KEY].activeSessionId).toBe("keep-B");
  expect(
    state.sessionIndices[NO_REPO_KEY].sessions.find((s) => s.id === "keep-B")
      .title,
  ).toBe("New B");
  expect(
    state.sessionIndices[NO_REPO_KEY].sessions.find((s) => s.id === "delete-A")
      .archived,
  ).toBe(true);
  expect(
    new SessionManager(sessionsRoot).resume("delete-A").state.archivedAt,
  ).toBe(1234);
  expect(
    new SessionManager(sessionsRoot).resume("keep-B").state.archivedAt,
  ).toBeUndefined();
  await act(async () => {
    await state.nav.handleArchiveSession(null, "delete-A", false);
    await settle();
  });
  expect(state.sessionIndices[NO_REPO_KEY].activeSessionId).toBe("keep-B");
  expect(
    state.sessionIndices[NO_REPO_KEY].sessions.find((s) => s.id === "delete-A")
      .archived,
  ).toBe(false);
  expect(
    new SessionManager(sessionsRoot).resume("delete-A").state.archivedAt,
  ).toBeUndefined();
  expect(releaseCalls).toEqual(["delete-A"]);
  console.log(
    JSON.stringify({
      control: "late-archive-target",
      releaseCalls,
      archiveCalls,
      newerActive: "keep-B",
      newerTitle: "New B",
      actualCoreArchiveWriter: true,
      restoredWithoutSelectionOverride: true,
    }),
  );
});

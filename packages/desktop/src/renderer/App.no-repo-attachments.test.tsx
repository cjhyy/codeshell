import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import type { RendererConfigurationTarget, SessionWorkspaceAuthority } from "../preload/types";

// The real renderer and its real attachment handlers run against an inert bridge.
// No Main/Core, native transport, browser, media device, or provider is invoked.
// A new UI SID deliberately remains unknown to the fake Main workspace lookup.
const children = createRequire(import.meta.url)("node:child_process");
const childNames = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
// The shard shares one process, so these denials must not outlive this file.
const originalChildren = Object.fromEntries(childNames.map((name) => [name, children[name]]));
const originalKill = process.kill;
for (const name of childNames) {
  children[name] = () => {
    throw new Error(`Native transport denied: ${name}`);
  };
}
process.kill = () => {
  throw new Error("Native signal denied");
};
syncBuiltinESMExports();
const denied = () => {
  throw new Error("Unexpected renderer transport");
};
const originalFetch = globalThis.fetch;
const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
globalThis.fetch = denied;
Object.defineProperty(globalThis, "Worker", { configurable: true, value: denied });
Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: denied });
const denyQRCode = () => {
  throw new Error("Unexpected QR code rendering");
};
mock.module("qrcode", () => ({
  default: Object.assign(denyQRCode, { toDataURL: denyQRCode }),
  toDataURL: denyQRCode,
}));

let chatProps: Record<string, any> | null = null;
let sidebarProps: Record<string, any> | null = null;
const sendCalls: Array<{
  text: string;
  opts: Record<string, any> | undefined;
  configurationTarget: unknown;
  sendBucket: unknown;
}> = [];
mock.module("./MessageStream", () => ({ MessageStream: () => null }));
mock.module("./app/AppSidebar", () => ({
  Sidebar(props: Record<string, any>) {
    sidebarProps = props;
    return <div />;
  },
}));
mock.module("./TopBar", () => ({ TopBar: () => <div /> }));
mock.module("./panels/PanelArea", () => ({ PanelArea: () => <div /> }));
mock.module("./workspace-trust/TrustGate", () => ({ TrustGate: () => null }));
mock.module("./shell/SearchBar", () => ({ SearchBar: () => <div /> }));
mock.module("./shell/CommandPalette", () => ({
  CommandPalette: () => <div />,
  buildCommands: () => [],
}));
mock.module("./shell/SessionSearchModal", () => ({ SessionSearchModal: () => <div /> }));
// Keep the actual ChatView even if another test installed the App-level mock.
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { ChatView: ActualChatView } = await import("./ChatView.tsx?no-repo-attachments");
mock.module("./ChatView", () => ({
  ChatView(props: Record<string, any>) {
    chatProps = props;
    return (
      <ActualChatView
        {...props}
        onSend={(text: string, opts: Record<string, any> | undefined) => {
          // Observe the real composer's output without entering App.send/Main.
          sendCalls.push({
            text,
            opts: opts === undefined ? undefined : JSON.parse(JSON.stringify(opts)),
            configurationTarget: { ...props.configurationTarget },
            sendBucket: props.sendBucket,
          });
        }}
      />
    );
  },
}));
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { App } = await import("./App.tsx?no-repo-attachments");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function descendants(node: any): any[] {
  return [node, ...(node?.childNodes ?? []).flatMap((child: any) => descendants(child))];
}
function propsOf(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function find(predicate: (props: Record<string, any>) => boolean): any {
  const node = descendants(container).find((item) => predicate(propsOf(item)));
  if (!node) throw new Error("Actual renderer element was not found");
  return node;
}
class MemoryStorage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}
class ControlledFileReader {
  static reads: ControlledFileReader[] = [];
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL() {
    ControlledFileReader.reads.push(this);
  }
  finish() {
    this.result = "data:image/png;base64,eA==";
    this.onload?.();
  }
}
const storage = new MemoryStorage();
const originals = new Map(
  ["localStorage", "FileReader", "window", "crypto"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);
const staged: Array<{ input: Record<string, any>; result: ReturnType<typeof deferred<any>> }> = [];
const noRepoCwd = "/fixture/no-repo";
const unknownWorkspaceLookups: string[] = [];
let root: Root | null = null;
let container: HTMLElement | null = null;
function installBridge() {
  const off = () => () => undefined;
  const project = {
    id: "repoA",
    name: "Repo A",
    roots: [{ id: "root-a", path: "/fixture/repo-a", name: "Repo A", addedAt: 1 }],
    primaryRootId: "root-a",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    revision: 1,
  };
  Object.assign(window, { innerWidth: 1200 });
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    writable: true,
    value: {
      platform: "linux",
      log: () => undefined,
      cloudEnvironment: {
        listBindings: async () => [],
        getSelection: async (localProjectId: string) => ({ localProjectId, bindingId: null }),
        select: async () => undefined,
      },
      isWindowFullscreen: async () => false,
      onWindowFullscreenChange: off,
      externalRuntime: { available: async () => [], models: async () => [], onSessionState: off },
      projectRegistry: {
        list: async () => [project],
        beginLegacyMigration: async () => ({ completed: true }),
        authorizeLegacyMigration: async () => ({ status: "migrated" }),
        completeLegacyMigration: async () => undefined,
        resolveForCwdBatch: async () => [],
        onChanged: off,
      },
      mobileRemote: {
        updatePermissionModes: async () => undefined,
        notifyApprovalResolved: async () => undefined,
      },
      noRepoCwd: async () => noRepoCwd,
      configure: async () => undefined,
      registerBrowserSessionBucket: () => undefined,
      setGitPrefs: async () => undefined,
      getProjectGitStatus: async () => ({ branch: "main", entries: [], clean: true }),
      getSessionGitStatus: async () => ({ branch: "main", entries: [], clean: true }),
      getProjectGitBranches: async () => ({ isRepo: true, current: "main", branches: ["main"] }),
      getSessionWorkspace: async () => ({ root: "/fixture/repo-a", kind: "main" }),
      getSessionWorkspaceAuthority: async (
        sessionId: string,
      ): Promise<SessionWorkspaceAuthority> => {
        if (sessionId !== "engine-a" && sessionId !== "engine-b") {
          unknownWorkspaceLookups.push(sessionId);
          throw new Error(`unknown session: ${sessionId}`);
        }
        return {
          workspace: { root: project.roots[0].path, kind: "main" },
          projectId: project.id,
          mainRootId: project.primaryRootId,
          mainRoot: project.roots[0].path,
          mainRootName: project.roots[0].name,
          rootStatus: "ok",
        };
      },
      listSessionWorktrees: async () => ({
        current: { root: "/fixture/repo-a", kind: "main" },
        mainRoot: "/fixture/repo-a",
        worktrees: [],
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
      onStreamEvent: off,
      onAutomationSession: off,
      onMobileSession: off,
      onApprovalRequest: off,
      onApprovalResolved: off,
      onMobilePermissionMode: off,
      onStatus: off,
      onAgentLifecycle: off,
      onWorktreeCleanupSkipped: off,
      onBrowserAnchorFromPopout: off,
      onBrowserAnchorRemoveFromPopout: off,
      onBrowserAnchorUpdateFromPopout: off,
      syncBrowserAnchors: () => undefined,
      onMenuEvent: off,
      getSettings: async () => ({}),
      getModelCatalog: async () => [],
      resolveModelMeta: async () => [],
      getConfigurationSettings: async (_target: RendererConfigurationTarget) => ({}),
      releaseSessionWorkspace: async (sessionId: string) => ({
        sessionId,
        ok: true,
        status: "released",
        workspace: { root: "/fixture/repo-a", kind: "main" },
      }),
      setSessionArchived: async () => undefined,
      deleteSession: async () => undefined,
      setBadgeCount: async () => undefined,
      notify: async () => undefined,
      sttAvailable: async () => ({ available: false }),
      listPluginCommands: async () => [],
      stageAttachmentImageDataUrl(input: Record<string, any>) {
        const result = deferred<any>();
        staged.push({ input, result });
        return result.promise;
      },
      readImageDataUrl: denied,
      run: denied,
      send: denied,
      spawn: denied,
      fork: denied,
      transcribeAudio: denied,
    },
  });
}
function imageMeta(input: Record<string, any>, index = 0) {
  return {
    id: `owned-image-${index}`,
    kind: "image",
    name: input.name,
    mime: input.mime,
    sessionId: input.sessionId,
    origin: input.origin,
    path: `.code-shell/attachments/${input.sessionId}/image.png`,
    absPath: `${input.cwd}/.code-shell/attachments/${input.sessionId}/image.png`,
    size: 1,
    sha256: "a".repeat(64),
    createdAt: 1,
  };
}
async function settle() {
  await flushMicrotasks();
  await flushMicrotasks();
}
async function pick(name = "from-A.png") {
  await act(async () => {
    propsOf(find((props) => props.type === "file")).onChange({
      target: { files: [new File(["x"], name, { type: "image/png" })], value: name },
    });
    await settle();
  });
}
async function dropPdf(path: string) {
  Object.assign(window.codeshell, { getPathForFile: () => path });
  await act(async () => {
    propsOf(find((props) => props["data-chat-variant"] === "main")).onDrop({
      preventDefault() {},
      dataTransfer: {
        getData: () => "",
        files: [new File(["%PDF-1.0"], path.split("/").at(-1)!, { type: "application/pdf" })],
      },
    });
    await settle();
  });
  expect(ControlledFileReader.reads).toHaveLength(0);
  expect(staged).toHaveLength(0);
  expect(propsOf(find((props) => props.title === path)).title).toBe(path);
}
beforeEach(async () => {
  ensureMiniDom();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "FileReader", {
    configurable: true,
    writable: true,
    value: ControlledFileReader,
  });
  // Digest timing/bytes are not the behavior under test; keep the real caller
  // deterministic without a native crypto job or a timer-based settling guess.
  let uuid = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
      subtle: { digest: async () => new Uint8Array(32).buffer },
    },
  });
  storage.clear();
  staged.length = 0;
  unknownWorkspaceLookups.length = 0;
  sendCalls.length = 0;
  ControlledFileReader.reads.length = 0;
  storage.setItem(
    "codeshell.repos",
    JSON.stringify([{ id: "repoA", name: "Repo A", path: "/fixture/repo-a", addedAt: 1 }]),
  );
  storage.setItem("codeshell.activeRepoId", "repoA");
  storage.setItem(
    "codeshell.view",
    JSON.stringify({ viewMode: "chat", sidebarCollapsed: false, inspectorCollapsed: false }),
  );
  storage.setItem(
    "codeshell.sessionIndex.repoA",
    JSON.stringify({
      activeSessionId: "session-a",
      sessions: [
        { id: "session-a", engineSessionId: "engine-a", title: "A", createdAt: 1, updatedAt: 2 },
        { id: "session-b", engineSessionId: "engine-b", title: "B", createdAt: 1, updatedAt: 2 },
      ],
    }),
  );
  installBridge();
  chatProps = null;
  sidebarProps = null;
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root?.render(<App />);
    await settle();
  });
  expect(sidebarProps).not.toBeNull();
  expect(typeof sidebarProps?.onSelectSession).toBe("function");
  expect(chatProps?.configurationTarget).toEqual({ sessionId: "engine-a" });
  expect(chatProps?.configurationAvailable).toBe(true);
  expect(chatProps?.conversationRootStatus).toBe("ok");
  expect(chatProps?.conversationRoot).toBe("/fixture/repo-a");
  expect(chatProps?.conversationRootId).toBe("root-a");
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await settle();
  });
  root = null;
  container = null;
  storage.clear();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
afterAll(() => {
  mock.restore();
  Object.assign(children, originalChildren);
  process.kill = originalKill;
  syncBuiltinESMExports();
  globalThis.fetch = originalFetch;
  if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
  else Reflect.deleteProperty(globalThis, "Worker");
  if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
  else Reflect.deleteProperty(globalThis, "WebSocket");
});

// Select through the actual App navigation handler, not a synthetic bucket prop.
async function selectDraft(projectId: string | null) {
  const create = sidebarProps?.onNewConversationForProject;
  expect(typeof create).toBe("function");
  await act(async () => {
    create(projectId);
    await settle();
  });
  expect(chatProps?.activeProjectId).toBe(projectId);
  expect(chatProps?.configurationTarget).toEqual(
    projectId === null ? { noRepo: true } : { projectId },
  );
  expect(chatProps?.configurationAvailable).toBe(true);
  expect(chatProps?.conversationRootStatus).toBe("ok");
  expect(chatProps?.conversationRoot).toBe(projectId === null ? noRepoCwd : "/fixture/repo-a");
  expect(chatProps?.conversationRootId).toBe(projectId === null ? null : "root-a");
  const index = JSON.parse(
    storage.getItem(`codeshell.sessionIndex.${projectId ?? "__no_repo__"}`)!,
  );
  expect(index.activeSessionId).toBeNull();
}
function pendingOwner(projectId: string | null) {
  const index = JSON.parse(
    storage.getItem(`codeshell.sessionIndex.${projectId ?? "__no_repo__"}`)!,
  );
  const owner = index.sessions.find((session: any) => session.id === index.activeSessionId);
  expect(owner).toBeDefined();
  expect(owner.pendingFirstRun).toBe(true);
  expect(owner.engineSessionId).toBeUndefined();
  expect(owner.id).not.toBe("session-a");
  expect(owner.id).not.toBe("session-b");
  expect(unknownWorkspaceLookups).toContain(owner.id);
  expect(chatProps?.engineSessionId).toBe(owner.id);
  expect(chatProps?.sendBucket).toBe(`${projectId ?? "__no_repo__"}::${owner.id}`);
  expect(chatProps?.configurationTarget).toEqual(
    projectId === null ? { noRepo: true } : { projectId },
  );
  expect(chatProps?.configurationAvailable).toBe(true);
  expect(chatProps?.conversationRootStatus).toBe("loading");
  expect(chatProps?.conversationRoot).toBe(projectId === null ? noRepoCwd : "/fixture/repo-a");
  expect(chatProps?.conversationRootId).toBe(projectId === null ? null : "root-a");
  return owner;
}
async function setUnsentControls() {
  await act(async () => {
    propsOf(find((props) => props.rows === 1)).onChange({
      target: { value: "keep this attachment draft", selectionStart: 26 },
    });
    chatProps?.onModelChange({ key: "fixture-text", label: "Fixture text", provider: "fixture" });
    chatProps?.onPermissionChange("plan");
    await settle();
  });
  expect(unsentControls()).toEqual({
    draft: "keep this attachment draft",
    model: "fixture-text",
    permission: "plan",
  });
}
function unsentControls() {
  return {
    draft: chatProps?.draft,
    model: chatProps?.activeModelKey,
    permission: chatProps?.permissionMode,
  };
}
async function finishImageRead() {
  expect(ControlledFileReader.reads).toHaveLength(1);
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
}
async function acceptStagedImage() {
  expect(staged).toHaveLength(1);
  await act(async () => {
    staged[0].result.resolve(imageMeta(staged[0].input));
    await settle();
  });
}

test("a no-repo PDF-created pending owner can accept a later image without a Core Session", async () => {
  await selectDraft(null);
  await setUnsentControls();
  const controls = unsentControls();
  const path = `${noRepoCwd}/pending-owned.pdf`;
  await dropPdf(path);
  const owner = pendingOwner(null);
  const pdfMetadata = JSON.parse(JSON.stringify(chatProps?.composerMetadata));
  expect(pdfMetadata.localFilePaths).toEqual([path]);
  expect(pdfMetadata.inputReferences).toHaveLength(1);
  expect(pdfMetadata.inputReferences[0]).toMatchObject({
    sessionId: owner.id,
    kind: "file",
    absPath: path,
  });
  await pick("later-no-repo-image.png");
  await finishImageRead();
  // Meaningful RED must reach this accepted-file boundary after faithful setup.
  expect(staged).toHaveLength(1);
  expect(staged[0].input).toMatchObject({ cwd: noRepoCwd, sessionId: owner.id });
  await acceptStagedImage();
  expect(chatProps?.attachments).toHaveLength(1);
  expect(chatProps?.attachments[0].sessionId).toBe(owner.id);
  expect(chatProps?.composerMetadata).toEqual(pdfMetadata);
  expect(unsentControls()).toEqual(controls);
  pendingOwner(null);
  expect(sendCalls).toHaveLength(0);
});

test("the registered-project PDF pending-owner continuation remains a positive control", async () => {
  await selectDraft("repoA");
  await setUnsentControls();
  const controls = unsentControls();
  const path = "/fixture/repo-a/pending-owned.pdf";
  await dropPdf(path);
  const owner = pendingOwner("repoA");
  const pdfMetadata = JSON.parse(JSON.stringify(chatProps?.composerMetadata));
  expect(pdfMetadata.localFilePaths).toEqual([path]);
  expect(pdfMetadata.inputReferences).toHaveLength(1);
  expect(pdfMetadata.inputReferences[0]).toMatchObject({ sessionId: owner.id, absPath: path });
  await pick("later-project-image.png");
  await finishImageRead();
  expect(staged).toHaveLength(1);
  expect(staged[0].input).toMatchObject({ cwd: "/fixture/repo-a", sessionId: owner.id });
  await acceptStagedImage();
  expect(chatProps?.attachments).toHaveLength(1);
  expect(chatProps?.attachments[0].sessionId).toBe(owner.id);
  expect(chatProps?.composerMetadata).toEqual(pdfMetadata);
  expect(unsentControls()).toEqual(controls);
  pendingOwner("repoA");
  expect(sendCalls).toHaveLength(0);
});

test("a first image still materializes a no-repo draft under the fake Main cwd", async () => {
  await selectDraft(null);
  await setUnsentControls();
  const controls = unsentControls();
  expect(unknownWorkspaceLookups).toHaveLength(0);
  await pick("first-no-repo-image.png");
  await finishImageRead();
  expect(staged).toHaveLength(1);
  const owner = pendingOwner(null);
  expect(staged[0].input).toMatchObject({ cwd: noRepoCwd, sessionId: owner.id });
  await acceptStagedImage();
  expect(chatProps?.attachments).toHaveLength(1);
  expect(chatProps?.attachments[0]).toMatchObject({
    sessionId: owner.id,
    absPath: `${noRepoCwd}/.code-shell/attachments/${owner.id}/image.png`,
  });
  expect(unsentControls()).toEqual(controls);
  pendingOwner(null);
  expect(sendCalls).toHaveLength(0);
});

test("a restored no-repo pending row without this App's prepare token cannot stage", async () => {
  await selectDraft(null);
  const index = JSON.parse(storage.getItem("codeshell.sessionIndex.__no_repo__")!);
  index.sessions.push({
    id: "restored-no-repo",
    title: "Restored pending",
    createdAt: 1,
    updatedAt: 2,
    pendingFirstRun: true,
  });
  storage.setItem("codeshell.sessionIndex.__no_repo__", JSON.stringify(index));
  const select = sidebarProps?.onSelectSession;
  expect(typeof select).toBe("function");
  await act(async () => {
    select(null, "restored-no-repo");
    await settle();
  });
  expect(pendingOwner(null).id).toBe("restored-no-repo");
  await pick("restored-no-repo.png");
  await finishImageRead();
  expect(staged).toHaveLength(0);
  expect(chatProps?.composerMetadata.attachmentError).toContain("当前会话还没有可用的附件保存目录");
});

test("revoking an App-created no-repo row's pending marker invalidates its prepare token", async () => {
  await selectDraft(null);
  await dropPdf(`${noRepoCwd}/revoked-pending.pdf`);
  const owner = pendingOwner(null);
  const index = JSON.parse(storage.getItem("codeshell.sessionIndex.__no_repo__")!);
  index.sessions.find((session: any) => session.id === owner.id).pendingFirstRun = false;
  storage.setItem("codeshell.sessionIndex.__no_repo__", JSON.stringify(index));
  const select = sidebarProps?.onSelectSession;
  expect(typeof select).toBe("function");
  await act(async () => {
    select(null, owner.id);
    await settle();
  });
  expect(chatProps?.engineSessionId).toBe(owner.id);
  expect(chatProps?.configurationTarget).toEqual({ noRepo: true });
  expect(chatProps?.configurationAvailable).toBe(true);
  expect(chatProps?.conversationRootStatus).toBe("loading");
  const current = JSON.parse(storage.getItem("codeshell.sessionIndex.__no_repo__")!);
  expect(current.sessions.find((session: any) => session.id === owner.id).pendingFirstRun).toBe(
    false,
  );
  await pick("revoked-pending.png");
  await finishImageRead();
  expect(staged).toHaveLength(0);
  expect(chatProps?.composerMetadata.attachmentError).toContain("当前会话还没有可用的附件保存目录");
});

test("a resolved corrupt no-repo Session authority rejects an existing prepare token", async () => {
  await selectDraft(null);
  const originalAuthority = window.codeshell.getSessionWorkspaceAuthority;
  Object.assign(window.codeshell, {
    getSessionWorkspaceAuthority: async (sessionId: string) => {
      if (sessionId === "engine-a" || sessionId === "engine-b") return originalAuthority(sessionId);
      throw new Error("fixture Session exists but its state is invalid");
    },
  });
  await dropPdf(`${noRepoCwd}/corrupt-authority.pdf`);
  const index = JSON.parse(storage.getItem("codeshell.sessionIndex.__no_repo__")!);
  const owner = index.sessions.find((session: any) => session.id === index.activeSessionId);
  expect(owner).toBeDefined();
  expect(owner.pendingFirstRun).toBe(true);
  expect(owner.engineSessionId).toBeUndefined();
  expect(chatProps?.engineSessionId).toBe(owner.id);
  expect(chatProps?.configurationTarget).toEqual({ sessionId: owner.id });
  expect(chatProps?.configurationAvailable).toBe(false);
  expect(chatProps?.conversationRootStatus).toBe("unavailable");
  expect(chatProps?.conversationRoot).toBeNull();
  await pick("corrupt-no-repo.png");
  await finishImageRead();
  expect(staged).toHaveLength(0);
  expect(chatProps?.composerMetadata.attachmentError).toContain("当前会话还没有可用的附件保存目录");
});

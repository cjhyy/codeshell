import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import type { RendererConfigurationTarget, SessionWorkspaceAuthority } from "../preload/types";

// The real renderer and its real attachment handlers run against an inert bridge.
// No Main/Core, native transport, browser, media device, or provider is invoked.
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
const { ChatView: ActualChatView } = await import("./ChatView.tsx?attachment-ownership");
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
const { App } = await import("./App.tsx?attachment-ownership");
const { loadProjects, saveProjects } = await import("./projects");

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
function renderedText(): string {
  return descendants(container)
    .map((node) => {
      const text = node?.nodeValue ?? node?.data ?? node?.textContent;
      return typeof text === "string" ? text : "";
    })
    .join("");
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
const imageReads: Array<{ input: unknown[]; result: ReturnType<typeof deferred<string>> }> = [];
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
      noRepoCwd: async () => "/fixture",
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
        if (sessionId !== "engine-a" && sessionId !== "engine-b")
          throw new Error(`unknown session: ${sessionId}`);
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
      readImageDataUrl(...input: unknown[]) {
        const result = deferred<string>();
        imageReads.push({ input, result });
        return result.promise;
      },
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
    absPath: `/fixture/repo-a/.code-shell/attachments/${input.sessionId}/image.png`,
    size: 1,
    sha256: "a".repeat(64),
    createdAt: 1,
  };
}
async function settle() {
  await flushMicrotasks();
  await flushMicrotasks();
}
async function selectB() {
  const onSelectSession = sidebarProps?.onSelectSession;
  expect(typeof onSelectSession).toBe("function");
  await act(async () => {
    onSelectSession("repoA", "session-b");
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ sessionId: "engine-b" });
  expect(chatProps?.configurationAvailable).toBe(true);
  expect(chatProps?.conversationRootStatus).toBe("ok");
  expect(chatProps?.conversationRoot).toBe("/fixture/repo-a");
  expect(chatProps?.conversationRootId).toBe("root-a");
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
async function submitText(text: string) {
  expect(chatProps?.busy).toBe(false);
  expect(Boolean(chatProps?.composerDisabled)).toBe(false);
  await act(async () => {
    propsOf(find((props) => props.rows === 1)).onChange({
      target: { value: text, selectionStart: text.length },
    });
    await settle();
  });
  expect(chatProps?.draft).toBe(text);
  let prevented = false;
  await act(async () => {
    const textarea = find((props) => props.rows === 1);
    propsOf(textarea).onKeyDown({
      key: "Enter",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      nativeEvent: { isComposing: false },
      currentTarget: textarea,
      preventDefault() {
        prevented = true;
      },
    });
    await settle();
  });
  expect(prevented).toBe(true);
  expect(sendCalls).toHaveLength(1);
}
async function preparePdfDraft(path: string) {
  const create = sidebarProps?.onNewConversationForProject;
  expect(typeof create).toBe("function");
  await act(async () => {
    create("repoA");
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ projectId: "repoA" });
  await dropPdf(path);
  const index = JSON.parse(storage.getItem("codeshell.sessionIndex.repoA")!);
  const owner = index.sessions.find((session: any) => session.id === index.activeSessionId);
  expect(owner).toBeDefined();
  expect(owner.pendingFirstRun).toBe(true);
  expect(owner.engineSessionId).toBeUndefined();
  return owner;
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
  imageReads.length = 0;
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

test("an A-owned staged result cannot enter the selected B composer", async () => {
  await pick();
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(1);
  expect(staged[0].input.sessionId).toBe("engine-a");
  await selectB();
  await act(async () => {
    staged[0].result.resolve(imageMeta(staged[0].input));
    await settle();
  });
  expect(chatProps?.attachments).toEqual([]);
});

test("a delayed FileReader from A does not stage in or show an error in B", async () => {
  await pick();
  expect(staged).toHaveLength(0);
  await selectB();
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(0);
  expect(chatProps?.attachments).toEqual([]);
  expect(renderedText()).not.toContain("当前会话还没有可用的附件保存目录");
});

test("a rejected A stage does not leak its stale error into B", async () => {
  await pick();
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(1);
  await selectB();
  await act(async () => {
    staged[0].result.reject(new Error("owned-A-stage-error"));
    await settle();
  });
  expect(renderedText()).not.toContain("owned-A-stage-error");
  expect(chatProps?.attachments).toEqual([]);
});

test("the actual file-panel image handler cannot append A's delayed read to B", async () => {
  await act(async () => {
    chatProps?.onAttachImagePath?.("/fixture/repo-a/from-A.png");
    await settle();
  });
  expect(imageReads).toHaveLength(1);
  expect(imageReads[0].input).toEqual([
    "/fixture/repo-a/from-A.png",
    { cwd: "/fixture/repo-a", sessionId: "engine-a" },
  ]);
  await selectB();
  await act(async () => {
    imageReads[0].result.resolve("data:image/png;base64,eA==");
    await settle();
  });
  expect(chatProps?.attachments).toEqual([]);
});

test("the current A composer accepts its exact staged attachment once", async () => {
  await act(async () => {
    propsOf(find((props) => props.rows === 1)).onChange({
      target: { value: "keep A's unsent draft", selectionStart: 21 },
    });
    await settle();
  });
  const controls = {
    draft: chatProps?.draft,
    model: chatProps?.activeModelKey,
    permission: chatProps?.permissionMode,
  };
  await pick();
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(1);
  const meta = imageMeta(staged[0].input);
  await act(async () => {
    staged[0].result.resolve(meta);
    await settle();
  });
  expect(chatProps?.attachments).toHaveLength(1);
  const { kind: _kind, ...attachmentMeta } = meta;
  expect(chatProps?.attachments[0]).toMatchObject(attachmentMeta);
  expect({
    draft: chatProps?.draft,
    model: chatProps?.activeModelKey,
    permission: chatProps?.permissionMode,
  }).toEqual(controls);
  expect(imageReads).toHaveLength(0);
});

test("a current A staging failure stays visible in A", async () => {
  await pick();
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(1);
  await act(async () => {
    staged[0].result.reject(new Error("current-A-stage-error"));
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ sessionId: "engine-a" });
  expect(renderedText()).toContain("current-A-stage-error");
  expect(chatProps?.attachments).toEqual([]);
});

test("archiving A before its file read finishes prevents staging and stale errors", async () => {
  await pick();
  const archive = sidebarProps?.onArchiveSession;
  expect(typeof archive).toBe("function");
  await act(async () => {
    await archive("repoA", "session-a", true);
    await settle();
  });
  const index = JSON.parse(storage.getItem("codeshell.sessionIndex.repoA")!);
  expect(index.sessions.find((session: any) => session.id === "session-a").archived).toBe(true);
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(0);
  expect(chatProps?.attachments).toEqual([]);
  expect(renderedText()).not.toContain("当前会话还没有可用的附件保存目录");
});

test("deleting A while its staged result is pending cannot resurrect its attachment", async () => {
  await pick();
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(1);
  const remove = sidebarProps?.onDeleteSession;
  expect(typeof remove).toBe("function");
  await act(async () => {
    remove("repoA", "session-a");
    const index = JSON.parse(storage.getItem("codeshell.sessionIndex.repoA")!);
    expect(index.sessions.some((session: any) => session.id === "session-a")).toBe(false);
    staged[0].result.resolve(imageMeta(staged[0].input));
    await settle();
  });
  expect(chatProps?.attachments).toEqual([]);
});

test("valid draft staging materializes only its own session and preserves its controls", async () => {
  const newDraft = sidebarProps?.onNewConversationForProject;
  expect(typeof newDraft).toBe("function");
  await act(async () => {
    newDraft("repoA");
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ projectId: "repoA" });
  await act(async () => {
    propsOf(find((props) => props.rows === 1)).onChange({
      target: { value: "keep the draft's own text", selectionStart: 25 },
    });
    chatProps?.onModelChange({ key: "fixture-text", label: "Fixture text", provider: "fixture" });
    chatProps?.onPermissionChange("plan");
    await settle();
  });
  const controls = {
    draft: chatProps?.draft,
    model: chatProps?.activeModelKey,
    permission: chatProps?.permissionMode,
  };
  expect(controls).toEqual({
    draft: "keep the draft's own text",
    model: "fixture-text",
    permission: "plan",
  });
  await pick("draft-image.png");
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(1);
  const index = JSON.parse(storage.getItem("codeshell.sessionIndex.repoA")!);
  const owner = index.sessions.find((session: any) => session.id === staged[0].input.sessionId);
  expect(owner).toBeDefined();
  expect(owner.pendingFirstRun).toBe(true);
  expect(index.activeSessionId).toBe(owner.id);
  expect(staged[0].input.sessionId).not.toBe("engine-a");
  expect(staged[0].input.sessionId).not.toBe("engine-b");
  await act(async () => {
    staged[0].result.resolve(imageMeta(staged[0].input));
    await settle();
  });
  expect(chatProps?.attachments).toHaveLength(1);
  expect(chatProps?.attachments[0].sessionId).toBe(owner.id);
  expect({
    draft: chatProps?.draft,
    model: chatProps?.activeModelKey,
    permission: chatProps?.permissionMode,
  }).toEqual(controls);
});

test("an invalid image leaves the real project draft unmaterialized", async () => {
  const newDraft = sidebarProps?.onNewConversationForProject;
  expect(typeof newDraft).toBe("function");
  await act(async () => {
    newDraft("repoA");
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ projectId: "repoA" });
  await act(async () => {
    propsOf(find((props) => props.type === "file")).onChange({
      target: {
        files: [new File(["<svg/>"], "invalid.svg", { type: "image/svg+xml" })],
        value: "invalid.svg",
      },
    });
    await settle();
  });
  expect(ControlledFileReader.reads).toHaveLength(0);
  expect(staged).toHaveLength(0);
  const index = JSON.parse(storage.getItem("codeshell.sessionIndex.repoA")!);
  expect(index.activeSessionId).toBeNull();
  expect(index.sessions).toHaveLength(2);
  expect(chatProps?.configurationTarget).toEqual({ projectId: "repoA" });
});

test("navigation's live owner fences a late A stage before React commits B", async () => {
  await pick();
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(1);
  const select = sidebarProps?.onSelectSession;
  expect(typeof select).toBe("function");
  await act(async () => {
    select("repoA", "session-b");
    await flushMicrotasks();
    const index = JSON.parse(storage.getItem("codeshell.sessionIndex.repoA")!);
    expect(index.activeSessionId).toBe("session-b");
    expect(chatProps?.configurationTarget).toEqual({ sessionId: "engine-a" });
    staged[0].result.resolve(imageMeta(staged[0].input));
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ sessionId: "engine-b" });
  expect(chatProps?.configurationAvailable).toBe(true);
  expect(chatProps?.attachments).toEqual([]);
});

test("a completed A PDF selection is not displayed as a B composer chip", async () => {
  const path = "/fixture/repo-a/selected-A.pdf";
  await dropPdf(path);
  expect(chatProps?.configurationTarget).toEqual({ sessionId: "engine-a" });
  await selectB();
  expect(descendants(container).filter((node) => propsOf(node).title === path)).toHaveLength(0);
});

test("B's real Enter submit contains neither A's selected path nor its structured reference", async () => {
  const path = "/fixture/repo-a/selected-A.pdf";
  await dropPdf(path);
  const aBucket = chatProps?.sendBucket;
  await selectB();
  const bBucket = chatProps?.sendBucket;
  expect(typeof bBucket).toBe("string");
  expect(bBucket).not.toBe(aBucket);
  await submitText("B own text");
  expect(sendCalls[0]).toMatchObject({
    configurationTarget: { sessionId: "engine-b" },
    sendBucket: bBucket,
    opts: { bucket: bBucket },
  });
  expect({
    text: sendCalls[0].text,
    displayText: sendCalls[0].opts?.displayText,
    attachments: sendCalls[0].opts?.attachments,
  }).toEqual({ text: "B own text", displayText: "B own text", attachments: [] });
});

test("an already-visible A attachment error is not displayed after selecting B", async () => {
  await pick("already-failed-A.png");
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(1);
  await act(async () => {
    staged[0].result.reject(new Error("already-visible-A-attachment-error"));
    await settle();
  });
  expect(renderedText()).toContain("already-visible-A-attachment-error");
  await selectB();
  expect(renderedText()).not.toContain("already-visible-A-attachment-error");
});

test("A can submit its own completed PDF selection through the real composer", async () => {
  const path = "/fixture/repo-a/selected-A.pdf";
  await dropPdf(path);
  const aBucket = chatProps?.sendBucket;
  const controls = {
    model: chatProps?.activeModelKey,
    permission: chatProps?.permissionMode,
  };
  await submitText("A own text");
  expect(sendCalls[0]).toMatchObject({
    configurationTarget: { sessionId: "engine-a" },
    sendBucket: aBucket,
    opts: { bucket: aBucket },
  });
  expect(sendCalls[0].text).toContain(`- ${JSON.stringify(path)}`);
  expect(sendCalls[0].opts?.displayText).toContain(path);
  expect(sendCalls[0].opts?.attachments).toHaveLength(1);
  expect(sendCalls[0].opts?.attachments[0]).toMatchObject({
    sessionId: "engine-a",
    kind: "file",
    origin: "os-drop",
    path: "selected-A.pdf",
    absPath: path,
    relPath: "selected-A.pdf",
  });
  expect({
    model: chatProps?.activeModelKey,
    permission: chatProps?.permissionMode,
  }).toEqual(controls);
});

test("returning to A restores its own selected paths, references, and unsent controls", async () => {
  const aPath = "/fixture/repo-a/return-A.pdf";
  const bPath = "/fixture/repo-a/return-B.pdf";
  await act(async () => {
    propsOf(find((props) => props.rows === 1)).onChange({
      target: { value: "A unsent text", selectionStart: 13 },
    });
    chatProps?.onModelChange({ key: "fixture-text", label: "Fixture text", provider: "fixture" });
    chatProps?.onPermissionChange("plan");
    await settle();
  });
  await dropPdf(aPath);
  expect(chatProps?.composerMetadata).toBeDefined();
  const aMetadata = JSON.parse(JSON.stringify(chatProps?.composerMetadata));
  expect(aMetadata.localFilePaths).toEqual([aPath]);
  expect(aMetadata.inputReferences).toHaveLength(1);
  expect(aMetadata.inputReferences[0].sessionId).toBe("engine-a");
  await selectB();
  await dropPdf(bPath);
  expect(chatProps?.composerMetadata.localFilePaths).toEqual([bPath]);
  const select = sidebarProps?.onSelectSession;
  expect(typeof select).toBe("function");
  await act(async () => {
    select("repoA", "session-a");
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ sessionId: "engine-a" });
  expect(chatProps?.composerMetadata).toEqual(aMetadata);
  expect(chatProps?.draft).toBe("A unsent text");
  expect(chatProps?.activeModelKey).toBe("fixture-text");
  expect(chatProps?.permissionMode).toBe("plan");
  await submitText("return A only");
  expect(sendCalls[0].text).toContain(aPath);
  expect(sendCalls[0].text).not.toContain(bPath);
  expect(sendCalls[0].opts?.attachments).toEqual(aMetadata.inputReferences);
});

test("a PDF drop materializes its own draft metadata and a later image keeps that owner", async () => {
  const create = sidebarProps?.onNewConversationForProject;
  expect(typeof create).toBe("function");
  await act(async () => {
    create("repoA");
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ projectId: "repoA" });
  await act(async () => {
    propsOf(find((props) => props.rows === 1)).onChange({
      target: { value: "draft PDF text", selectionStart: 14 },
    });
    chatProps?.onModelChange({ key: "fixture-text", label: "Fixture text", provider: "fixture" });
    chatProps?.onPermissionChange("plan");
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ projectId: "repoA" });
  const path = "/fixture/repo-a/draft-owned.pdf";
  await dropPdf(path);
  const index = JSON.parse(storage.getItem("codeshell.sessionIndex.repoA")!);
  const owner = index.sessions.find((session: any) => session.id === index.activeSessionId);
  expect(owner).toBeDefined();
  expect(owner.pendingFirstRun).toBe(true);
  expect(owner.id).not.toBe("session-a");
  expect(owner.id).not.toBe("session-b");
  expect(chatProps?.composerMetadata).toBeDefined();
  const pdfMetadata = JSON.parse(JSON.stringify(chatProps?.composerMetadata));
  expect(pdfMetadata.localFilePaths).toEqual([path]);
  expect(pdfMetadata.inputReferences).toHaveLength(1);
  expect(pdfMetadata.inputReferences[0]).toMatchObject({
    sessionId: owner.id,
    kind: "file",
    absPath: path,
  });
  await pick("same-owner-image.png");
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(1);
  expect(staged[0].input.sessionId).toBe(owner.id);
  await act(async () => {
    staged[0].result.resolve(imageMeta(staged[0].input));
    await settle();
  });
  expect(chatProps?.composerMetadata).toEqual(pdfMetadata);
  expect(chatProps?.attachments).toHaveLength(1);
  expect(chatProps?.attachments[0].sessionId).toBe(owner.id);
  expect(chatProps?.draft).toBe("draft PDF text");
  expect(chatProps?.activeModelKey).toBe("fixture-text");
  expect(chatProps?.permissionMode).toBe("plan");
});

test("B independently submits only its own selected PDF after A's selection", async () => {
  const aPath = "/fixture/repo-a/independent-A.pdf";
  const bPath = "/fixture/repo-a/independent-B.pdf";
  await dropPdf(aPath);
  await selectB();
  await dropPdf(bPath);
  const bBucket = chatProps?.sendBucket;
  await submitText("B own PDF");
  expect(sendCalls[0]).toMatchObject({
    configurationTarget: { sessionId: "engine-b" },
    opts: { bucket: bBucket },
  });
  expect(sendCalls[0].text).toContain(bPath);
  expect(sendCalls[0].text).not.toContain(aPath);
  expect(sendCalls[0].opts?.attachments).toHaveLength(1);
  expect(sendCalls[0].opts?.attachments[0]).toMatchObject({
    sessionId: "engine-b",
    absPath: bPath,
    origin: "os-drop",
  });
});

test("an image stage error after its own draft materialization stays with that new owner", async () => {
  const create = sidebarProps?.onNewConversationForProject;
  expect(typeof create).toBe("function");
  await act(async () => {
    create("repoA");
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ projectId: "repoA" });
  await pick("materialized-failure.png");
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(1);
  const index = JSON.parse(storage.getItem("codeshell.sessionIndex.repoA")!);
  const owner = index.sessions.find((session: any) => session.id === staged[0].input.sessionId);
  expect(owner).toBeDefined();
  expect(index.activeSessionId).toBe(owner.id);
  await act(async () => {
    staged[0].result.reject(new Error("new-owner-stage-error"));
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ projectId: "repoA" });
  expect(chatProps?.configurationAvailable).toBe(true);
  expect(chatProps?.conversationRootStatus).toBe("loading");
  expect(chatProps?.engineSessionId).toBe(owner.id);
  expect(chatProps?.sendBucket).toBe(`repoA::${owner.id}`);
  expect(chatProps?.composerMetadata.attachmentError).toContain("new-owner-stage-error");
  expect(renderedText()).toContain("new-owner-stage-error");
  await selectB();
  expect(renderedText()).not.toContain("new-owner-stage-error");
  const select = sidebarProps?.onSelectSession;
  expect(typeof select).toBe("function");
  await act(async () => {
    select("repoA", owner.id);
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ projectId: "repoA" });
  expect(chatProps?.engineSessionId).toBe(owner.id);
  expect(chatProps?.sendBucket).toBe(`repoA::${owner.id}`);
  expect(renderedText()).toContain("new-owner-stage-error");
});

test("a restored pending UI row without this App's creation pin cannot stage an image", async () => {
  const index = JSON.parse(storage.getItem("codeshell.sessionIndex.repoA")!);
  const restored = index.sessions.find((session: any) => session.id === "session-b");
  delete restored.engineSessionId;
  restored.pendingFirstRun = true;
  storage.setItem("codeshell.sessionIndex.repoA", JSON.stringify(index));
  const select = sidebarProps?.onSelectSession;
  expect(typeof select).toBe("function");
  await act(async () => {
    select("repoA", "session-b");
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ projectId: "repoA" });
  expect(chatProps?.conversationRootStatus).toBe("loading");
  expect(chatProps?.engineSessionId).toBe("session-b");
  await pick("unowned-pending.png");
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(0);
  expect(renderedText()).toContain("当前会话还没有可用的附件保存目录");
});

test("an App-created row that is no longer pending cannot reuse its draft staging pin", async () => {
  const owner = await preparePdfDraft("/fixture/repo-a/invalidated-pending.pdf");
  const index = JSON.parse(storage.getItem("codeshell.sessionIndex.repoA")!);
  index.sessions.find((session: any) => session.id === owner.id).pendingFirstRun = false;
  storage.setItem("codeshell.sessionIndex.repoA", JSON.stringify(index));
  const select = sidebarProps?.onSelectSession;
  expect(typeof select).toBe("function");
  await act(async () => {
    select("repoA", owner.id);
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ projectId: "repoA" });
  await pick("no-longer-pending.png");
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(0);
});

test("a changed registered primary root cannot reuse an earlier pending staging pin", async () => {
  const owner = await preparePdfDraft("/fixture/repo-a/original-root.pdf");
  const project = loadProjects().find((item) => item.id === "repoA")!;
  expect(project.primaryRootId).toBe("root-a");
  await act(async () => {
    saveProjects([
      {
        ...project,
        path: "/fixture/replaced-root",
        primaryRootId: "root-replaced",
        roots: [
          { id: "root-replaced", path: "/fixture/replaced-root", name: "Replacement", addedAt: 2 },
        ],
      },
    ]);
    await settle();
  });
  expect(chatProps?.engineSessionId).toBe(owner.id);
  expect(chatProps?.configurationTarget).toEqual({ projectId: "repoA" });
  expect(chatProps?.conversationRoot).toBe("/fixture/replaced-root");
  expect(chatProps?.conversationRootId).toBe("root-replaced");
  await pick("changed-root.png");
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(0);
});

test("a resolved corrupt Session authority cannot reuse an App-created pending staging pin", async () => {
  const originalAuthority = window.codeshell.getSessionWorkspaceAuthority;
  Object.assign(window.codeshell, {
    getSessionWorkspaceAuthority: async (sessionId: string) => {
      if (sessionId === "engine-a" || sessionId === "engine-b") return originalAuthority(sessionId);
      throw new Error("fixture Session exists but its state is invalid");
    },
  });
  const owner = await preparePdfDraft("/fixture/repo-a/corrupt-authority.pdf");
  expect(chatProps?.engineSessionId).toBe(owner.id);
  expect(chatProps?.configurationTarget).toEqual({ sessionId: owner.id });
  expect(chatProps?.configurationAvailable).toBe(false);
  expect(chatProps?.conversationRootStatus).toBe("unavailable");
  await pick("corrupt-authority.png");
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(0);
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import type { RendererConfigurationTarget, SessionWorkspaceAuthority } from "../preload/types";

// The real renderer and its real attachment handlers run against an inert bridge.
// No Main/Core, native transport, browser, media device, or provider is invoked.
const deniedCalls: string[] = [];
const children = createRequire(import.meta.url)("node:child_process");
const childNames = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
// The shard shares one process, so these denials must not outlive this file.
const originalChildren = Object.fromEntries(childNames.map((name) => [name, children[name]]));
const originalKill = process.kill;
for (const name of childNames) {
  children[name] = () => {
    deniedCalls.push(`child_process.${name}`);
    throw new Error(`Native transport denied: ${name}`);
  };
}
process.kill = () => {
  deniedCalls.push("process.kill");
  throw new Error("Native signal denied");
};
syncBuiltinESMExports();
const denied = () => {
  deniedCalls.push("renderer transport");
  throw new Error("Unexpected renderer transport");
};
const originalFetch = globalThis.fetch;
const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
globalThis.fetch = denied;
Object.defineProperty(globalThis, "Worker", { configurable: true, value: denied });
Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: denied });
const denyQRCode = () => {
  deniedCalls.push("qrcode");
  throw new Error("Unexpected QR code rendering");
};
mock.module("qrcode", () => ({
  default: Object.assign(denyQRCode, { toDataURL: denyQRCode }),
  toDataURL: denyQRCode,
}));

let chatProps: Record<string, any> | null = null;
let sidebarProps: Record<string, any> | null = null;
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
const { ChatView: ActualChatView } = await import("./ChatView.tsx?attachment-quantity");
mock.module("./ChatView", () => ({
  ChatView(props: Record<string, any>) {
    chatProps = props;
    return <ActualChatView {...props} onSend={denied} />;
  },
}));
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { App } = await import("./App.tsx?attachment-quantity");

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
  file: File | null = null;
  finished = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(file: File) {
    this.file = file;
    ControlledFileReader.reads.push(this);
  }
  finish() {
    if (this.finished) throw new Error("Controlled reader was completed twice");
    this.finished = true;
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
      readImageDataUrl: denied,
      run: denied,
      send: denied,
      spawn: denied,
      fork: denied,
      transcribeAudio: denied,
    },
  });
}
function imageMeta(input: Record<string, any>, index: number) {
  return {
    id: `owned-image-${index}`,
    kind: "image",
    name: input.name,
    mime: input.mime,
    sessionId: input.sessionId,
    origin: input.origin,
    path: `.code-shell/attachments/${input.sessionId}/image-${index}.png`,
    absPath: `/fixture/repo-a/.code-shell/attachments/${input.sessionId}/image-${index}.png`,
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
  expect(chatProps?.imageDetail === undefined || chatProps?.imageDetail === "high").toBe(true);
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
  expect(deniedCalls).toEqual([]);
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

// All images enter through the actual file-input handler. The fixture never
// calls App setters or replaces its append updater with an implementation copy.
function attachments(): Array<Record<string, any>> {
  return JSON.parse(JSON.stringify(chatProps?.attachments ?? []));
}
function expectOriginals(original: Array<Record<string, any>>) {
  const current = attachments();
  for (const previous of original) {
    expect(current.find((image) => image.id === previous.id)).toEqual(previous);
  }
}
async function seedCompletedImages(count: number) {
  for (let index = 0; index < count; index++) {
    const readStart = ControlledFileReader.reads.length;
    const stageStart = staged.length;
    await pick(`seed-${index}.png`);
    expect(ControlledFileReader.reads).toHaveLength(readStart + 1);
    expect(staged).toHaveLength(stageStart);
    await act(async () => {
      ControlledFileReader.reads[readStart].finish();
      await settle();
    });
    expect(staged).toHaveLength(stageStart + 1);
    expect(staged[stageStart].input.sessionId).toBe("engine-a");
    await act(async () => {
      staged[stageStart].result.resolve(imageMeta(staged[stageStart].input, stageStart));
      await settle();
    });
    expect(attachments()).toHaveLength(index + 1);
  }
  return attachments();
}
async function startParallelPair() {
  const readStart = ControlledFileReader.reads.length;
  const stageStart = staged.length;
  const onChange = propsOf(find((props) => props.type === "file")).onChange;
  expect(typeof onChange).toBe("function");
  // Both calls use the same committed render; neither controlled read finishes
  // before the second selection begins.
  await act(async () => {
    for (const name of ["parallel-first.png", "parallel-second.png"]) {
      onChange({
        target: { files: [new File(["x"], name, { type: "image/png" })], value: name },
      });
    }
    await settle();
  });
  return { readStart, stageStart };
}
async function finishCreatedPair(start: { readStart: number; stageStart: number }) {
  // Two finite inputs can each create at most one reader and stage. A correct
  // reservation may reject before either step, or defer a step behind the first
  // reply. Drain only actually created work over these two bounded passes.
  const completedStages = new Set<object>();
  for (let pass = 0; pass < 2; pass++) {
    await act(async () => {
      for (const reader of ControlledFileReader.reads.slice(start.readStart)) {
        if (!reader.finished) reader.finish();
      }
      await settle();
    });
    const requests = staged.slice(start.stageStart);
    for (let index = requests.length - 1; index >= 0; index--) {
      const request = requests[index];
      if (completedStages.has(request)) continue;
      completedStages.add(request);
      await act(async () => {
        request.result.resolve(imageMeta(request.input, start.stageStart + index));
        await settle();
      });
    }
  }
  const readers = ControlledFileReader.reads.slice(start.readStart);
  const requests = staged.slice(start.stageStart);
  const returned = requests.map((request, offset) =>
    imageMeta(request.input, start.stageStart + offset),
  );
  return { readers, requests, returned };
}
function recordObservation(
  name: string,
  original: Array<Record<string, any>>,
  result: Awaited<ReturnType<typeof finishCreatedPair>>,
) {
  const observation = {
    name,
    readerCount: result.readers.length,
    readerNames: result.readers.map((reader) => reader.file?.name),
    stageCount: result.requests.length,
    stageInputs: result.requests.map(({ input }) => ({
      sessionId: input.sessionId,
      name: input.name,
      origin: input.origin,
    })),
    original,
    final: attachments(),
    visibleOverflow: renderedText().includes("最多 6 张图片"),
  };
  // Preserve actual quantities and state in the guarded raw log before any
  // desired overflow assertion. This is not native or Main evidence.
  console.log("ATTACHMENT_QUANTITY_OBSERVATION " + JSON.stringify(observation));
  return observation;
}

test("parallel picks cannot overflow the six-image composer limit", async () => {
  const original = await seedCompletedImages(5);
  const start = await startParallelPair();
  const result = await finishCreatedPair(start);
  const observation = recordObservation("overflow-from-five", original, result);
  expect(result.readers.length).toBeLessThanOrEqual(2);
  expect(result.requests.length).toBeLessThanOrEqual(2);
  expectOriginals(original);
  expect(chatProps?.configurationTarget).toEqual({ sessionId: "engine-a" });
  expect(observation.final.length).toBeLessThanOrEqual(6);
  expect(observation.visibleOverflow).toBe(true);
});

test("serial sixth succeeds and seventh is refused before reading", async () => {
  const original = await seedCompletedImages(5);
  const readStart = ControlledFileReader.reads.length;
  const stageStart = staged.length;
  await pick("serial-sixth.png");
  expect(ControlledFileReader.reads).toHaveLength(readStart + 1);
  await act(async () => {
    ControlledFileReader.reads[readStart].finish();
    await settle();
  });
  expect(staged).toHaveLength(stageStart + 1);
  const sixth = imageMeta(staged[stageStart].input, stageStart);
  await act(async () => {
    staged[stageStart].result.resolve(sixth);
    await settle();
  });
  const six = attachments();
  expect(six).toHaveLength(6);
  expectOriginals(original);
  expect(six.find((image) => image.id === sixth.id)?.name).toBe("serial-sixth.png");
  const seventhStart = {
    readStart: ControlledFileReader.reads.length,
    stageStart: staged.length,
  };
  await pick("serial-seventh.png");
  const result = await finishCreatedPair(seventhStart);
  const observation = recordObservation("serial-seventh", six, result);
  expect(result.readers).toHaveLength(0);
  expect(result.requests).toHaveLength(0);
  expect(attachments()).toEqual(six);
  expect(observation.visibleOverflow).toBe(true);
});

test("a concurrent pair within capacity retains both independent results", async () => {
  const original = await seedCompletedImages(4);
  const start = await startParallelPair();
  const result = await finishCreatedPair(start);
  const observation = recordObservation("under-capacity-from-four", original, result);
  expect(result.readers).toHaveLength(2);
  expect(result.requests).toHaveLength(2);
  expect(result.requests.map(({ input }) => input.sessionId)).toEqual(["engine-a", "engine-a"]);
  expectOriginals(original);
  expect(observation.final).toHaveLength(6);
  for (const meta of result.returned) {
    const { kind: _kind, ...expected } = meta;
    expect(observation.final.find((image) => image.id === meta.id)).toMatchObject(expected);
  }
  expect(new Set(observation.final.map((image) => image.id)).size).toBe(6);
  expect(observation.visibleOverflow).toBe(false);
});

test("an overflowing staged batch preserves its own validation error", async () => {
  const original = await seedCompletedImages(5);
  const readStart = ControlledFileReader.reads.length;
  const stageStart = staged.length;
  const onChange = propsOf(find((props) => props.type === "file")).onChange;
  expect(typeof onChange).toBe("function");
  await act(async () => {
    // Both are images to the real picker router, but BMP is rejected by the
    // actual image MIME validator without creating a third FileReader.
    onChange({
      target: {
        files: [
          new File(["x"], "unsupported.bmp", { type: "image/bmp" }),
          new File(["x"], "mixed-first.png", { type: "image/png" }),
        ],
        value: "mixed",
      },
    });
    onChange({
      target: {
        files: [new File(["x"], "clean-second.png", { type: "image/png" })],
        value: "clean",
      },
    });
    await settle();
  });
  await act(async () => {
    for (const reader of ControlledFileReader.reads.slice(readStart)) reader.finish();
    await settle();
  });
  const requests = staged.slice(stageStart);
  expect(requests).toHaveLength(2);
  const clean = requests.find((request) => request.input.name === "clean-second.png");
  const mixed = requests.find((request) => request.input.name === "mixed-first.png");
  expect(clean).toBeDefined();
  expect(mixed).toBeDefined();
  // The clean reply takes the last slot. The mixed batch then has both a
  // genuine earlier validation error and a latest-state capacity overflow.
  for (const request of [clean!, mixed!]) {
    await act(async () => {
      request.result.resolve(imageMeta(request.input, staged.indexOf(request)));
      await settle();
    });
  }
  const observation = recordObservation("validation-and-overflow", original, {
    readers: ControlledFileReader.reads.slice(readStart),
    requests,
    returned: requests.map((request) => imageMeta(request.input, staged.indexOf(request))),
  });
  expectOriginals(original);
  expect(observation.final).toHaveLength(6);
  expect(observation.final.some((image) => image.name === "clean-second.png")).toBe(true);
  expect(observation.final.some((image) => image.name === "mixed-first.png")).toBe(false);
  expect(observation.visibleOverflow).toBe(true);
  expect(renderedText()).toContain("不支持的文件类型：image/bmp");
});

test("a late overflowing A reply cannot set B metadata or mutate the invalidated A owner", async () => {
  const original = await seedCompletedImages(5);
  const start = await startParallelPair();
  await act(async () => {
    for (const reader of ControlledFileReader.reads.slice(start.readStart)) reader.finish();
    await settle();
  });
  const requests = staged.slice(start.stageStart);
  expect(requests).toHaveLength(2);
  await act(async () => {
    requests[0].result.resolve(imageMeta(requests[0].input, start.stageStart));
    await settle();
  });
  const six = attachments();
  expect(six).toHaveLength(6);
  expectOriginals(original);
  const onSelectSession = sidebarProps?.onSelectSession;
  expect(typeof onSelectSession).toBe("function");
  await act(async () => {
    onSelectSession("repoA", "session-b");
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ sessionId: "engine-b" });
  expect(chatProps?.configurationAvailable).toBe(true);
  expect(attachments()).toEqual([]);
  await act(async () => {
    requests[1].result.resolve(imageMeta(requests[1].input, start.stageStart + 1));
    await settle();
  });
  expect(attachments()).toEqual([]);
  expect(renderedText()).not.toContain("最多 6 张图片");
  await act(async () => {
    const select = sidebarProps?.onSelectSession;
    expect(typeof select).toBe("function");
    select("repoA", "session-a");
    await settle();
  });
  expect(chatProps?.configurationTarget).toEqual({ sessionId: "engine-a" });
  expect(chatProps?.configurationAvailable).toBe(true);
  const observation = recordObservation("late-A-after-owner-switch", six, {
    readers: ControlledFileReader.reads.slice(start.readStart),
    requests,
    returned: requests.map((request) => imageMeta(request.input, staged.indexOf(request))),
  });
  expect(observation.final).toEqual(six);
  expect(observation.visibleOverflow).toBe(false);
});

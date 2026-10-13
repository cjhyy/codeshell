import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import net from "node:net";
import tls from "node:tls";

if (
  !process.env.CODE_SHELL_TEST_HOME ||
  !process.env.HOME?.includes("codeshell-bun-completion-")
)
  throw Error("guarded HOME required");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(
  `${repo}/scripts/runtime-cost-smoke-isolation.mjs`
);
installLocalNetworkGuard("http://127.0.0.1:9");
const deny = () => {
  throw Error("NETWORK_FORBIDDEN_round14");
};
net.connect = net.createConnection = deny as any;
tls.connect = deny as any;
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const { default: ts } = await import(
  `${repo}/node_modules/typescript/lib/typescript.js`
);
const { SessionManager } = await import(
  `${repo}/packages/core/src/session/session-manager.ts`
);
const { getProjectStore, __resetProjectStoreForTest } = await import(
  `${repo}/packages/desktop/src/main/project-store.ts`
);
const { requireRendererProjectPath, requireRendererProjectRoot } = await import(
  `${repo}/packages/desktop/src/main/renderer-project-path.ts`
);
const workspace = await import(
  `${repo}/packages/desktop/src/main/session-workspace-service.ts`
);
const sessionFs = await import(
  `${repo}/packages/desktop/src/main/session-fs-service.ts`
);
const fsService = await import(
  `${repo}/packages/desktop/src/main/fs-service.ts`
);
const { readImageDataUrl } = await import(
  `${repo}/packages/desktop/src/main/image-read-service.ts`
);
const { readLocalFilePreview } = await import(
  `${repo}/packages/desktop/src/main/local-file-preview-service.ts`
);
const { registerLocalFilePreviewIpc } = await import(
  `${repo}/packages/desktop/src/main/local-file-preview-ipc.ts`
);
const { createRoot } = await import(
  `${repo}/packages/desktop/node_modules/react-dom/client`
);
const { ensureMiniDom, flushMicrotasks } = await import(
  `${repo}/packages/desktop/src/renderer/test-utils/renderHook.tsx`
);
const { FilesPanel } = await import(
  `${repo}/packages/desktop/src/renderer/panels/FilesPanel.tsx`
);
const { usePanelWorkspaceRoot } = await import(
  `${repo}/packages/desktop/src/renderer/panels/usePanelWorkspaceRoot.ts`
);
const { trackedProjectFromRegistry } = await import(
  `${repo}/packages/desktop/src/renderer/projects.ts`
);

ensureMiniDom();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem() {}, removeItem() {} },
});
const proto = Object.getPrototypeOf(document.createElement("button"));
if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
let root: any,
  container: any,
  temporary = "";
let cleanupPermissions = () => {};
const nodes = (node: any): any[] => [
  node,
  ...Array.from(node?.childNodes ?? []).flatMap(nodes),
];
function props(node: any): any {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function text(node: any): string {
  return node.nodeType === 3
    ? (node.nodeValue ?? node.textContent ?? "")
    : Array.from(node.childNodes ?? [])
        .map(text)
        .join("") ||
        (typeof node.textContent === "string" ? node.textContent : "");
}
const settle = async () => {
  await flushMicrotasks();
  await new Promise((r) => setTimeout(r, 0));
  await flushMicrotasks();
};
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  await act(settle);
  while (!check()) {
    if (Date.now() > end)
      throw Error("fixture wait timeout: " + text(container));
    await act(settle);
  }
}
async function render(element: any) {
  await act(async () => {
    root.render(element);
    await settle();
  });
}
async function mount(element: any) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await render(element);
}
function button(name: string) {
  return nodes(container).find(
    (n) => n.tagName === "BUTTON" && text(n) === name,
  );
}
async function clickName(name: string) {
  const node = button(name);
  expect(node).toBeDefined();
  await act(async () => {
    props(node).onClick();
    await settle();
  });
}
async function refresh() {
  const node = nodes(container).find(
    (n) =>
      n.tagName === "BUTTON" &&
      /刷新|Refresh/.test(props(n)["aria-label"] ?? ""),
  );
  expect(node).toBeDefined();
  await act(async () => {
    props(node).onClick();
    await settle();
  });
}
async function selectRoot(id: string) {
  const node = nodes(container).find((n) => n.tagName === "SELECT");
  expect(node).toBeDefined();
  await act(async () => {
    props(node).onChange({ target: { value: id } });
    await settle();
  });
}
function actualMainHandler(channel: string, scope: any) {
  const source = ts.createSourceFile(
    "index.ts",
    readFileSync(`${repo}/packages/desktop/src/main/index.ts`, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let callback: any;
  function visit(node: any) {
    if (
      ts.isCallExpression(node) &&
      node.arguments[0]?.getText(source) === JSON.stringify(channel)
    )
      callback = node.arguments.find((arg: any) => ts.isArrowFunction(arg));
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(callback).toBeDefined();
  const js = ts.transpileModule(`const handler = ${callback.getText(source)}`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  return runInNewContext(`${js}\nhandler`, scope);
}
function temp() {
  temporary = realpathSync(
    mkdtempSync(join(tmpdir(), "codeshell-file-navigation-")),
  );
  return temporary;
}
afterEach(async () => {
  if (root)
    await act(async () => {
      root.unmount();
      await settle();
    });
  root = undefined;
  container?.parentNode?.removeChild(container);
  container = undefined;
  cleanupPermissions();
  cleanupPermissions = () => {};
  workspace.__setSessionWorkspaceServiceProjectStoreForTests(undefined);
  workspace.__setSessionWorkspaceServiceSessionManagerForTests(undefined);
  __resetProjectStoreForTest();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = "";
});

test("R58 EXTENSION actual FilesPanel managed-worktree PNG fails Main root gate while Session text works; primary/secondary and explicit local recovery succeed", async () => {
  const dir = temp(),
    cwd = join(dir, "project"),
    secondary = join(dir, "secondary"),
    outside = join(dir, "unregistered");
  mkdirSync(cwd);
  mkdirSync(secondary);
  mkdirSync(outside);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRwoAAAAASUVORK5CYII=",
    "base64",
  );
  writeFileSync(join(cwd, "note.txt"), "actual managed workspace text\n");
  writeFileSync(join(cwd, "picture.png"), png);
  writeFileSync(join(secondary, "secondary.png"), png);
  writeFileSync(join(outside, "outside.png"), png);
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "fixture"]);
  const store = getProjectStore();
  let project = await store.createFromPath(cwd);
  project = (await store.addRoot(project.id, secondary)).project;
  const secondaryRoot = project.roots.find((r) => r.path === secondary)!;
  const sm = new SessionManager(join(dir, "sessions")),
    sid = "files-managed-session";
  sm.create(cwd, "fixture-model", "fixture-provider", sid);
  sm.updateSessionState(sid, {
    project: { projectId: project.id, mainRootId: project.primaryRootId },
  });
  workspace.__setSessionWorkspaceServiceProjectStoreForTests(store);
  workspace.__setSessionWorkspaceServiceSessionManagerForTests(sm);
  const switched = await workspace.switchSessionWorkspaceForUi(
    sid,
    cwd,
    "files-fixture",
  );
  writeFileSync(join(cwd, "primary-only.png"), png);
  const authority = await workspace.getSessionWorkspaceAuthorityForUi(sid);
  expect(authority.rootStatus).toBe("ok");
  expect(authority.workspace.kind).toBe("worktree");
  expect(
    await workspace.requireSessionFileRootForUi(sid, project.primaryRootId),
  ).toBe(switched.current.root);
  expect(
    (await store.list())
      .flatMap((p) => p.roots)
      .some((r) => r.path === switched.current.root),
  ).toBe(false);
  const imageHandler = actualMainHandler("images:readDataUrl", {
    requireRendererProjectPath,
    readImageDataUrl,
  });
  const requests: any[] = [],
    errors: string[] = [],
    localReads: string[] = [],
    textReads: any[] = [];
  const localHandlers = new Map<string, any>(),
    sender = { mainFrame: {} };
  registerLocalFilePreviewIpc(
    {
      handle: (name: string, fn: any) => {
        localHandlers.set(name, fn);
      },
    } as any,
    (candidate) => candidate === sender,
  );
  const localEvent = { sender, senderFrame: sender.mainFrame };
  let onChanged: any;
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      getSessionWorkspaceAuthority: workspace.getSessionWorkspaceAuthorityForUi,
      onWorkspaceChanged: (fn: any) => {
        onChanged = fn;
        return () => {
          onChanged = undefined;
        };
      },
      readSessionDir: sessionFs.readSessionDirectoryForUi,
      readSessionFileContent: async (...args: any[]) => {
        textReads.push(args);
        return (sessionFs.readSessionFileForUi as any)(...args);
      },
      readImageDataUrl: async (path: string, context: any) => {
        requests.push({ path, context });
        try {
          return await imageHandler({}, { absPath: path, ...context });
        } catch (e) {
          errors.push(String(e));
          throw e;
        }
      },
      readLocalFilePreview: async (path: string) => {
        localReads.push(path);
        return localHandlers.get("fsLocal:readPreview")(localEvent, path);
      },
    },
  });
  let renderedWorkspace: any;
  function Host() {
    const w = usePanelWorkspaceRoot(sid, cwd);
    renderedWorkspace = w;
    return w.root ? (
      <FilesPanel
        cwd={w.root}
        project={trackedProjectFromRegistry(project)}
        engineSessionId={sid}
        sessionMainRootId={w.mainRootId ?? undefined}
      />
    ) : null;
  }
  await mount(<Host />);
  await until(() => !!button("note.txt") && !!button("picture.png"));
  await clickName("note.txt");
  await until(() => text(container).includes("actual managed workspace text"));
  expect(textReads.at(-1)).toEqual([
    sid,
    project.primaryRootId,
    join(switched.current.root, "note.txt"),
  ]);
  await clickName("picture.png");
  await until(() => /无法预览|Cannot preview/.test(text(container)));
  expect(requests.at(-1)).toEqual({
    path: join(switched.current.root, "picture.png"),
    context: { cwd: switched.current.root },
  });
  expect(errors.at(-1)).toContain(
    "project path is not registered with CodeShell",
  );
  expect(nodes(container).some((n) => n.tagName === "IMG")).toBe(false);
  expect(localReads).toEqual([]);
  const imageReadsBeforeRefresh = requests.length;
  await refresh();
  await until(
    () =>
      requests.length > imageReadsBeforeRefresh &&
      /无法预览|Cannot preview/.test(text(container)),
  );
  expect(
    await readImageDataUrl(join(switched.current.root, "picture.png"), {
      cwd: switched.current.root,
    }),
  ).toBe(`data:image/png;base64,${png.toString("base64")}`);
  await expect(
    imageHandler({}, { absPath: join(outside, "outside.png"), cwd: outside }),
  ).rejects.toThrow("project path is not registered with CodeShell");
  await expect(
    imageHandler(
      {},
      {
        absPath: join(switched.current.root, "picture.png"),
        cwd: switched.current.root,
        sessionId: sid,
      },
    ),
  ).rejects.toThrow("project path is not registered with CodeShell");
  await act(async () => {
    await workspace.switchSessionWorkspaceForUi(sid, cwd, "main");
    onChanged({ sessionId: sid });
    await settle();
  });
  await until(
    () =>
      renderedWorkspace.ready &&
      renderedWorkspace.root === cwd &&
      !!button("primary-only.png"),
  );
  await clickName("primary-only.png");
  await until(() => nodes(container).some((n) => n.tagName === "IMG"));
  expect(requests.at(-1).context.cwd).toBe(cwd);
  expect(
    props(nodes(container).find((n) => n.tagName === "IMG")).src,
  ).toContain(png.toString("base64"));
  expect(
    await imageHandler(
      {},
      { absPath: join(switched.current.root, "picture.png"), cwd },
    ),
  ).toBeNull();
  await selectRoot(secondaryRoot.id);
  await until(() => !!button("secondary.png"));
  await clickName("secondary.png");
  await until(() => nodes(container).some((n) => n.tagName === "IMG"));
  expect(requests.at(-1).context.cwd).toBe(secondary);
  await act(async () => {
    root.unmount();
    await settle();
  });
  root = createRoot(container);
  await render(
    <FilesPanel
      cwd={cwd}
      project={trackedProjectFromRegistry(project)}
      engineSessionId={sid}
      sessionMainRootId={project.primaryRootId}
      revealFile={{
        path: join(switched.current.root, "picture.png"),
        cwd: null,
        nonce: 1,
      }}
    />,
  );
  await until(() => nodes(container).some((n) => n.tagName === "IMG"));
  expect(localReads).toEqual([join(switched.current.root, "picture.png")]);
  await expect(
    localHandlers.get("fsLocal:readPreview")(
      { sender, senderFrame: {} },
      join(switched.current.root, "picture.png"),
    ),
  ).rejects.toThrow("Desktop main window");
  console.log(
    JSON.stringify({
      extensionOf: "R58",
      actualFilesPanelEntry: true,
      managedRootStatus: authority.rootStatus,
      sessionTextReadSucceeded: true,
      pngFailedAtMainProjectGate: true,
      refreshStillFails: true,
      explicitSessionIdDoesNotBypassCwdGate: true,
      primaryAndSecondaryPreviewSucceeded: true,
      arbitraryRootRejected: true,
      primaryCwdCannotAuthorizeSiblingWorktreeImage: true,
      explicitSingleFilePreviewAfterSwitchingToMainSucceeded: true,
      localPreviewSubframeDenied: true,
      nativeElectronStarted: false,
    }),
  );
});

test("CANDIDATE directory EACCES is silently rendered as empty; same permission repair and refresh restore real entries", async () => {
  if (process.getuid?.() === 0)
    throw Error("nonroot UID required for actual EACCES control");
  const dir = temp(),
    cwd = join(dir, "project"),
    denied = join(cwd, "denied"),
    empty = join(cwd, "empty");
  mkdirSync(cwd);
  mkdirSync(denied);
  mkdirSync(empty);
  writeFileSync(join(denied, "retained.txt"), "retained on disk");
  const store = getProjectStore(),
    project = await store.createFromPath(cwd),
    failures: any[] = [];
  const readDirHandler = actualMainHandler("fsRoot:readDir", {
    requireRendererProjectRoot,
    readDirectory: fsService.readDirectory,
  });
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      readProjectDir: async (...args: any[]) => {
        try {
          return await readDirHandler({}, ...args);
        } catch (error: any) {
          failures.push({
            code: error.code,
            dir: args[2],
            message: error.message,
          });
          throw error;
        }
      },
      readProjectFileContent: async () => {
        throw Error("not used");
      },
    },
  });
  cleanupPermissions = () => chmodSync(denied, 0o700);
  chmodSync(denied, 0o000);
  await mount(
    <FilesPanel cwd={cwd} project={trackedProjectFromRegistry(project)} />,
  );
  await until(() => !!button("denied") && !!button("empty"));
  await clickName("empty");
  await settle();
  expect(failures).toEqual([]);
  await clickName("denied");
  await until(() => failures.length === 1);
  await act(settle);
  expect(failures[0]).toMatchObject({ code: "EACCES", dir: denied });
  expect(text(container)).not.toContain("retained.txt");
  expect(text(container)).not.toMatch(
    /EACCES|权限|permission|读取失败|read failed|重试|retry/i,
  );
  expect(nodes(container).some((n) => props(n).role === "alert")).toBe(false);
  expect(text(button("denied").parentNode)).toBe("denied");
  expect(text(button("empty").parentNode)).toBe("empty");
  chmodSync(denied, 0o700);
  await refresh();
  await until(() => !!button("retained.txt"));
  expect(readFileSync(join(denied, "retained.txt"), "utf8")).toBe(
    "retained on disk",
  );
  expect(failures).toHaveLength(1);
  console.log(
    JSON.stringify({
      candidate: "directory-read-error",
      error: failures[0].code,
      failedAndEmptyFolderBothHaveNoChildrenOrError: true,
      fileRetained: true,
      permissionRepairThenRefreshRecovers: true,
      actualMainHandlerAndFsService: true,
      uid: process.getuid?.(),
    }),
  );
});

test("BOUNDARY secondary-root pending directory read retains previous-root rows; superseded late response cannot overwrite final root", async () => {
  const dir = temp(),
    cwd = join(dir, "primary"),
    secondary = join(dir, "secondary");
  mkdirSync(cwd);
  mkdirSync(secondary);
  writeFileSync(join(cwd, "from-primary.txt"), "primary");
  writeFileSync(join(secondary, "from-secondary.txt"), "secondary");
  const store = getProjectStore();
  let project = await store.createFromPath(cwd);
  project = (await store.addRoot(project.id, secondary)).project;
  const secondaryRoot = project.roots.find((r) => r.path === secondary)!;
  let release: any,
    delayedCalls = 0;
  const secondaryReplyGate = new Promise((resolve) => {
    release = resolve;
  });
  const readDirHandler = actualMainHandler("fsRoot:readDir", {
    requireRendererProjectRoot,
    readDirectory: fsService.readDirectory,
  });
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      readProjectDir: async (...args: any[]) => {
        const result = await readDirHandler({}, ...args);
        if (args[1] === secondaryRoot.id) {
          delayedCalls++;
          await secondaryReplyGate;
        }
        return result;
      },
      readProjectFileContent: async () => {
        throw Error("not used");
      },
    },
  });
  await mount(
    <FilesPanel cwd={cwd} project={trackedProjectFromRegistry(project)} />,
  );
  await until(() => !!button("from-primary.txt"));
  await selectRoot(secondaryRoot.id);
  await until(() => delayedCalls > 0);
  const picker = nodes(container).find((n) => n.tagName === "SELECT");
  expect(props(picker).value).toBe(secondaryRoot.id);
  expect(button("from-primary.txt")).toBeDefined();
  expect(button("from-secondary.txt")).toBeUndefined();
  expect(text(container)).not.toMatch(/加载|Loading|读取失败|read failed/);
  await selectRoot(project.primaryRootId);
  await until(
    () =>
      props(nodes(container).find((n) => n.tagName === "SELECT")).value ===
      project.primaryRootId,
  );
  await act(async () => {
    release();
    await settle();
  });
  expect(button("from-primary.txt")).toBeDefined();
  expect(button("from-secondary.txt")).toBeUndefined();
  expect(delayedCalls).toBeGreaterThan(0);
  console.log(
    JSON.stringify({
      boundary: "pending-root-tree",
      secondarySelectedWhilePrimaryRowsVisible: true,
      noLoadingStateOnSubsequentRead: true,
      supersededSecondaryResponseIgnored: true,
      actualHandlerResultDelayedAtIpcBoundary: true,
      noWrongFileReadOrLossClaimed: true,
    }),
  );
});

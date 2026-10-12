import { attempts, deny, guardScope } from "./network-guard.ts";
import { afterAll, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

if (process.platform !== "darwin") throw Error("actual macOS menu source branch required; do not fake platform");
const repo = process.cwd();
const evidence = import.meta.dir;
const unusedLeafCalls: string[] = [];
const rootAdapterCalls: string[] = [];
const menuBuilds: any[] = [];
const observations: any[] = [];
let ownedRoot: string | undefined;
let applicationMenu: any;
let completed = false;

const unused = (name: string) => (..._args: any[]): never => {
  unusedLeafCalls.push(name);
  throw Error("UNUSED_PRODUCT_LEAF_CALLED:" + name);
};
// Only the non-Git owned-directory folding seam is replaced. The actual
// recents parser, filesystem read, live filtering, sorting and menu builder run.
mock.module("@cjhyy/code-shell-capability-coding/git", () => ({
  resolveProjectRoot(input: string) {
    const result = realpathSync(input);
    const inside = ownedRoot ? relative(ownedRoot, result) : "..";
    if (!ownedRoot || inside.startsWith("..") || inside.startsWith("/")) throw Error("root adapter escaped owned plain directories");
    rootAdapterCalls.push(result);
    return result;
  },
}));
// These unrelated IPC branches must never run. Mocking their leaf modules
// avoids loading profile installers or worktree operations for a menu test.
mock.module(repo + "/packages/desktop/src/main/profiles-service.ts", () => ({ listProfiles: unused("listProfiles") }));
const workspaceNames = [
  "cleanupSessionWorktreeForUi", "getSessionWorktreeDiffForUi", "getSessionWorkspaceAuthorityForUi",
  "getSessionWorkspaceForUi", "listSessionWorktreesForUi", "releaseManySessionWorkspacesForUi",
  "releaseSessionWorkspaceForUi", "requireUsableSessionRootAuthority", "switchSessionWorkspaceForUi",
];
mock.module(repo + "/packages/desktop/src/main/session-workspace-service.ts", () =>
  Object.fromEntries(workspaceNames.map(name => [name, unused(name)])));
mock.module("electron", () => ({
  app: { name: "Owned menu-recents fixture" },
  MenuItem: class {},
  BrowserWindow: { getFocusedWindow: () => { throw Error("unexpected focused-window lookup; one owned A only"); } },
  utilityProcess: { fork: deny("child", "electron.utilityProcess.fork") },
  Menu: {
    buildFromTemplate(template: any) { const menu = { items: template }; menuBuilds.push(menu); return menu; },
    setApplicationMenu(menu: any) { applicationMenu = menu; },
  },
}));

// Every product/Core import is dynamic and follows the guard and adapter setup.
const { ProjectStore } = await import(repo + "/packages/desktop/src/main/project-store.ts");
const { SessionCwdIndex } = await import(repo + "/packages/desktop/src/main/session-cwd-index.ts");
const { SessionManager } = await import(repo + "/packages/core/dist/index.js");
const recentsModule = await import(repo + "/packages/desktop/src/main/recents-store.ts");
const { registerProjectAuthorityIpc } = await import(repo + "/packages/desktop/src/main/project-authority-ipc.ts");
const { installAppMenu } = await import(repo + "/packages/desktop/src/main/menu.ts");

const sourcePaths = [
  "packages/desktop/src/main/menu.ts", "packages/desktop/src/main/project-store.ts",
  "packages/desktop/src/main/project-authority-ipc.ts", "packages/desktop/src/main/recents-store.ts",
  "packages/desktop/src/main/mounted-project-root.ts", "packages/desktop/src/main/session-cwd-index.ts",
  "packages/desktop/src/main/renderer-project-path.ts", "packages/desktop/src/main/legacy-project-migration.ts",
  "packages/desktop/src/main/index.ts", "packages/desktop/src/renderer/App.tsx",
  "packages/desktop/src/renderer/app/useSessionNavigation.ts", "packages/core/src/utils/file-mutex.ts",
  "packages/core/src/session/session-manager.ts", "packages/core/dist/index.js", "packages/core/dist/index.internal.js",
];
const sourceManifest = sourcePaths.map(path => ({ path, sha256: createHash("sha256").update(readFileSync(join(repo, path))).digest("hex") }));
const scope = {
  actual: "ProjectStore with real Core public/internal filesystem transactions and SessionManager; ProjectAuthority IPC registration/create/rename/remove/list; actual private recents.json/loadRecents; whole actual menu module",
  adapters: { electron: "owned single window and Menu template storage, not actual native API", picker: "owned plain directory only", codingGitExports: ["resolveProjectRoot"], codingGitBehavior: "realpath identity only; no Git/worktree/alias behavior", unusedLeaves: ["profiles-service.listProfiles", ...workspaceNames.map(name => "session-workspace-service." + name)] },
  notExecuted: ["Engine", "worker", "Main app entry", "renderer App", "Electron native", "models", "network", "child processes"],
  imports: "Core barrel includes Engine/provider definitions; no Engine/LLM/Host construction or invocation. Product import scope is source-audited, not a module-cache probe.",
  rebuild: "direct internal installAppMenu(A) control only; normal createWindow rebuild is source evidence, not a user recovery action performed here",
};
writeFileSync(join(evidence, "source-manifest.json"), JSON.stringify({ repo, sourceManifest, scope }, null, 2));

function recentItems(): any[] {
  const fileMenu = applicationMenu.items.find((item: any) => item.label === "文件");
  const recent = fileMenu.submenu.find((item: any) => item.label === "最近项目");
  return recent.submenu;
}
const recentLabels = () => recentItems().map(item => item.label);
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

afterAll(() => {
  writeFileSync(join(evidence, "observations.json"), JSON.stringify({
    repo, completed, nativeElectronStarted: false, guardScope, networkOrChildAttempts: attempts,
    unusedLeafCalls, rootAdapterCalls, sourceManifest, scope, observations,
  }, null, 2));
});

test("successful real project IPC updates private recents disk while a single installed menu keeps stale items; internal rebuild rereads", async () => {
  const root = realpathSync(mkdtempSync(join(process.env.HOME!, "owned-menu-recents-")));
  ownedRoot = root;
  const desktop = join(root, "desktop"); mkdirSync(desktop, { mode: 0o700 });
  const folder = join(root, "owned-project"); mkdirSync(folder, { mode: 0o700 });
  const projectsFile = join(desktop, "projects.json");
  const recentsFile = join(desktop, "recents.json");
  const sessions = join(root, "sessions");
  const broadcasts: any[] = [];
  const messages: any[] = [];
  const handlers = new Map<string, Function>();
  let pickerCalls = 0, mobileBroadcasts = 0, gitSettingsCalls = 0;
  const windowA = { isDestroyed: () => false, webContents: { send(channel: string, payload?: any) {
    if (channel === "projectRegistry:changed") broadcasts.push(structuredClone(payload));
    else messages.push({ channel, payload: structuredClone(payload) });
  } } };
  const projectStore = new ProjectStore({
    file: projectsFile, recentsFile, migrationMarkerFile: join(desktop, "projects-v2-migration.json"),
    sessionIndex: new SessionCwdIndex({ sessionsRoot: sessions }),
    sessionManager: new SessionManager(sessions),
    noRepoPath: join(root, "no-repo"),
    // Same explicit owned non-Git directory seam used by actual loadRecents.
    resolveProjectRoot: (input: string) => realpathSync(input),
  });
  recentsModule.__setRecentsFileForTest(recentsFile);
  try {
    registerProjectAuthorityIpc({
      ipcMain: { handle(name: string, callback: Function) { if (handlers.has(name)) throw Error("duplicate IPC registration"); handlers.set(name, callback); } },
      getAllWindows: () => [windowA],
      showOpenDialog: async () => { pickerCalls++; return { canceled: false, filePaths: [folder] }; },
      applyGitPathFromSettings: async () => { gitSettingsCalls++; },
      projectStore, getBridge: () => undefined, getTrust: unused("getTrust"),
      assertSessionId: unused("assertSessionId"), trackGitRoot: unused("trackGitRoot"),
      broadcastMobileProjects: async () => { mobileBroadcasts++; },
      getGitStatus: unused("getGitStatus"), getGitBranches: unused("getGitBranches"),
      revealInFinder: unused("revealInFinder"), openPath: unused("openPath"),
    } as any);
    const invoke = (name: string, ...args: any[]) => {
      const handler = handlers.get(name); if (!handler) throw Error("missing actual IPC " + name);
      return handler({ sender: windowA.webContents }, ...args);
    };
    expect(await invoke("projectRegistry:list")).toEqual([]);
    await installAppMenu(windowA as any);
    const initialMenu = applicationMenu;
    expect(recentLabels()).toEqual(["(空)"]);
    expect(menuBuilds).toHaveLength(1);

    const created = await invoke("projectRegistry:createFromPicker");
    const createdDisk = readJson(projectsFile), createdRecents = readJson(recentsFile);
    const createdFresh = await recentsModule.loadRecents();
    expect(created.name).toBe(basename(folder));
    expect(createdDisk.projects[0].id).toBe(created.id);
    expect(createdRecents[0]).toMatchObject({ path: folder, name: created.name });
    expect(createdFresh.map((item: any) => item.path)).toEqual([folder]);
    expect(broadcasts.at(-1).map((project: any) => project.id)).toEqual([created.id]);
    expect(applicationMenu).toBe(initialMenu);
    expect(recentLabels()).toEqual(["(空)"]);
    expect(menuBuilds).toHaveLength(1);
    observations.push({ phase: "create-success-disk-new-menu-empty", disk: createdDisk, recentsDisk: createdRecents, freshRecents: createdFresh, labels: recentLabels(), menuBuilds: menuBuilds.length });

    // Internal normal control, not a production refresh call invented for mutation.
    await installAppMenu(windowA as any);
    const createdMenu = applicationMenu;
    expect(recentLabels()).toEqual([created.name]);
    expect(menuBuilds).toHaveLength(2);
    const renamed = await invoke("projectRegistry:rename", created.id, "Owned renamed title");
    const renamedRecents = readJson(recentsFile), renamedFresh = await recentsModule.loadRecents();
    expect(renamed.name).toBe("Owned renamed title");
    expect(readJson(projectsFile).projects[0].name).toBe(renamed.name);
    expect(renamedRecents[0].name).toBe(renamed.name);
    expect(renamedFresh[0].name).toBe(renamed.name);
    expect(broadcasts.at(-1)[0].name).toBe(renamed.name);
    expect(applicationMenu).toBe(createdMenu);
    expect(recentLabels()).toEqual([created.name]);
    expect(menuBuilds).toHaveLength(2);
    observations.push({ phase: "rename-success-disk-new-menu-old-label", recentsDisk: renamedRecents, freshRecents: renamedFresh, labels: recentLabels(), menuBuilds: menuBuilds.length });

    await installAppMenu(windowA as any);
    const renamedMenu = applicationMenu;
    expect(recentLabels()).toEqual([renamed.name]);
    expect(menuBuilds).toHaveLength(3);
    await invoke("projectRegistry:remove", created.id);
    const removedDisk = readJson(projectsFile), removedRecents = readJson(recentsFile);
    expect(removedDisk.projects[0].deletedAt).toBeNumber();
    expect(removedRecents[0].deletedAt).toBeNumber();
    expect(await recentsModule.loadRecents()).toEqual([]);
    expect(await invoke("projectRegistry:list")).toEqual([]);
    expect(broadcasts.at(-1)).toEqual([]);
    expect(applicationMenu).toBe(renamedMenu);
    expect(recentLabels()).toEqual([renamed.name]);
    expect(menuBuilds).toHaveLength(3);
    const staleItem = recentItems()[0];
    staleItem.click(staleItem, windowA, {});
    expect(messages.at(-1)).toEqual({ channel: "menu:open-recent", payload: renamedFresh[0] });
    // The captured payload comes from before remove, so timestamp is not used
    // for authority. Actual App returns when list has no matching live target.
    expect((await invoke("projectRegistry:list")).find((project: any) => project.roots.some((entry: any) => entry.path === folder))).toBeUndefined();
    expect(readJson(projectsFile).projects[0].deletedAt).toBe(removedDisk.projects[0].deletedAt);
    observations.push({ phase: "remove-success-live-registry-empty-menu-retained", disk: removedDisk, recentsDisk: removedRecents, freshRecents: [], labels: recentLabels(), staleClickMessage: messages.at(-1), appCallbackNotExecuted: true, menuBuilds: menuBuilds.length });

    await installAppMenu(windowA as any);
    expect(recentLabels()).toEqual(["(空)"]);
    expect(menuBuilds).toHaveLength(4);
    expect(pickerCalls).toBe(1);
    expect(gitSettingsCalls).toBe(1);
    expect(mobileBroadcasts).toBe(3);
    expect(broadcasts).toHaveLength(3);
    expect(rootAdapterCalls.length).toBeGreaterThan(0);
    expect(unusedLeafCalls).toEqual([]);
    expect(attempts).toEqual([]);
    observations.push({ phase: "internal-rebuild-control", labels: recentLabels(), menuBuilds: menuBuilds.length, pickerCalls, mobileBroadcasts });
    completed = true;
  } finally {
    // No live server, worker or child exists. SessionManager constructor and
    // store writes are confined to this owned private directory.
    recentsModule.__setRecentsFileForTest(null);
    rmSync(root, { recursive: true, force: true });
    ownedRoot = undefined;
  }
}, 10_000);

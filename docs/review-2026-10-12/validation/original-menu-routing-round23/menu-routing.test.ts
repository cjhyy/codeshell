import { attempts } from "./network-guard.ts";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

if (process.platform !== "darwin") throw Error("This actual-menu fixture requires macOS; do not fake process.platform");
const repo = process.cwd();
const evidence = import.meta.dir;
const observations: any[] = [];
let focused: any = null, applicationMenu: any = null;
const projectX = { id: "owned-project-x", path: join(process.env.HOME!, "owned-project-x"), name: "Owned X", lastOpenedAt: 1 };
const recents = [projectX];
let recentsLoadCalls = 0;
const menuBuilds: any[] = [];
mock.module("electron", () => ({
  app: { name: "Owned CodeShell menu fixture" },
  MenuItem: class {},
  BrowserWindow: { getFocusedWindow: () => focused },
  utilityProcess: { fork: () => { attempts.push({ kind: "child", api: "utilityProcess.fork", target: "" }); throw Error("ROUND23_UTILITY_DENIED"); } },
  Menu: {
    buildFromTemplate(template: any) { const menu = { items: template }; menuBuilds.push(menu); return menu; },
    setApplicationMenu(menu: any) { applicationMenu = menu; },
    getApplicationMenu() { return applicationMenu; },
  },
}));
// The recents directory is deliberately owned metadata. Do not import its
// Git/Core dependencies or read the operator's persisted registry.
mock.module(repo + "/packages/desktop/src/main/recents-store.ts", () => ({ loadRecents: async () => { recentsLoadCalls++; return structuredClone(recents); } }));
const { installAppMenu } = await import(repo + "/packages/desktop/src/main/menu.ts");
const ts = (await import(repo + "/node_modules/typescript/lib/typescript.js")).default;
const sourcePaths = ["packages/desktop/src/main/menu.ts", "packages/desktop/src/preload/index.ts", "packages/desktop/src/renderer/App.tsx"];
const sources = sourcePaths.map(path => ({ path, text: readFileSync(join(repo, path), "utf8") }));
const sourceManifest = sources.map(({ path, text }) => ({ path, sha256: createHash("sha256").update(text).digest("hex") }));
const preloadSource = ts.createSourceFile("preload.ts", sources[1].text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const appSource = ts.createSourceFile("App.tsx", sources[2].text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNodes(file: any, match: (node: any) => boolean): any[] {
  const found: any[] = [];
  const visit = (node: any) => { if (match(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(file); return found;
}
function one(nodes: any[], label: string): any {
  if (nodes.length !== 1) throw Error("maintained source extraction is not unique: " + label + " count=" + nodes.length);
  return nodes[0];
}
function propertyInitializer(name: string): any {
  return one(findNodes(preloadSource, node => ts.isPropertyAssignment(node) && node.name.getText(preloadSource) === name), "preload." + name).initializer;
}
const onMenuEvent = propertyInitializer("onMenuEvent"), newWindow = propertyInitializer("newWindow");
const appRegistration = one(findNodes(appSource, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.getText(appSource) === "window.codeshell.onMenuEvent"), "App menu registration");
const appCallback = appRegistration.arguments[0];
if (!ts.isArrowFunction(appCallback)) throw Error("App menu callback shape changed");
const extraction = [
  { source: sourcePaths[1], name: "onMenuEvent", line: preloadSource.getLineAndCharacterOfPosition(onMenuEvent.getStart(preloadSource)).line + 1, text: onMenuEvent.getText(preloadSource) },
  { source: sourcePaths[1], name: "newWindow", line: preloadSource.getLineAndCharacterOfPosition(newWindow.getStart(preloadSource)).line + 1, text: newWindow.getText(preloadSource) },
  { source: sourcePaths[2], name: "onMenuEvent callback", line: appSource.getLineAndCharacterOfPosition(appCallback.getStart(appSource)).line + 1, text: appCallback.getText(appSource) },
];
for (const item of extraction) (item as any).sha256 = createHash("sha256").update(item.text).digest("hex");
const transpiler = new Bun.Transpiler({ loader: "ts" });
const createPreloadMenuApi = new Function(transpiler.transformSync(`function createMenuApi(ipcRenderer) { return { onMenuEvent: ${extraction[0].text}, newWindow: ${extraction[1].text} }; }`) + "; return createMenuApi;")();
const appCode = `const { window, handleAddProject, projects, unmarkProjectPathRemoved, setActiveProjectId, trackedProjectFromRegistry, setProjects, reconcileProjectsFromDiskWithRemap, setSessionIndices, loadSessionIndex, navigateFromSidebar, setSearchOpen, setPaletteOpen, toggleSidebar } = deps; return ${extraction[2].text};`;
const createAppMenuCallback = new Function(transpiler.transformSync("function createAppCallback(deps) { " + appCode + " }") + "; return createAppCallback;")();
writeFileSync(join(evidence, "source-manifest.json"), JSON.stringify({ repo, sourceManifest, extraction, scope: "actual menu module with owned Electron/recents; exact actual preload/App callback extraction, not full App/Electron/OS" }, null, 2));

function makeWindow(id: string) {
  const listeners = new Map<string, Set<Function>>();
  const state = { id, destroyed: false, messages: [] as any[], ipcCalls: [] as any[], activeProjectId: id + "-initial-project", searchOpen: false, paletteOpen: false, sidebarToggles: 0, addProjectCalls: 0, newWindowCalls: 0 };
  const ipcRenderer = {
    on(channel: string, handler: Function) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(handler); return this; },
    removeListener(channel: string, handler: Function) { listeners.get(channel)?.delete(handler); return this; },
    async invoke(channel: string) { state.ipcCalls.push(channel); if (channel !== "window:new") throw Error("unexpected IPC " + channel); state.newWindowCalls++; },
  };
  const api = createPreloadMenuApi(ipcRenderer);
  const callback = createAppMenuCallback({
    window: { codeshell: { ...api, projectRegistry: { list: async () => { throw Error("unexpected missing-project lookup"); } } } },
    handleAddProject: () => { state.addProjectCalls++; }, projects: [projectX], unmarkProjectPathRemoved: () => {},
    setActiveProjectId: (id: string) => { state.activeProjectId = id; },
    trackedProjectFromRegistry: (value: any) => value,
    setProjects: () => { throw Error("unexpected project list mutation"); },
    reconcileProjectsFromDiskWithRemap: () => { throw Error("unexpected reconcile"); },
    setSessionIndices: () => { throw Error("unexpected session mutation"); },
    loadSessionIndex: () => { throw Error("unexpected Session read"); },
    navigateFromSidebar: (run: Function) => run(), setSearchOpen: (value: boolean) => { state.searchOpen = value; },
    setPaletteOpen: (value: boolean) => { state.paletteOpen = value; }, toggleSidebar: () => { state.sidebarToggles++; },
  });
  const unsubscribe = api.onMenuEvent(callback);
  const win = {
    id, state, isDestroyed: () => state.destroyed,
    webContents: { send(channel: string, payload?: any) {
      state.messages.push({ channel, payload, focusedAtSend: focused?.id ?? null, destroyedAtSend: state.destroyed });
      if (state.destroyed) throw Error("OWNED_DESTROYED_WEBCONTENTS_ADAPTER");
      for (const handler of listeners.get(channel) ?? []) handler({}, payload);
    } },
    destroy() { state.destroyed = true; unsubscribe(); },
  };
  return win;
}
function menuItem(label: string): any {
  const visit = (items: any[]): any => { for (const item of items) { if (item.label === label) return item; const match = Array.isArray(item.submenu) ? visit(item.submenu) : undefined; if (match) return match; } };
  const item = visit(applicationMenu.items); if (!item?.click) throw Error("actual menu callback missing " + label); return item;
}
function click(label: string, target = focused) {
  const item = menuItem(label);
  // Electron passes the focused BrowserWindow as its second click argument.
  // Actual zero-arg callback ignores it. No keyboard event is simulated.
  item.click(item, target, { type: "owned-explicit-native-menu-callback" });
}
function snapshot(...windows: any[]) { return structuredClone(windows.map(win => win.state)); }

afterEach(() => { expect(attempts).toEqual([]); });
afterAll(() => writeFileSync(join(evidence, "observations.json"), JSON.stringify({ repo, macPlatformActual: process.platform, nativeElectronStarted: false, productMainAppWorkerCoreImported: false, productImportScopeBasis: "source-audited import list, not a dynamic module-cache probe", recentsLoadCalls, networkOrChildAttempts: attempts, sourceManifest, observations }, null, 2)));

test("single/final-installed focused window receives real menu, preload and App callbacks normally", async () => {
  const loadsBefore = recentsLoadCalls;
  const a = makeWindow("A"); focused = a; await installAppMenu(a as any);
  click("查找…"); click("命令面板…"); click("切换 侧栏"); click("Owned X"); click("添加项目…"); click("新窗口");
  expect(a.state.searchOpen).toBe(true); expect(a.state.paletteOpen).toBe(true); expect(a.state.sidebarToggles).toBe(1);
  expect(a.state.activeProjectId).toBe(projectX.id); expect(a.state.addProjectCalls).toBe(1); expect(a.state.newWindowCalls).toBe(1);
  expect(a.state.messages.length).toBe(6); expect(a.state.ipcCalls).toEqual(["window:new"]);
  const b = makeWindow("B"); focused = b; await installAppMenu(b as any); click("查找…"); click("Owned X");
  expect(b.state.searchOpen).toBe(true); expect(b.state.activeProjectId).toBe(projectX.id); expect(b.state.messages.length).toBe(2);
  expect(recentsLoadCalls - loadsBefore).toBe(2);
  observations.push({ scenario: "single-and-final-installed-window-normal", windows: snapshot(a, b) });
});

test("explicit global-menu callbacks passed focused A still update last-installed B receiver", async () => {
  const loadsBefore = recentsLoadCalls;
  const a = makeWindow("A"), b = makeWindow("B"); focused = a; await installAppMenu(a as any);
  focused = b; await installAppMenu(b as any); focused = a;
  const installed = applicationMenu;
  click("查找…", a); click("命令面板…", a); click("切换 侧栏", a); click("Owned X", a); click("添加项目…", a); click("新窗口", a);
  expect(applicationMenu).toBe(installed); expect(a.state.messages).toEqual([]);
  expect(a.state.searchOpen).toBe(false); expect(a.state.paletteOpen).toBe(false); expect(a.state.activeProjectId).toBe("A-initial-project");
  expect(b.state.searchOpen).toBe(true); expect(b.state.paletteOpen).toBe(true); expect(b.state.sidebarToggles).toBe(1);
  expect(b.state.activeProjectId).toBe(projectX.id); expect(b.state.addProjectCalls).toBe(1); expect(b.state.newWindowCalls).toBe(1);
  expect(b.state.messages.length).toBe(6); expect(b.state.messages.every(message => message.focusedAtSend === "A")).toBe(true);
  expect(recentsLoadCalls - loadsBefore).toBe(2);
  observations.push({ scenario: "focused-A-explicit-menu-delivers-B", windows: snapshot(a, b) });
});

test("closed menu target remains captured; internal rebuild restores living A without claiming production recovery", async () => {
  const loadsBefore = recentsLoadCalls;
  const a = makeWindow("A"), b = makeWindow("B"); focused = a; await installAppMenu(a as any);
  focused = b; await installAppMenu(b as any); b.destroy(); focused = a;
  const installed = applicationMenu;
  let failure: any;
  try { click("查找…", a); } catch (error) { failure = { name: (error as Error).name, message: (error as Error).message }; }
  expect(failure?.message).toBe("OWNED_DESTROYED_WEBCONTENTS_ADAPTER"); expect(applicationMenu).toBe(installed);
  expect(a.state.searchOpen).toBe(false); expect(a.state.messages).toEqual([]);
  expect(b.state.messages.length).toBe(1); expect(b.state.messages[0].destroyedAtSend).toBe(true);
  const beforeRebuild = snapshot(a, b);
  await installAppMenu(a as any); click("查找…", a); click("Owned X", a);
  expect(a.state.searchOpen).toBe(true); expect(a.state.activeProjectId).toBe(projectX.id); expect(a.state.messages.length).toBe(2);
  expect(recentsLoadCalls - loadsBefore).toBe(3);
  observations.push({ scenario: "dead-target-adapter-only-and-internal-rebuild-control", adapterFailureNotNativeElectron: failure, beforeRebuild, afterRebuild: snapshot(a, b) });
});

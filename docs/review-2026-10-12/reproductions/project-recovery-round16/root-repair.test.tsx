import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import tls from "node:tls";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded HOME required");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard("http://127.0.0.1:9");
const deny = () => { throw Error("NETWORK_FORBIDDEN_round16"); };
net.connect = net.createConnection = deny as any;
tls.connect = deny as any;
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const { SessionManager } = await import(`${repo}/packages/core/src/session/session-manager.ts`);
const { ProjectStore } = await import(`${repo}/packages/desktop/src/main/project-store.ts`);
const { SessionCwdIndex } = await import(`${repo}/packages/desktop/src/main/session-cwd-index.ts`);
const workspace = await import(`${repo}/packages/desktop/src/main/session-workspace-service.ts`);
const { registerProjectAuthorityIpc } = await import(`${repo}/packages/desktop/src/main/project-authority-ipc.ts`);
const { createRoot } = await import(`${repo}/packages/desktop/node_modules/react-dom/client`);
const { ensureMiniDom, flushMicrotasks } = await import(`${repo}/packages/desktop/src/renderer/test-utils/renderHook.tsx`);
const { ProjectGroup } = await import(`${repo}/packages/desktop/src/renderer/Sidebar.tsx`);
const { I18nProvider } = await import(`${repo}/packages/desktop/src/renderer/i18n/I18nProvider.tsx`);
const { ToastProvider } = await import(`${repo}/packages/desktop/src/renderer/ui/ToastProvider.tsx`);
const { trackedProjectFromRegistry } = await import(`${repo}/packages/desktop/src/renderer/projects.ts`);

ensureMiniDom();
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
const proto = Object.getPrototypeOf(document.createElement("button"));
if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
let temporary = "", uiRoot: any, container: any;
const nodes = (node: any): any[] => [node, ...Array.from(node?.childNodes ?? []).flatMap(nodes)];
const props = (node: any): any => { const key = Object.keys(node).find((key) => key.startsWith("__reactProps$")); return key ? node[key] : {}; };
const text = (node: any): string => node.nodeType === 3 ? node.nodeValue ?? node.textContent ?? "" : Array.from(node?.childNodes ?? []).map(text).join("") || (typeof node.textContent === "string" ? node.textContent : "");
async function settle() { await flushMicrotasks(); await new Promise((r) => setTimeout(r, 0)); await flushMicrotasks(); }
async function until(predicate: () => boolean) { const end = Date.now() + 5000; await act(settle); while (!predicate()) { if (Date.now() > end) throw Error("fixture timeout: " + text(container)); await act(settle); } }
afterEach(async () => {
  if (uiRoot) await act(async () => { uiRoot.unmount(); await settle(); });
  uiRoot = undefined; container?.parentNode?.removeChild(container); container = undefined;
  workspace.__setSessionWorkspaceServiceProjectStoreForTests(undefined);
  workspace.__setSessionWorkspaceServiceSessionManagerForTests(undefined);
  values.clear();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = "";
});

async function fixture() {
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-root-repair-round16-")));
  const primary = join(temporary, "primary"), secondary = join(temporary, "secondary"), parked = join(temporary, "secondary-parked");
  for (const dir of [primary, secondary]) { mkdirSync(dir); execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" }); }
  const sessionsRoot = join(temporary, "sessions"), sm = new SessionManager(sessionsRoot), index = new SessionCwdIndex({ sessionsRoot });
  await index.ensureLoaded();
  const store = new ProjectStore({ file: join(temporary, "projects.json"), recentsFile: join(temporary, "recents.json"), migrationMarkerFile: join(temporary, "migration.json"), sessionIndex: index, sessionManager: sm, noRepoPath: join(temporary, "no-repo") });
  const initial = await store.createFromPath(primary), project = (await store.addRoot(initial.id, secondary)).project;
  const secondaryRoot = project.roots.find((root: any) => root.path === secondary)!;
  const sid = "bound-secondary-session";
  sm.create(secondary, "fixture-model", "fixture-provider", sid);
  sm.updateSessionState(sid, { project: { projectId: project.id, mainRootId: secondaryRoot.id } });
  index.upsert(sid, { cwd: secondary, workspaceRoot: secondary, projectId: project.id, mainRootId: secondaryRoot.id });
  workspace.__setSessionWorkspaceServiceProjectStoreForTests(store);
  workspace.__setSessionWorkspaceServiceSessionManagerForTests(sm);
  const handlers = new Map<string, any>(), sent: any[] = [], migrations: any[] = [];
  registerProjectAuthorityIpc({ ipcMain: { handle: (channel: string, callback: any) => handlers.set(channel, callback) }, getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel: string, payload: any) => sent.push({ channel, payload }) } }], showOpenDialog: async () => ({ canceled: true, filePaths: [] }), applyGitPathFromSettings: async () => {}, projectStore: store, getBridge: () => undefined, getTrust: async () => "trusted", assertSessionId: (value: any) => { if (typeof value !== "string" || !value) throw Error("bad sid"); }, trackGitRoot() {}, broadcastMobileProjects: async () => {}, getGitStatus: async () => ({ branch: null, clean: true, entries: [] }), getGitBranches: async () => ({ isRepo: true, current: null, branches: [] }), revealInFinder: async () => {}, openPath: async () => "" } as any);
  Object.defineProperty(window, "codeshell", { configurable: true, value: {
    getProjectGitStatus: async () => ({ branch: null, clean: true, entries: [] }),
    getSessionWorkspaceAuthority: (id: string) => handlers.get("workspace:authority")({ sender: { id: 1 } }, id),
    getSessionWorkspace: (id: string, cwd: string) => handlers.get("workspace:current")({}, id, cwd),
    getSessionGitStatus: async () => ({ branch: null, clean: true, entries: [] }),
    projectRegistry: { migrateSessionMainRoot: async (id: string, rootId: string) => {
      try { const result = await handlers.get("projectRegistry:migrateSessionMainRoot")({}, id, rootId); migrations.push({ id, rootId, ok: true }); return result; }
      catch (error) { migrations.push({ id, rootId, ok: false, error: String(error) }); throw error; }
    } },
  } });
  async function mount() {
    container = document.createElement("div"); document.body.appendChild(container); uiRoot = createRoot(container);
    await act(async () => { uiRoot.render(<I18nProvider><ToastProvider><ProjectGroup project={trackedProjectFromRegistry(project)} index={{ sessions: [{ id: "ui-session", engineSessionId: sid, title: "Missing root task", createdAt: 1, updatedAt: 1 }], activeSessionId: null }} collapsed={false} isActiveProject={false} activeSessionId={null} statusFor={() => undefined} onToggle={() => {}} onSelectProject={() => {}} onSelectSession={() => {}} onMenuClick={() => {}} onNewChat={() => {}} onProjectContextMenu={() => {}} onSessionContextMenu={() => {}} onPinSession={() => {}} onArchiveSession={() => {}} workspaceChange={null} /></ToastProvider></I18nProvider>); await settle(); });
  }
  return { primary, secondary, parked, project, secondaryRoot, sid, sm, index, store, handlers, sent, migrations, mount, stateFile: join(sessionsRoot, sid, "state.json") };
}

test("CANDIDATE dir_missing repair to a healthy registered primary fails because migration context validates the missing source; restoration permits actual button retry", async () => {
  const f = await fixture(); renameSync(f.secondary, f.parked);
  const before = readFileSync(f.stateFile, "utf8");
  await f.mount();
  await until(() => nodes(container).some((node) => props(node)["data-session-root-status"] === "dir_missing"));
  const repair = nodes(container).find((node) => props(node)["data-repair-target-root-id"] === f.project.primaryRootId);
  expect(repair).toBeDefined();
  await act(async () => { props(repair).onClick({ stopPropagation() {} }); await settle(); });
  await until(() => f.migrations.length === 1);
  expect(f.migrations[0]).toMatchObject({ id: f.sid, rootId: f.project.primaryRootId, ok: false });
  expect(f.migrations[0].error).toContain("dir_missing");
  expect(f.migrations[0].error).toContain(f.secondary);
  expect(text(document.body)).toContain("dir_missing");
  expect(readFileSync(f.stateFile, "utf8")).toBe(before);
  expect(f.sent).toEqual([]);
  await expect(f.handlers.get("projectRegistry:removeRoot")({}, f.project.id, f.secondaryRoot.id)).rejects.toThrow("main root for sessions");
  expect(f.index.lookupCached(f.sid)?.mainRootId).toBe(f.secondaryRoot.id);
  renameSync(f.parked, f.secondary);
  await act(async () => { props(repair).onClick({ stopPropagation() {} }); await settle(); });
  await until(() => f.migrations.length === 2);
  expect(f.migrations[1]).toMatchObject({ ok: true });
  expect(f.sm.readSessionState(f.sid)).toMatchObject({ cwd: f.primary, project: { projectId: f.project.id, mainRootId: f.project.primaryRootId }, workspace: { root: f.primary, kind: "main" } });
  expect(f.index.lookupCached(f.sid)?.mainRootId).toBe(f.project.primaryRootId);
  expect(f.sent.some((event) => event.channel === "workspace:changed")).toBe(true);
  console.log(JSON.stringify({ candidate: "missing-source-blocks-root-repair", actualProjectGroup: true, actualMainRegistration: true, actualStoreAndSessionDisk: true, targetHealthy: true, blockedByMissingSource: true, removeWhileLiveRejected: true, restorationAndButtonRetryRecovers: true, realWorkerOrCli: false }));
});

test("CONTROL healthy migration and invalid target guards preserve durable state; replaced source is rejected until exact directory is restored", async () => {
  const f = await fixture();
  const before = readFileSync(f.stateFile, "utf8");
  await expect(f.handlers.get("projectRegistry:migrateSessionMainRoot")({}, f.sid, "unknown-root")).rejects.toThrow("target root not found");
  expect(readFileSync(f.stateFile, "utf8")).toBe(before);
  renameSync(f.secondary, f.parked); symlinkSync(f.primary, f.secondary, "dir");
  await expect(f.handlers.get("projectRegistry:migrateSessionMainRoot")({}, f.sid, f.project.primaryRootId)).rejects.toThrow("root_replaced");
  expect(readFileSync(f.stateFile, "utf8")).toBe(before);
  unlinkSync(f.secondary); renameSync(f.parked, f.secondary);
  await f.handlers.get("projectRegistry:migrateSessionMainRoot")({}, f.sid, f.project.primaryRootId);
  expect(f.sm.readSessionState(f.sid)?.cwd).toBe(f.primary);
  await f.handlers.get("projectRegistry:removeRoot")({}, f.project.id, f.secondaryRoot.id);
  expect((await f.store.requireLive(f.project.id)).roots).toHaveLength(1);
  expect(f.sent.filter((event) => event.channel === "workspace:changed")).toHaveLength(1);
});

test("CONTROL service workaround archives the owner, removes the missing secondary mount, restores the owner and then migrates to the healthy primary", async () => {
  const f = await fixture(); renameSync(f.secondary, f.parked);
  await expect(f.handlers.get("projectRegistry:migrateSessionMainRoot")({}, f.sid, f.project.primaryRootId)).rejects.toThrow("dir_missing");
  f.sm.setSessionArchived(f.sid, Date.now());
  await f.handlers.get("projectRegistry:removeRoot")({}, f.project.id, f.secondaryRoot.id);
  expect((await f.store.requireLive(f.project.id)).roots).toHaveLength(1);
  f.sm.setSessionArchived(f.sid, undefined);
  const authority = await f.handlers.get("workspace:authority")({ sender: { id: 1 } }, f.sid);
  expect(authority.rootStatus).toBe("root_removed");
  await f.handlers.get("projectRegistry:migrateSessionMainRoot")({}, f.sid, f.project.primaryRootId);
  expect(f.sm.readSessionState(f.sid)?.cwd).toBe(f.primary);
  expect(f.sm.readSessionArchivedAt(f.sid)).toBeUndefined();
  expect(f.index.lookupCached(f.sid)?.mainRootId).toBe(f.project.primaryRootId);
  expect((await f.handlers.get("workspace:authority")({ sender: { id: 1 } }, f.sid)).rootStatus).toBe("ok");
  console.log(JSON.stringify({ control: "archive-remove-restore-migrate-service-workaround", actualCoreArchiveAndMainRemoveMigrate: true, completeArchiveRestoreUiExecuted: false, sourceDirectoryStillMissing: true }));
});

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import net from "node:net";
import tls from "node:tls";
import React, { act } from "react";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded HOME required");
if (process.getuid?.() === 0) throw Error("non-root required for actual EACCES fixture");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard("http://127.0.0.1:9");
const deny = () => { throw Error("NETWORK_FORBIDDEN_round17"); };
net.connect = net.createConnection = deny as any; tls.connect = deny as any;
const { default: ts } = await import(`${repo}/node_modules/typescript/lib/typescript.js`);
const { SessionManager } = await import(`${repo}/packages/core/src/session/session-manager.ts`);
const { ProjectStore } = await import(`${repo}/packages/desktop/src/main/project-store.ts`);
const { SessionCwdIndex } = await import(`${repo}/packages/desktop/src/main/session-cwd-index.ts`);
const { registerProjectAuthorityIpc } = await import(`${repo}/packages/desktop/src/main/project-authority-ipc.ts`);
const { assertDesktopSessionId } = await import(`${repo}/packages/desktop/src/main/session-validation.ts`);
const { SessionCatalogStore } = await import(`${repo}/packages/desktop/src/main/session-catalog-store.ts`);
const { SessionTranscriptCache } = await import(`${repo}/packages/desktop/src/main/session-transcript-cache.ts`);
const { archiveDiskSession, listDiskSessions, listSessions } = await import(`${repo}/packages/server/src/sessions-service.ts`);
const { createSessionTitlesStore } = await import(`${repo}/packages/server/src/session-titles-store.ts`);
const { createRoot } = await import(`${repo}/packages/desktop/node_modules/react-dom/client`);
const { ensureMiniDom, flushMicrotasks } = await import(`${repo}/packages/desktop/src/renderer/test-utils/renderHook.tsx`);
ensureMiniDom();
const { Sidebar } = await import(`${repo}/packages/desktop/src/renderer/Sidebar.tsx`);
const { SettingsPage } = await import(`${repo}/packages/desktop/src/renderer/settings/SettingsPage.tsx`);
const { SessionsView } = await import(`${repo}/packages/desktop/src/renderer/sessions/SessionsView.tsx`);
const { DialogProvider } = await import(`${repo}/packages/desktop/src/renderer/ui/DialogProvider.tsx`);
const { ToastProvider } = await import(`${repo}/packages/desktop/src/renderer/ui/ToastProvider.tsx`);
const { I18nProvider } = await import(`${repo}/packages/desktop/src/renderer/i18n/I18nProvider.tsx`);
const { useTrackedProjects } = await import(`${repo}/packages/desktop/src/renderer/app/useTrackedProjects.ts`);
const { useProjectRegistrySync } = await import(`${repo}/packages/desktop/src/renderer/app/useProjectRegistrySync.ts`);
const { useSessionNavigation } = await import(`${repo}/packages/desktop/src/renderer/app/useSessionNavigation.ts`);
const { useSessionIndices } = await import(`${repo}/packages/desktop/src/renderer/app/useSessionIndices.ts`);
const projectFns = await import(`${repo}/packages/desktop/src/renderer/projects.ts`);
const transcripts = await import(`${repo}/packages/desktop/src/renderer/transcripts.ts`);
const persistence = await import(`${repo}/packages/desktop/src/renderer/sessionPersistence.ts`);
ensureMiniDom();
const values = new Map<string, string>();
const storage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
window.requestAnimationFrame = ((callback: any) => setTimeout(() => callback(Date.now()), 0)) as any;
window.cancelAnimationFrame = (id: any) => clearTimeout(id);
globalThis.requestAnimationFrame = window.requestAnimationFrame; globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
Object.defineProperty(window, "innerWidth", { configurable: true, value: 1366 });
const elementProto = Object.getPrototypeOf(document.createElement("div"));
for (const [key, value] of [["offsetWidth", 200], ["offsetHeight", 100]] as const) if (typeof document.createElement("div")[key] !== "number") Object.defineProperty(elementProto, key, { configurable: true, get: () => value });
Object.defineProperty(Object.getPrototypeOf(document.createElement("input")), "select", { configurable: true, value() {} });
const nodes = (node: any): any[] => [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
const props = (node: any): any => { const key = Object.keys(node).find(key => key.startsWith("__reactProps$")); return key ? node[key] : {}; };
const text = (node: any): string => node.nodeType === 3 ? node.nodeValue ?? node.textContent ?? "" : Array.from(node.childNodes ?? []).map(text).join("") || node.textContent || (typeof props(node).children === "string" ? props(node).children : "");
const settle = async () => { await flushMicrotasks(); await new Promise(resolve => setTimeout(resolve, 5)); await flushMicrotasks(); };
async function until(predicate: () => boolean, label = "condition") { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() > deadline) throw Error(`timeout: ${label}; ${text(document.body)}`); await act(settle); } }
let assertions = 0;
const equal = (actual: any, expected: any) => { assertions++; assert.deepEqual(actual, expected); };
const check = (value: any, label = "assertion") => { assertions++; assert.ok(value, label); };
const owned = join(process.env.HOME!, "round17-owned"); mkdirSync(owned);
const mainSource = ts.createSourceFile("index.ts", readFileSync(`${repo}/packages/desktop/src/main/index.ts`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function mainCallback(channel: string, context: any) {
  let callback: any;
  function visit(node: any) { if (ts.isCallExpression(node) && node.arguments[0]?.getText(mainSource) === JSON.stringify(channel)) callback = node.arguments.find((arg: any) => ts.isArrowFunction(arg)); ts.forEachChild(node, visit); }
  visit(mainSource); check(callback, `production ${channel} exists`);
  const js = ts.transpileModule(`const handler = ${callback.getText(mainSource)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(`${js}\nhandler`, context);
}
const appSource = ts.createSourceFile("App.tsx", readFileSync(`${repo}/packages/desktop/src/renderer/App.tsx`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const restoreCallbacks: any[] = [];
function readRestore(node: any) { if (ts.isJsxAttribute(node) && node.name.getText(appSource) === "onRestoreArchivedSession") restoreCallbacks.push(node.initializer.expression); ts.forEachChild(node, readRestore); }
readRestore(appSource); equal(restoreCallbacks.length, 2); equal(restoreCallbacks[0].getText(appSource), restoreCallbacks[1].getText(appSource));
function appRestore(setSessionIndices: any) {
  const js = ts.transpileModule(`const handler = ${restoreCallbacks[0].getText(appSource)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(`${js}\nhandler`, { archiveSession: transcripts.archiveSession, projectBucketSegmentFor: transcripts.projectBucketSegment, setSessionIndices });
}
const sessionsRoot = join(owned, "sessions"), manager = new SessionManager(sessionsRoot), cwdIndex = new SessionCwdIndex({ sessionsRoot });
const registryDir = join(owned, "registry"); mkdirSync(registryDir);
const store = new ProjectStore({ file: join(registryDir, "projects.json"), recentsFile: join(owned, "recents.json"), migrationMarkerFile: join(owned, "migration.json"), sessionIndex: cwdIndex, sessionManager: manager, noRepoPath: join(owned, "no-repo"), resolveProjectRoot: (value: string) => value });
const primary = join(owned, "primary"), secondary = join(owned, "secondary"); mkdirSync(primary); mkdirSync(secondary);
let project = await store.createFromPath(primary); project = (await store.addRoot(project.id, secondary)).project;
const secondaryRoot = project.roots.find((root: any) => root.path === secondary)!;
const handlers = new Map<string, any>(), registryListeners = new Set<any>(), broadcasts: any[] = [];
registerProjectAuthorityIpc({ ipcMain: { handle: (channel: string, callback: any) => handlers.set(channel, callback) }, getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel: string, payload: any) => { broadcasts.push(channel); if (channel === "projectRegistry:changed") for (const listener of registryListeners) listener(payload); } } }], showOpenDialog: async () => ({ canceled: true, filePaths: [] }), applyGitPathFromSettings: async () => {}, projectStore: store, getBridge: () => undefined, getTrust: async () => "trusted", assertSessionId: assertDesktopSessionId, trackGitRoot() {}, broadcastMobileProjects: async () => {}, getGitStatus: async () => ({ branch: null, clean: true, entries: [] }), getGitBranches: async () => ({ isRepo: false, current: null, branches: [] }), revealInFinder: async () => {}, openPath: async () => "" } as any);
const catalog = new SessionCatalogStore({ file: join(owned, "desktop", "catalog.json") }), cache = new SessionTranscriptCache({ directory: join(owned, "cache"), legacyDirectory: join(owned, "legacy") });
const titleFile = join(owned, "titles", "titles.json"), titleStore = createSessionTitlesStore(titleFile);
const renameAttempts: any[] = [], archiveAttempts: any[] = [], titleAttempts: any[] = [], unhandled: any[] = [];
process.on("unhandledRejection", error => unhandled.push(error));
const archive = mainCallback("sessions:setArchived", { assertDesktopSessionId, archiveDiskSession: (id: string, archivedAt: any) => archiveDiskSession(id, archivedAt, sessionsRoot), getSessionCwdIndex: () => cwdIndex, Date });
const renameTitle = mainCallback("sessions:rename", { assertDesktopSessionId, setTitle: titleStore.setTitle });
const api = {
  log() {}, getProjectGitStatus: async () => ({ branch: null, clean: true, entries: [] }), getSessionWorkspaceAuthority: async () => ({ rootStatus: "ok", mainRoot: secondary, workspaceRoot: secondary, workspace: { root: secondary, kind: "main" } }), getSessionWorkspace: async () => ({ root: secondary, kind: "main" }), getSessionGitStatus: async () => ({ branch: null, clean: true, entries: [] }),
  getUpdaterStatus: async () => ({ kind: "idle" }), onUpdaterStatus: () => () => {}, getPetWidgetVisible: async () => false, onPetWidgetVisibility: () => () => {},
  readProjectDir: async () => [],
  projectRegistry: { list: () => handlers.get("projectRegistry:list")({}), beginLegacyMigration: async () => ({ completed: true }), onChanged: (listener: any) => { registryListeners.add(listener); return () => registryListeners.delete(listener); }, rename: async (id: string, name: string) => { renameAttempts.push({ id, name }); return handlers.get("projectRegistry:rename")({}, id, name); }, sessionMainRoots: (id: string) => store.sessionMainRoots(id), removeRoot: (id: string, rootId: string) => handlers.get("projectRegistry:removeRoot")({}, id, rootId) },
  releaseSessionWorkspace: async () => ({ ok: true, status: "released" }), releaseManySessionWorkspaces: async () => [],
  setSessionArchived: (id: string, value: boolean) => { archiveAttempts.push({ id, value }); return archive({}, id, value); },
  listSessions: () => listSessions(sessionsRoot), listSessionTitles: () => titleStore.listTitles(), renameSession: (id: string, title: string) => { titleAttempts.push({ id, title }); return renameTitle({}, id, title); },
  sessionCatalog: { load: () => catalog.load(), importLegacy: (input: any) => catalog.importLegacy(input), apply: (input: any) => catalog.apply(input), onChanged: (fn: any) => catalog.onChanged(fn), writeTranscript: (input: any) => cache.write(input), readTranscript: (input: any) => cache.read(input), deleteTranscript: (input: any) => cache.delete(input) },
};
Object.defineProperty(window, "codeshell", { configurable: true, value: api });
await persistence.initializeSessionPersistence();
let root: any, container: any, state: any;
const mount = async (element: any) => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); await act(async () => { root.render(element); await settle(); }); };
const unmount = async () => { if (root) await act(async () => { root.unmount(); await settle(); }); root = undefined; container?.parentNode?.removeChild(container); container = undefined; };
const click = async (node: any) => { check(node, "production button exists"); check(!props(node).disabled, "production button enabled"); await act(async () => { props(node).onClick({ currentTarget: node, stopPropagation() {}, preventDefault() {} }); await settle(); }); };
function Host({ settings = false }: { settings?: boolean }) {
  const [projects, setProjects] = useTrackedProjects(); const { sessionIndices, setSessionIndices } = useSessionIndices(); const [activeProjectId, setActiveProjectId] = React.useState<string | null>(null);
  useProjectRegistrySync({ setProjects, setSessionIndices, setActiveProjectId, setPermissionOverrides() {}, setModelOverrides() {}, setGoalOverrides() {} });
  const navigation = useSessionNavigation({ projects, setProjects, activeProjectId, setActiveProjectId, sessionIndices, setSessionIndices, setCollapsedProjects() {}, setUnreadBuckets() {}, setPermissionOverrides() {}, setModelOverrides() {}, setGoalOverrides() {}, panelByBucket: {}, setPanelByBucket() {}, activeBucketRef: { current: "" }, setView() {}, setRunsInitialRunId() {} });
  state = { projects, sessionIndices, navigation };
  if (settings) return <SettingsPage initialModule="archived" activeProjectPath={primary} projects={projects} sessionIndices={sessionIndices} onRestoreArchivedSession={appRestore(setSessionIndices)} onDeleteArchivedSession={() => {}} isMac={false} isFullscreen={false} onBack={() => {}} />;
  return <Sidebar projects={projects} sessions={sessionIndices} activeProjectId={activeProjectId} activeSessionId={null} collapsedProjects={new Set()} petPendingCount={0} petRunningCount={0} petWidgetVisible={false} sessionHistoryLoading={false} hasMoreSessionHistory={false} onSelectProject={() => {}} onSelectSession={navigation.handleSelectSession} onToggleProject={() => {}} onAddProject={() => {}} onRemoveProject={() => {}} onPinProject={() => {}} onRenameProject={navigation.handleRenameProject} onArchiveAllSessions={navigation.handleArchiveAllSessions} onNewConversationForProject={() => {}} onNewConversation={() => {}} onOpenSearch={() => {}} onNavigate={() => {}} onOpenProjectConfig={() => {}} onOpenSettingsPage={() => {}} onOpenPetPage={() => {}} onTogglePetWidget={() => {}} onLoadMoreSessionHistory={() => {}} onRenameSession={navigation.handleRenameSession} onPinSession={navigation.handlePinSession} onArchiveSession={navigation.handleArchiveSession} onDeleteSession={() => {}} activeProjectPath={primary} viewMode="chat" />;
}
const providers = (element: any) => <I18nProvider><DialogProvider><ToastProvider>{element}</ToastProvider></DialogProvider></I18nProvider>;
async function openContext(row: any, label: string) { check(row, "actual context menu row"); await act(async () => { props(row).onContextMenu({ preventDefault() {}, clientX: 0, clientY: 0 }); await settle(); }); await click(nodes(document.body).find(node => props(node).role === "menuitem" && text(node).startsWith(label))); }
async function projectRenamePrompt(value: string, cancel = false) {
  const row = nodes(container).find(node => props(node).onContextMenu && text(node).includes(state.projects[0].displayName ?? state.projects[0].name));
  await openContext(row, "重命名项目");
  const input = nodes(document.body).find(node => node.tagName === "INPUT" && props(node).onChange);
  check(input, "actual prompt input"); await act(async () => { props(input).onChange({ target: { value } }); await settle(); });
  await click(nodes(document.body).find(node => node.tagName === "BUTTON" && text(node) === (cancel ? "取消" : "确定")));
}
try {
  // The fixture retains production validation rather than relaxing IDs for the UI seam.
  await assert.rejects(() => archive({}, "../invalid", true)); assertions++;
  await assert.rejects(() => archive({}, "valid-id", "false")); assertions++;
  await assert.rejects(() => renameTitle({}, "valid-id", "x".repeat(1025))); assertions++;
  const registryBeforeInvalid = readFileSync(join(registryDir, "projects.json"), "utf8");
  await assert.rejects(() => handlers.get("projectRegistry:rename")({}, "unknown-project", "New name")); assertions++;
  equal(readFileSync(join(registryDir, "projects.json"), "utf8"), registryBeforeInvalid);
  await mount(providers(<Host />)); await until(() => state.projects.length === 1, "registry hydration");
  await projectRenamePrompt("cancelled project draft", true); equal(renameAttempts.length, 0); equal((await store.list())[0].name, project.name);
  chmodSync(registryDir, 0o500);
  await projectRenamePrompt("unique failed project rename"); await until(() => unhandled.length === 1, "real project mutation rejection");
  equal(renameAttempts.map(value => value.id), [project.id]); check(/EACCES|EPERM/.test(String(unhandled[0])), "actual registry refusal");
  equal(state.projects[0].displayName, "unique failed project rename"); check(text(container).includes("unique failed project rename"));
  equal(JSON.parse(readFileSync(join(registryDir, "projects.json"), "utf8")).projects[0].name, project.name);
  equal(broadcasts.filter(value => value === "projectRegistry:changed").length, 0);
  check(!text(document.body).includes("EACCES") && !text(document.body).includes("重命名失败"));
  equal(nodes(document.body).filter(node => props(node).role === "alert").length, 0);
  chmodSync(registryDir, 0o700);
  // Ordinary successful registry operation reconciles the projection to the old durable name.
  await act(async () => { await handlers.get("projectRegistry:setPinned")({}, project.id, true); await settle(); });
  equal(state.projects[0].name, project.name); check(!text(container).includes("unique failed project rename"));
  await projectRenamePrompt("successful project retry"); await until(() => state.projects[0].name === "successful project retry");
  equal((await store.list())[0].name, "successful project retry"); equal(unhandled.length, 1);
  await unmount();
  console.log(JSON.stringify({ candidate: "project-rename-refusal", actualSidebarPrompt: true, actualNavigation: true, actualMainRegistrationAndStore: true, storageRefusal: String(unhandled[0]), optimisticNameUntilRegistryRefresh: true, retryRecovers: true, nativeElectron: false }));

  // Archive through the actual sidebar path, restore through actual SettingsPage and the unchanged App callback AST.
  const sid = "round17-secondary-session", uiId = "round17-ui-session";
  const bundle = manager.create(secondary, "fixture-model", "fixture-provider", sid, null, "desktop");
  bundle.transcript.appendMessage("user", "durable round17 conversation"); manager.updateSessionState(sid, { title: "Restore secondary task", status: "completed", project: { projectId: project.id, mainRootId: secondaryRoot.id } });
  cwdIndex.upsert(sid, { cwd: secondary, workspaceRoot: secondary, projectId: project.id, mainRootId: secondaryRoot.id });
  transcripts.saveSessionIndex(project.id, { sessions: [{ id: uiId, engineSessionId: sid, title: "Restore secondary task", createdAt: 1, updatedAt: 2 }], activeSessionId: null }); await persistence.flushSessionPersistence();
  await mount(providers(<Host />)); await until(() => text(container).includes("Restore secondary task"));
  const sessionRow = nodes(container).find(node => props(node).onContextMenu && node.tagName === "LI" && text(node).includes("Restore secondary task"));
  await openContext(sessionRow, "归档"); await until(() => state.sessionIndices[project.id]?.sessions[0]?.archived === true); await persistence.flushSessionPersistence();
  equal(archiveAttempts, [{ id: sid, value: true }]); check(typeof new SessionManager(sessionsRoot).readSessionArchivedAt(sid) === "number");
  equal((await catalog.load()).indices[project.id].sessions[0].archived, true);
  equal((await listDiskSessions({ limit: 100 }, sessionsRoot)).sessions.map((row: any) => row.id), []);
  await unmount(); await mount(providers(<Host settings />)); await until(() => text(container).includes("Restore secondary task"));
  await click(nodes(container).find(node => node.tagName === "BUTTON" && props(node).title === "取消归档"));
  await until(() => state.sessionIndices[project.id]?.sessions[0]?.archived === false); await persistence.flushSessionPersistence();
  equal(archiveAttempts, [{ id: sid, value: true }]); equal((await catalog.load()).indices[project.id].sessions[0].archived, false);
  check(!text(container).includes("Restore secondary task"), "restored row leaves settings archive list");
  check(typeof new SessionManager(sessionsRoot).readSessionArchivedAt(sid) === "number", "durable archive marker remains");
  equal((await listDiskSessions({ limit: 100 }, sessionsRoot)).sessions.map((row: any) => row.id), []);
  equal((await store.sessionMainRoots(project.id))[secondaryRoot.id], undefined);
  await unmount(); await mount(providers(<Host />)); await until(() => text(container).includes("Restore secondary task"));
  check(text(container).includes("Restore secondary task"), "normal sidebar presents restored live row");
  // Correct primitive/control: actual navigation handler calls Main and clears the marker.
  // This is a service/handler control, not a clicked Desktop restore entry.
  await act(async () => { await state.navigation.handleArchiveSession(project.id, uiId, false); await settle(); });
  equal(new SessionManager(sessionsRoot).readSessionArchivedAt(sid), undefined);
  check((await listDiskSessions({ limit: 100 }, sessionsRoot)).sessions.some((row: any) => row.id === sid));
  equal((await store.sessionMainRoots(project.id))[secondaryRoot.id], [sid]);
  await assert.rejects(() => handlers.get("projectRegistry:removeRoot")({}, project.id, secondaryRoot.id), /main root for sessions/); assertions++;
  // Repeat the production archive -> Settings restore route; it deterministically diverges again.
  await openContext(nodes(container).find(node => props(node).onContextMenu && node.tagName === "LI" && text(node).includes("Restore secondary task")), "归档");
  await until(() => state.sessionIndices[project.id]?.sessions[0]?.archived === true);
  await unmount(); await mount(providers(<Host settings />)); await until(() => text(container).includes("Restore secondary task"));
  await click(nodes(container).find(node => node.tagName === "BUTTON" && props(node).title === "取消归档"));
  await until(() => state.sessionIndices[project.id]?.sessions[0]?.archived === false); await persistence.flushSessionPersistence();
  equal(archiveAttempts, [{ id: sid, value: true }, { id: sid, value: false }, { id: sid, value: true }]);
  await unmount(); await mount(providers(<Host />)); await until(() => text(container).includes("Restore secondary task"));
  const projectRow = nodes(container).find(node => props(node).onContextMenu && text(node).includes("successful project retry") && node.tagName !== "LI");
  await openContext(projectRow, "编辑项目文件夹");
  await until(() => text(document.body).includes("项目文件夹"));
  check(!text(document.body).includes("1 个 Session 的主目录"), "restored binding not shown in actual folders dialog");
  await click(nodes(document.body).find(node => node.tagName === "BUTTON" && text(node) === "移除"));
  await click(nodes(document.body).filter(node => node.tagName === "BUTTON" && text(node) === "移除").at(-1));
  await until(() => state.projects[0].roots.length === 1);
  equal((await store.requireLive(project.id)).roots.map((root: any) => root.id), [project.primaryRootId]);
  equal(new SessionManager(sessionsRoot).readSessionState(sid)?.project?.mainRootId, secondaryRoot.id);
  assert.throws(() => store.resolveRunProjectSync(project.id, sid, cwdIndex.lookupCached(sid)), /root_removed/); assertions++;
  equal(new SessionManager(sessionsRoot).resume(sid).transcript.toMessages().map((message: any) => message.content), ["durable round17 conversation"]);
  await unmount();
  console.log(JSON.stringify({ candidate: "settings-restores-catalog-only", actualSidebarArchive: true, actualSettingsPageRestore: true, actualAppRestoreCallbacksIdentical: true, actualCoreDisk: true, catalogRestored: true, durableArchiveRetained: true, actualFoldersDialogAndMainRootRemovalPermitted: true, subsequentActualProjectResolutionRejectsRootRemoved: true, coreHistoryPreserved: true, actualNavigationRestoreClearsMarkerAndRestoresRootGuard: true, completeRestoreRecoveryUiExecuted: false, noRealWorkerOrModel: true }));

  // History rename uses a real title registry refusal and retries the same draft.
  let notified: any[] = []; await mount(providers(<SessionsView onSessionRenamed={(id: string, title: string) => notified.push({ id, title })} />)); await until(() => text(container).includes("Restore secondary task"));
  await click(nodes(container).find(node => node.tagName === "BUTTON" && text(node) === "重命名"));
  const editor = () => nodes(container).find(node => node.tagName === "INPUT" && props(node).onKeyDown && props(node).type !== "search");
  await act(async () => { props(editor()).onChange({ target: { value: "history retry retained draft" } }); await settle(); });
  mkdirSync(join(owned, "titles"), { recursive: true }); chmodSync(join(owned, "titles"), 0o500);
  await click(nodes(container).find(node => node.tagName === "BUTTON" && text(node) === "保存")); await until(() => text(container).includes("草稿已保留"));
  equal(props(editor()).value, "history retry retained draft"); equal(notified, []); check(/EACCES|EPERM/.test(text(container)));
  chmodSync(join(owned, "titles"), 0o700); await click(nodes(container).find(node => node.tagName === "BUTTON" && text(node) === "保存")); await until(() => notified.length === 1);
  equal(notified, [{ id: sid, title: "history retry retained draft" }]); equal((await titleStore.listTitles())[sid], "history retry retained draft"); equal(titleAttempts.map(value => value.id), [sid, sid]);
  await unmount(); console.log(JSON.stringify({ control: "history-rename", actualSessionsViewAndMainCallback: true, actualTitleRegistryEACCES: true, draftAndRowRetained: true, sameDraftRetryRecovers: true }));
  console.log(`PASS session operations; ${assertions} assertions`);
} finally {
  chmodSync(registryDir, 0o700); if (existsSync(join(owned, "titles"))) chmodSync(join(owned, "titles"), 0o700);
  await unmount(); persistence.getSessionPersistence()?.dispose(); projectFns.__resetProjectSnapshotForTest(); rmSync(owned, { recursive: true, force: true });
}

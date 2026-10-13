import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

const repo = process.cwd();
if (!process.env.CODE_SHELL_TEST_HOME) throw new Error("guarded HOME required");
const evidence = fileURLToPath(new URL("./", import.meta.url));
const isolation = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
isolation.installLocalNetworkGuard("http://127.0.0.1:9");
const { default: ts } = await import(repo + "/node_modules/typescript/lib/typescript.js");
const React = await import(repo + "/node_modules/react/index.js");
const { act } = React;
const { renderHook, ensureMiniDom } = await import(repo + "/packages/web/src/test-utils/renderHook.tsx");
const { SessionCatalogStore } = await import(repo + "/packages/desktop/src/main/session-catalog-store.ts");
const { SessionTranscriptCache } = await import(repo + "/packages/desktop/src/main/session-transcript-cache.ts");
const { registerSessionCatalogIpc } = await import(repo + "/packages/desktop/src/main/session-catalog-ipc.ts");
const { createSessionCatalogApi } = await import(repo + "/packages/desktop/src/preload/session-catalog-api.ts");
const { SessionPersistence } = await import(repo + "/packages/desktop/src/renderer/sessionPersistence.ts");

const cleanups: Array<() => void | Promise<void>> = [];
const observations: any[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function parse(file: string) {
  const source = readFileSync(join(repo, file), "utf8");
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function find(root: any, predicate: (node: any) => boolean): any {
  if (predicate(root)) return root;
  let result: any;
  ts.forEachChild(root, (node: any) => { if (!result) result = find(node, predicate); });
  return result;
}
function evaluate(source: string, context: Record<string, unknown>) {
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  runInNewContext(javascript, { ...context, exports, Object, Set, Map });
  return exports as any;
}
function exportedFunction(file: string, name: string, context: Record<string, unknown>) {
  const source = parse(file);
  const fn = find(source, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  expect(fn).toBeDefined();
  return evaluate(fn.getText(source).replace(/^export\s+/, "") + `\nexports.result = ${name};`, context).result;
}

// Use the actual App selector, not a separately reimplemented active-bucket rule.
const app = parse("packages/desktop/src/renderer/App.tsx");
const selector = find(app, (node) => ts.isVariableDeclaration(node) && node.name.getText(app) === "activeSessionId" && node.initializer?.getText(app).includes("sessionIndices[activeProjectBucketSegment]"));
expect(selector).toBeDefined();
const selectActive = new Function("sessionIndices", "activeProjectBucketSegment", `return (${selector.initializer.getText(app)});`);
const row = (id: string) => ({ id, engineSessionId: id, title: id, createdAt: 1, updatedAt: 2 });

async function setup() {
  ensureMiniDom();
  const root = mkdtempSync(join(tmpdir(), "codeshell-review-multiwindow-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SessionCatalogStore({ file: join(root, "catalog.json") });
  const cache = new SessionTranscriptCache({ directory: join(root, "cache"), legacyDirectory: join(root, "legacy") });
  const handlers = new Map<string, any>();
  const windows = [11, 12].map((id) => {
    const listeners = new Map<string, Set<any>>();
    const frame = {};
    const sender = { id, mainFrame: frame, isDestroyed: () => false, send(channel: string, value: any) {
      for (const listener of listeners.get(channel) ?? []) listener({}, structuredClone(value));
    }};
    const window = { webContents: sender, isDestroyed: () => false };
    const ipc = {
      invoke: async (channel: string, input?: unknown) => handlers.get(channel)({ sender, senderFrame: frame }, structuredClone(input)),
      on(channel: string, listener: any) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(listener); },
      removeListener(channel: string, listener: any) { listeners.get(channel)?.delete(listener); },
    };
    return { window, api: createSessionCatalogApi(ipc as any) };
  });
  const registration = registerSessionCatalogIpc({ handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) } as any, () => windows.map((item) => item.window) as any, store, cache);
  cleanups.push(() => registration.dispose());
  for (const project of ["project", "other"]) await store.apply({ projectKey: project, upserts: ["S1", "S2"].map((id) => ({ id: project + "-" + id, values: row(project + "-" + id) })), activeSessionId: project + "-S1" });
  const persistences = windows.map(({ api }) => new SessionPersistence(api));
  await Promise.all(persistences.map((p) => p.initialize()));
  for (const p of persistences) cleanups.push(() => p.dispose());

  async function view(persistence: InstanceType<typeof SessionPersistence>, activeProject = "project") {
    const useIndices = exportedFunction("packages/desktop/src/renderer/app/useSessionIndices.ts", "useSessionIndices", {
      ...React,
      loadProjects: () => [{ id: "project" }, { id: "other" }],
      loadSessionIndex: (projectId: string | null) => persistence.getIndex(projectId ?? "__no_repo__"),
      loadDeletedArchivedIndices: () => ({}),
      getSessionPersistenceIndices: () => persistence.getIndices(),
      subscribeSessionPersistence: (listener: () => void) => persistence.subscribe(listener),
      NO_REPO_KEY: "__no_repo__",
    });
    const hook = await renderHook(() => {
      const indices = useIndices();
      return { ...indices, activeSessionId: selectActive(indices.sessionIndices, activeProject) };
    });
    cleanups.push(() => hook.unmount());
    return hook;
  }
  function select(persistence: InstanceType<typeof SessionPersistence>, hook: any, projectId: string, sessionId: string) {
    const normalization = exportedFunction("packages/desktop/src/renderer/transcripts.ts", "normalizeSessionIndex", { logSessionDiagnostic() {} });
    const setActiveSession = exportedFunction("packages/desktop/src/renderer/transcripts.ts", "setActiveSession", {
      normalizeSessionIndex: normalization,
      loadSessionIndex: (id: string | null) => persistence.getIndex(id ?? "__no_repo__"),
      saveSessionIndex: (id: string | null, index: any) => persistence.saveIndex(id ?? "__no_repo__", index),
    });
    const source = parse("packages/desktop/src/renderer/app/useSessionNavigation.ts");
    const arrow = find(source, (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "selectSession");
    const selectSession = evaluate(`exports.result = ${arrow.initializer.getText(source)};`, {
      setActiveSession,
      bucketKey: (project: string | null, id: string | null) => `${project ?? "__no_repo__"}::${id ?? "_none_"}`,
      projectBucketSegment: (project: string | null) => project ?? "__no_repo__",
      setUnreadBuckets() {}, setActiveProjectId() {}, setCollapsedProjects() {}, revealSidebarProject() {}, setView() {},
      activeBucketRef: { current: "unused" },
      setSessionIndices: hook.result.current.setSessionIndices,
      window: { codeshell: { log() {} } },
    }).result;
    selectSession(projectId, sessionId);
  }
  return { store, persistences, view, select, root };
}

test("CANDIDATE: another live window's normal same-project selection replaces the first window's active App session", async () => {
  const f = await setup();
  const a = await f.view(f.persistences[0]);
  const b = await f.view(f.persistences[1]);
  expect(a.result.current.activeSessionId).toBe("project-S1");
  expect(b.result.current.activeSessionId).toBe("project-S1");
  await act(async () => { f.select(f.persistences[1], b, "project", "project-S2"); await f.persistences[1].flush(); });
  expect(b.result.current.activeSessionId).toBe("project-S2");
  expect(a.result.current.activeSessionId).toBe("project-S2");
  await act(async () => { f.select(f.persistences[0], a, "project", "project-S1"); await f.persistences[0].flush(); });
  expect(a.result.current.activeSessionId).toBe("project-S1");
  expect(b.result.current.activeSessionId).toBe("project-S1");
  expect((await f.store.load()).indices.project.sessions).toHaveLength(2);
  observations.push({ case: "same-project", peerSelectionReplacesActive: true, reciprocal: true, transcriptOrRowsDeleted: false, fullElectronExecuted: false });
});

test("CONTROL: a window showing another project keeps its own selected session", async () => {
  const f = await setup();
  const a = await f.view(f.persistences[0]);
  const b = await f.view(f.persistences[1], "other");
  await act(async () => { f.select(f.persistences[0], a, "project", "project-S2"); await f.persistences[0].flush(); });
  expect(a.result.current.activeSessionId).toBe("project-S2");
  expect(b.result.current.activeSessionId).toBe("other-S1");
  observations.push({ case: "different-project", peerSelectionDoesNotChangeVisibleSession: true });
});

test("CONTROL: independent fields merge durably; deleted rows stay deleted despite an old window save", async () => {
  const f = await setup();
  const [a, b] = f.persistences;
  a.saveIndex("project", { ...a.getIndex("project"), sessions: a.getIndex("project").sessions.map((item: any) => item.id === "project-S1" ? { ...item, title: "Renamed", titleManual: true } : item) });
  b.saveIndex("project", { ...b.getIndex("project"), sessions: b.getIndex("project").sessions.map((item: any) => item.id === "project-S1" ? { ...item, pinned: true } : item) });
  await Promise.all([a.flush(), b.flush()]);
  expect((await f.store.load()).indices.project.sessions.find((item) => item.id === "project-S1")).toMatchObject({ title: "Renamed", titleManual: true, pinned: true });
  const stale = structuredClone(b.getIndex("project"));
  a.saveIndex("project", { ...a.getIndex("project"), sessions: a.getIndex("project").sessions.filter((item: any) => item.id !== "project-S1"), activeSessionId: null });
  await a.flush();
  b.saveIndex("project", stale);
  await b.flush();
  const disk = await new SessionCatalogStore({ file: join(f.root, "catalog.json") }).load();
  expect(disk.indices.project.sessions.map((item) => item.id)).toEqual(["project-S2"]);
  expect(a.getIndex("project").sessions.map((item: any) => item.id)).toEqual(["project-S2"]);
  expect(b.getIndex("project").sessions.map((item: any) => item.id)).toEqual(["project-S2"]);
  observations.push({ case: "merge-and-delete", independentFieldsPreserved: true, staleResurrectionBlocked: true, reopenedStoreMatches: true });
  writeFileSync(join(evidence, "catalog-observations.json"), JSON.stringify({ baseline: "see archived run metadata", mode: "actual-Main-store-IPC-preload-and-renderer-persistence; exact-AST-hook-navigation-App-selector", observations }, null, 2) + "\n");
});

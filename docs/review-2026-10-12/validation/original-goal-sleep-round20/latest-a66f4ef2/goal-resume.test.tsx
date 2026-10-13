import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded HOME required");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
installLocalNetworkGuard("http://127.0.0.1:9");
let networkCalls = 0;
const deny = () => { networkCalls++; throw Error("goal-round20 network forbidden"); };
net.connect = net.createConnection = deny as any;
tls.connect = deny as any;
let subprocessCalls = 0;
const denySubprocess = () => { subprocessCalls++; throw Error("goal-round20 subprocess forbidden"); };
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) (childProcess as any)[name] = denySubprocess;

const React = (await import(repo + "/packages/desktop/node_modules/react")).default;
const { act } = React;
const { createRoot } = await import(repo + "/packages/desktop/node_modules/react-dom/client");
const { ensureMiniDom, flushMicrotasks } = await import(repo + "/packages/desktop/src/renderer/test-utils/renderHook.tsx");
const { StatusPopover } = await import(repo + "/packages/desktop/src/renderer/topbar/StatusPopover.tsx");
const { transcriptsReducer } = await import(repo + "/packages/desktop/src/renderer/transcriptsReducer.ts");
const { INITIAL_STATE } = await import(repo + "/packages/desktop/src/renderer/types.ts");
const { SessionManager } = await import(repo + "/packages/core/src/session/session-manager.ts");
const { Engine } = await import(repo + "/packages/core/src/engine/engine.ts");
const { ChatSessionManager } = await import(repo + "/packages/core/src/protocol/chat-session-manager.ts");
const { AgentServer } = await import(repo + "/packages/core/src/protocol/server.ts");
const { LLMClientBase } = await import(repo + "/packages/core/src/llm/client-base.ts");
const { registerProvider } = await import(repo + "/packages/core/src/llm/client-factory.ts");
const { createWorkspaceContext } = await import(repo + "/packages/core/src/workspace/workspace-context.ts");
const { ProjectStore } = await import(repo + "/packages/desktop/src/main/project-store.ts");
const { SessionCwdIndex } = await import(repo + "/packages/desktop/src/main/session-cwd-index.ts");
const { resolveSessionRunWorkspace } = await import(repo + "/packages/desktop/src/main/session-run-workspace.ts");
const fallback = await import(repo + "/packages/desktop/src/main/agent-bridge-fallback.ts");
const metadata = await import(repo + "/packages/desktop/src/main/agent-run-metadata.ts");
const optimization = await import(repo + "/packages/desktop/src/shared/optimization-lab.ts");

ensureMiniDom();
let api: any;
let deliver: (line: string) => void = () => { throw Error("no owned IPC target"); };
const ipcListeners = new Map<string, Set<any>>();
const ipcSent: any[] = [];
mock.module("electron", () => ({
  contextBridge: { exposeInMainWorld: (_key: string, value: any) => { api = value; } },
  webUtils: { getPathForFile: () => "" },
  ipcRenderer: {
    on(channel: string, fn: any) { if (!ipcListeners.has(channel)) ipcListeners.set(channel, new Set()); ipcListeners.get(channel)!.add(fn); return this; },
    removeListener(channel: string, fn: any) { ipcListeners.get(channel)?.delete(fn); return this; },
    send(channel: string, line: string) { if (channel !== "agent:msg") throw Error("unexpected IPC send"); ipcSent.push(JSON.parse(line)); deliver(line); },
    invoke: async () => { throw Error("unexpected IPC invoke"); },
  },
}));
await import(repo + "/packages/desktop/src/preload/index.ts");
const emitReply = (value: any) => { for (const fn of ipcListeners.get("agent:msg") ?? []) fn({}, typeof value === "string" ? value : JSON.stringify(value)); };
const nodes = (n: any): any[] => [n, ...Array.from(n?.childNodes ?? []).flatMap(nodes)];
const props = (n: any): any => { const k = Object.keys(n ?? {}).find(x => x.startsWith("__reactProps$")); return k ? n[k] : {}; };
const textOf = (n: any): string => n?.nodeType === 3 ? n.nodeValue ?? "" : Array.from(n?.childNodes ?? []).map(textOf).join("") || n?.textContent || "";
const tick = async () => { await flushMicrotasks(); await new Promise(r => setTimeout(r, 0)); await flushMicrotasks(); };
async function until(check: () => boolean, label = "owned goal wait") { const end = Date.now() + 4000; while (!check()) { if (Date.now() > end) throw Error(label); await act(tick); } }
const resources: any[] = [];
const receipts: any[] = [];
let completed = 0;
const transpiler = new Bun.Transpiler({ loader: "ts" });

// Read the complete maintained Main IPC callback verbatim. This avoids importing
// Electron's full browser driver or spawning WorkerBridgeCore. Its target core
// boundary is an owned recorder whose canSend() is explicitly false.
const bridgeSource = readFileSync(repo + "/packages/desktop/src/main/agent-bridge.ts", "utf8");
const callbackStart = bridgeSource.indexOf('    ipcMain.on("agent:msg", (event, line: string) => {');
const callbackEnd = bridgeSource.indexOf('\n    ipcMain.on(\n      "desktop:log",', callbackStart);
if (callbackStart < 0 || callbackEnd < callbackStart) throw Error("Main callback source markers changed");
const callbackCode = transpiler.transformSync("function maintainedMainCallbackBinding() {\n" + bridgeSource.slice(callbackStart, callbackEnd) + "\n}\nreturn maintainedMainCallbackBinding;");
writeFileSync(join(import.meta.dir, "extracted-main.js"), callbackCode);
const bindMainCallbackFactory = new Function("ipcMain", "prepareAgentRunMetadata", "AgentRunMetadataError", "isOptimizationLabQuery", "quickChatRunSessionId", "quickChatRunRequest", "quickChatForkRequest", "forkSourceSessionId", "compactQuerySessionId", "buildNoChildFallbackReply", "BrowserWindow", "dlog", "ErrorCodes", callbackCode);

// The actual App Goal mutation and reconciliation closures are also extracted
// unchanged. Production reducers and StatusPopover render their projections;
// a small owned state bridge substitutes only the complete App mount.
const appSource = readFileSync(repo + "/packages/desktop/src/renderer/App.tsx", "utf8");
const mutationStart = appSource.indexOf("  const reconcileGoalMutation = async (");
const mutationEnd = appSource.indexOf("  const handleContextPackageCreated = async (", mutationStart);
if (mutationStart < 0 || mutationEnd < mutationStart) throw Error("App closure source markers changed");
const mutationCode = transpiler.transformSync(appSource.slice(mutationStart, mutationEnd) + "\nreturn { handleGoalPausedChange, handleDeleteGoal, handleUpdateGoal };\n");
writeFileSync(join(import.meta.dir, "extracted-app.js"), mutationCode);
const appMutations = new Function("state", "activeBucket", "goalMutationSeqRef", "dispatch", "engineSessionIdForActive", "goalOverrides", "setGoalOverrides", mutationCode);

const provider = "owned-goal-resume-round20";
let modelCalls = 0;
let auxiliaryCalls = 0;
class OwnedClient extends LLMClientBase {
  protected initClient() {}
  async createMessage(options: any) {
    if (!options.tools?.some((t: any) => t.name === "complete_goal")) { auxiliaryCalls++; return { text: "owned auxiliary", toolCalls: [], stopReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; }
    modelCalls++;
    const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
    this.recordUsage(usage, options);
    if (!options.tools?.some((t: any) => t.name === "complete_goal")) throw Error("owned goal completion tool missing");
    return { text: "", toolCalls: [{ id: "owned-complete", toolName: "complete_goal", args: { summary: "owned memory completion" } }], stopReason: "tool_use", usage };
  }
}
registerProvider(provider, OwnedClient);

function ownedSession(name: string, bound: boolean, defaultRoot = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-goal-round20-")));
  const sm = defaultRoot ? new SessionManager() : new SessionManager(join(dir, "sessions"));
  const id = name + "-" + crypto.randomUUID();
  const b = sm.create(dir, "owned-memory-model", provider, id);
  b.state.origin = "desktop";
  b.state.kind = "work";
  b.state.workspace = { root: dir, kind: "main" };
  if (bound) b.state.project = { projectId: "owned-project-" + id, mainRootId: "owned-root" };
  if (!sm.saveState(b.state)) throw Error("owned session seed failed");
  const goal = { objective: "finish owned local task", goalId: "goal-" + id, revision: 1, paused: true };
  if (!sm.saveActiveGoal(b.state, goal)) throw Error("owned paused goal seed failed");
  const workspaceContext = createWorkspaceContext({ projectId: b.state.project?.projectId ?? "legacy-unused", projectRevision: 1, sessionMainRootId: "owned-root", roots: [{ id: "owned-root", path: dir, role: "primary" }] });
  const item = { dir, sm, id, goal, workspaceContext, engines: [] as any[], views: [] as any[] };
  resources.push(item);
  return item;
}
async function coreFixture(name: string, bound: boolean) {
  const f = ownedSession(name, false);
  if (bound) {
    const index = new SessionCwdIndex({ sessionsRoot: f.sm.getStorageDir() });
    await index.ensureLoaded();
    const store = new ProjectStore({ file: join(f.dir, "projects.json"), recentsFile: join(f.dir, "recents.json"), migrationMarkerFile: join(f.dir, "migration.json"), sessionIndex: index, sessionManager: f.sm, noRepoPath: join(f.dir, "no-repo"), resolveProjectRoot: (cwd: string) => cwd });
    const project = await store.createFromPath(f.dir);
    const state = f.sm.readSessionState(f.id)!;
    state.project = { projectId: project.id, mainRootId: project.primaryRootId };
    if (!f.sm.saveState(state)) throw Error("registered project binding save failed");
    index.refreshSync(f.id);
    const deps = {
      isProjectTrusted: () => false,
      lookupSession: (id: string, refresh: boolean) => refresh ? index.refreshSync(id) : index.lookupCached(id),
      resolveProjectRun: (projectId: string, sessionId: string, entry: any, rootId?: string) => {
        const resolved = store.resolveRunProjectSync(projectId, sessionId, entry, rootId);
        return { cwd: resolved.cwd, trustCwd: resolved.mainRoot.path, projectId: resolved.project.id, mainRootId: resolved.mainRoot.id, projectPrimaryRootId: resolved.project.primaryRootId, workspaceContext: resolved.workspaceContext };
      },
    };
    const authority = resolveSessionRunWorkspace({ sourceSessionId: f.id, targetSessionId: f.id }, deps);
    Object.assign(f, { workspaceContext: authority.workspaceContext, authority, project, index, store });
  }
  const calls: any[] = [], results: any[] = [], slices: any[] = [], frames: any[] = [];
  let dispatch!: (message: any) => void;
  const manager = new ChatSessionManager({ runtime: {} as any, engineFactory: (slice: any) => {
    slices.push(structuredClone(slice));
    const engine = new Engine({
      llm: { provider, model: "owned-memory-model", apiKey: "owned-placeholder", enableStreaming: false },
      sessionStorageDir: f.sm.getStorageDir(), cwd: slice.cwd ?? f.dir, workspaceContext: slice.workspaceContext,
      enabledBuiltinTools: ["complete_goal"], maxTurns: 2, permissionMode: "bypassPermissions",
    } as any);
    (engine as any).hooks.clear();
    const run = engine.run.bind(engine);
    engine.run = async (task: any, opts: any) => { calls.push({ task, opts }); const result = await run(task, opts); results.push(result); return result; };
    f.engines.push(engine); return engine;
  } });
  let hostWorkspaceRequests = 0;
  const server = new AgentServer({
    chatManager: manager, workspaceBridge: true,
    readActiveGoalFromDisk: (id: string) => f.sm.readActiveGoal(id),
    updateActiveGoalOnDisk: (id: string, patch: any) => f.sm.updateActiveGoal(id, patch)?.goal,
    transport: { onMessage: (fn: any) => { dispatch = fn; }, close() {}, send(message: any) {
      frames.push(message);
      if (message.method === "agent/approvalRequest" && message.params?.request?.toolName === "__workspace_action__") {
        hostWorkspaceRequests++;
        throw Error("unexpected host resolution: source review expected no request");
      }
    } } as any,
  });
  Object.assign(f, { manager, server });
  return { ...f, manager, server, calls, results, slices, frames, dispatch, hostWorkspaceRequests: () => hostWorkspaceRequests };
}
async function resume(f: any, expected = f.goal) {
  const id = "owned-resume-" + crypto.randomUUID();
  f.dispatch({ jsonrpc: "2.0", id, method: "agent/goalUpdate", params: { sessionId: f.id, paused: false, expectedGoalId: expected.goalId, expectedRevision: expected.revision } });
  await until(() => f.frames.some((x: any) => x.id === id), "missing resume RPC result");
  await until(() => f.results.length > 0, "missing real Engine result");
  await until(() => !f.manager.get(f.id)?.isBusy(), "resume did not settle");
  return f.frames.find((x: any) => x.id === id);
}

afterEach(async () => {
  for (const f of resources.splice(0)) {
    for (const view of f.views) { await act(async () => { view.root.unmount(); await tick(); }); view.container.parentNode?.removeChild(view.container); }
    await f.server?.close();
    for (const engine of f.engines) await engine.dispose();
    // Only fixture-owned session directories and fixture roots are removed.
    if (!f.sm.getStorageDir().startsWith(f.dir)) rmSync(join(f.sm.getStorageDir(), f.id), { recursive: true, force: true });
    rmSync(f.dir, { recursive: true, force: true });
  }
  ipcSent.length = 0;
  deliver = () => { throw Error("no owned IPC target"); };
  expect(networkCalls).toBe(0);
  expect(subprocessCalls).toBe(0);
});
afterAll(() => {
  if (completed === 4) {
    writeFileSync(join(import.meta.dir, "observations.json"), JSON.stringify({ completed, receipts, networkCalls, subprocessCalls, auxiliaryCalls, actualElectron: false, actualWorker: false, realProvider: false }, null, 2));
    console.log("Completed goal resume round20: 4 scenarios; actual Main callback/App Goal closures/preload/StatusPopover and actual Core Engine; no Electron/worker/provider/network");
  }
});

test("no-worker Desktop Resume returns success and flips actual UI to active, while no continuation is dispatched; pause/edit/delete retain disk behavior", async () => {
  const f = ownedSession("no-worker", false, true);
  const messages: any[] = [];
  let ensureCalls = 0, workerSends = 0;
  let mainCallback!: (event: any, line: string) => void;
  const receiver: any = {
    core: { canSend: () => false, hasChild: () => false, ensureWorker: () => { ensureCalls++; }, sendLine: () => { workerSends++; } },
    webConfiguration: { runBlocked: false }, sessionMainRootMigrationClaims: new Map(),
    agentRunMetadataDeps: () => ({ isProjectTrusted: () => false }),
    sessionsForFallback: () => f.sm,
    safeSend: (_channel: string, line: string) => { messages.push(JSON.parse(line)); emitReply(line); },
  };
  bindMainCallbackFactory({ on: (_channel: string, fn: any) => { mainCallback = fn; } }, metadata.prepareAgentRunMetadata, metadata.AgentRunMetadataError, optimization.isOptimizationLabQuery, fallback.quickChatRunSessionId, fallback.quickChatRunRequest, fallback.quickChatForkRequest, fallback.forkSourceSessionId, fallback.compactQuerySessionId, fallback.buildNoChildFallbackReply, { fromWebContents: () => null }, () => {}, { Overloaded: -32001 }).call(receiver);
  const sender = { id: 77, isDestroyed: () => false, send: (_channel: string, line: string) => emitReply(line) };
  deliver = (line) => mainCallback({ sender }, line);
  const logs: any[] = [];
  Object.defineProperty(window, "codeshell", { configurable: true, value: { goalUpdate: api.goalUpdate, goalGet: api.goalGet, goalDelete: api.goalDelete, goalClear: api.goalClear, log: (...args: any[]) => logs.push(args) } });
  const bucket = "owned::" + f.id;
  let map: any = { [bucket]: { ...INITIAL_STATE, activeGoal: { ...f.goal, round: 0 } } };
  const state: any = {};
  Object.defineProperty(state, "activeGoal", { get: () => map[bucket].activeGoal });
  let changed!: () => void;
  const controls = appMutations(state, bucket, { current: new Map() }, (action: any) => { map = transcriptsReducer(map, action); changed?.(); }, () => f.id, {}, () => {});
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container); f.views.push({ container, root });
  changed = () => root.render(React.createElement(StatusPopover, { busy: false, tasks: null, activeGoal: state.activeGoal, onGoalPausedChange: controls.handleGoalPausedChange, onUpdateGoal: controls.handleUpdateGoal, onDeleteGoal: controls.handleDeleteGoal }));
  await act(async () => { changed(); await tick(); });
  const resumeButton = nodes(container).find(n => props(n).title === "恢复目标");
  expect(resumeButton).toBeDefined();
  expect(textOf(container)).toContain("已暂停");
  const beforeModel = modelCalls;
  await act(async () => { props(resumeButton).onClick(); await tick(); });
  await until(() => messages.length >= 1, "Main missing: " + JSON.stringify({ messages, logs, ipcSent, goal: state.activeGoal }));
  expect(messages[0].result).toMatchObject({ ok: true, updated: true, paused: false, revision: 2 });
  expect(ipcSent.map(x => x.method)).toEqual(["agent/goalUpdate"]);
  expect(f.sm.readActiveGoal(f.id)).toMatchObject({ goalId: f.goal.goalId, revision: 2 });
  expect(f.sm.readActiveGoal(f.id)?.paused).toBeUndefined();
  expect(state.activeGoal).toMatchObject({ paused: false, revision: 2 });
  expect(nodes(container).some(n => props(n).title === "暂停目标")).toBe(true);
  expect(nodes(container).some(n => props(n).title === "恢复目标")).toBe(false);
  expect(ensureCalls).toBe(0); expect(workerSends).toBe(0); expect(modelCalls - beforeModel).toBe(0);
  expect(logs).toEqual([]);
  // Subsequent edit/pause/delete are legitimate disk-only controls and work.
  await act(async () => { controls.handleUpdateGoal("edited owned objective"); await tick(); });
  expect(f.sm.readActiveGoal(f.id)?.objective).toBe("edited owned objective");
  await act(async () => { controls.handleGoalPausedChange(true); await tick(); });
  expect(f.sm.readActiveGoal(f.id)?.paused).toBe(true);
  const current = f.sm.readActiveGoal(f.id)!;
  const stale = await api.goalUpdate(f.id, { paused: false, expectedGoalId: f.goal.goalId, expectedRevision: 1 });
  expect(stale.updated).toBe(false); expect(f.sm.readActiveGoal(f.id)?.revision).toBe(current.revision);
  await act(async () => { controls.handleDeleteGoal(); await tick(); });
  expect(f.sm.readActiveGoal(f.id)).toBeUndefined(); expect(state.activeGoal).toBeNull();
  expect(ensureCalls).toBe(0); expect(workerSends).toBe(0);
  receipts.push({ case: "no-worker", resumeResult: messages[0].result, uiActiveWithoutDispatch: true, ensureCalls, workerSends, modelCalls: modelCalls - beforeModel, actualAppMount: false, actualAppClosures: true, actualMainCallback: true });
  completed++;
});

test("CONTROL actual Core cold resume of an unbound legacy Session runs exactly once and persists completion", async () => {
  const f = await coreFixture("legacy-cold", false);
  const before = modelCalls;
  const reply = await resume(f);
  expect(reply.result).toMatchObject({ ok: true, updated: true, paused: false });
  expect(f.calls).toHaveLength(1); expect(f.results).toHaveLength(1);
  expect(f.results[0]).toMatchObject({ reason: "completed", turnCount: 1 });
  expect(modelCalls - before).toBe(1); expect(f.sm.readActiveGoal(f.id)).toBeUndefined();
  expect(f.sm.readSessionState(f.id)?.goalLifecycle).toMatchObject({ phase: "terminal", terminal: { reason: "completed" } });
  expect(f.hostWorkspaceRequests()).toBe(0);
  expect(f.slices).toHaveLength(2); expect(f.slices[0].workspaceContext).toBeUndefined(); expect(f.slices[1].cwd).toBe(f.dir);
  receipts.push({ case: "legacy-cold-control", result: f.results[0], modelCalls: modelCalls - before, calls: f.calls.length, hostWorkspaceRequests: f.hostWorkspaceRequests() });
  completed++;
});

test("a cold bound Session Resume never obtains Host WorkspaceContext, accepts but resolves turnCount0; ordinary authorized send recovers", async () => {
  const f = await coreFixture("bound-cold", true);
  const before = modelCalls;
  expect(f.sm.readSessionProjectBinding(f.id)).toEqual({ projectId: f.project.id, mainRootId: f.project.primaryRootId });
  expect(f.authority).toMatchObject({ cwd: f.dir, projectTrusted: false, workspaceContext: { projectId: f.project.id, sessionMainRootId: f.project.primaryRootId } });
  const reply = await resume(f);
  expect(reply.result).toMatchObject({ ok: true, updated: true, paused: false, revision: 2 });
  expect(f.calls).toHaveLength(1); expect(f.results).toHaveLength(1);
  expect(f.results[0]).toMatchObject({ reason: "model_error", turnCount: 0 });
  expect(f.results[0].text).toContain("bound Session requires an authoritative WorkspaceContext");
  expect(modelCalls - before).toBe(0); expect(f.hostWorkspaceRequests()).toBe(0);
  expect(f.slices).toHaveLength(2); expect(f.slices[1].workspaceContext).toBeUndefined();
  expect(f.sm.readActiveGoal(f.id)).toMatchObject({ goalId: f.goal.goalId, revision: 2 });
  expect(f.sm.readActiveGoal(f.id)?.paused).toBeUndefined();
  expect(f.sm.readSessionState(f.id)?.goalLifecycle?.phase).toBe("active");
  expect(f.frames.some(x => x.method === "agent/streamEvent" && x.params?.event?.type === "error")).toBe(false);
  expect(f.frames.some(x => x.method === "agent/streamEvent" && x.params?.event?.type === "session_started")).toBe(false);
  const failureResult = structuredClone(f.results[0]);
  // Service-level recovery: a normal request contains the authoritative context
  // that Desktop Main normally resolves. This is not a full Desktop send E2E.
  const normalId = "owned-normal-recovery";
  f.dispatch({ jsonrpc: "2.0", id: normalId, method: "agent/run", params: { sessionId: f.id, task: "continue owned goal", cwd: f.dir, workspaceContext: f.workspaceContext, projectTrusted: false } });
  await until(() => f.frames.some(x => x.id === normalId), "normal recovery missing");
  const normal = f.frames.find(x => x.id === normalId);
  expect(normal.result).toMatchObject({ reason: "completed", turnCount: 1 });
  expect(f.calls).toHaveLength(2); expect(modelCalls - before).toBe(1);
  expect(f.sm.readActiveGoal(f.id)).toBeUndefined();
  expect(f.sm.readSessionState(f.id)?.goalLifecycle).toMatchObject({ phase: "terminal", terminal: { reason: "completed" } });
  receipts.push({ case: "bound-cold", resumeResult: reply.result, engineFailure: failureResult, modelCallsBeforeRecovery: 0, hostWorkspaceRequests: f.hostWorkspaceRequests(), normalRecovery: normal.result, actualMainSend: false });
  completed++;
});


test("CONTROL an idle resident bound Session with its actual Host authority resumes exactly once", async () => {
  const f = await coreFixture("resident-bound", true);
  await f.manager.getOrCreate(f.id, f.authority);
  expect(f.manager.get(f.id)).toBeDefined();
  expect(f.slices).toHaveLength(1);
  expect(f.slices[0].workspaceContext).toEqual(f.workspaceContext);
  const before = modelCalls;
  const reply = await resume(f);
  expect(reply.result).toMatchObject({ ok: true, updated: true, paused: false });
  expect(f.calls).toHaveLength(1); expect(f.results).toHaveLength(1);
  expect(f.results[0]).toMatchObject({ reason: "completed", turnCount: 1 });
  expect(modelCalls - before).toBe(1); expect(f.sm.readActiveGoal(f.id)).toBeUndefined();
  expect(f.sm.readSessionState(f.id)?.goalLifecycle).toMatchObject({ phase: "terminal", terminal: { reason: "completed" } });
  expect(f.hostWorkspaceRequests()).toBe(0);
  receipts.push({ case: "resident-bound-control", result: f.results[0], modelCalls: modelCalls - before, actualHostAuthority: f.authority, actualCoreRuns: f.calls.length });
  completed++;
});

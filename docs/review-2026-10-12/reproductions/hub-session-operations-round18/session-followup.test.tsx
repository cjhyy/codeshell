import { expect, mock, test } from "bun:test";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded HOME required");
const repo = process.cwd();
const reserved = createServer();
await new Promise<void>(resolve => reserved.listen(0, "127.0.0.1", resolve));
const port = (reserved.address() as any).port;
await new Promise<void>(resolve => reserved.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard(origin);
const deny = () => { throw Error("NETWORK_FORBIDDEN_round18"); };
net.connect = net.createConnection = deny as any; tls.connect = deny as any;
const NativeWebSocket = globalThis.WebSocket;
let cookie = "";
class OwnedWebSocket extends NativeWebSocket {
  constructor(url: any) {
    if (new URL(String(url)).origin !== origin.replace("http:", "ws:")) throw Error("WS_NETWORK_FORBIDDEN_round18");
    super(url, { headers: { cookie, origin } } as any);
  }
}
globalThis.WebSocket = OwnedWebSocket as any;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
let bridge: any;
let createCore: () => any;
class InMemoryCoreBridge {
  frames: any[] = [];
  emitted: any[] = [];
  listeners = new Set<(line: string) => void>();
  child = false;
  core: any;
  pending = new Map<any, (message: any) => void>();
  constructor(readonly options: any) { bridge = this; }
  subscribeLines(callback: any) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  ensureWorker() { if (!this.core) this.core = createCore(); this.child = true; }
  hasChild() { return this.child; }
  canSend() { return true; }
  workerGeneration() { return 1; }
  injectWorkerMessage(line: string) { const value = JSON.parse(line); this.frames.push(value); this.ensureWorker(); this.core.receive(value); }
  emit(value: any) {
    this.emitted.push(value);
    const pending = value.method === undefined ? this.pending.get(value.id) : undefined;
    if (pending) { this.pending.delete(value.id); pending(value); return; }
    for (const cb of this.listeners) cb(JSON.stringify(value));
  }
  request(method: string, params: any, options: any) {
    this.ensureWorker();
    return new Promise(resolve => { this.pending.set(options.id, (value: any) => resolve(value.error ? { status: "error", error: value.error } : { status: "result", result: value.result })); this.core.receive({ jsonrpc: "2.0", id: options.id, method, params }); });
  }
  async stopAndWait() { this.child = false; await this.core?.server.close(); }
  kill() { throw Error("unexpected worker kill"); }
}
mock.module(`${repo}/packages/server/src/worker-bridge-core.ts`, () => ({ WorkerBridgeCore: InMemoryCoreBridge, previewLine: (value: string) => value.slice(0, 100) }));
const { startHeadlessServer } = await import(`${repo}/packages/server/src/serve/headless-server.ts`);
const { AgentServer } = await import(`${repo}/packages/core/src/protocol/server.ts`);
const { ChatSessionManager } = await import(`${repo}/packages/core/src/protocol/chat-session-manager.ts`);
const { SessionManager, SettingsManager } = await import(`${repo}/packages/core/dist/index.js`);
const React = (await import(`${repo}/packages/desktop/node_modules/react/index.js`)).default;
const { act } = await import(`${repo}/packages/desktop/node_modules/react/index.js`);
const { createRoot } = await import(`${repo}/packages/desktop/node_modules/react-dom/client`);
const { ensureMiniDom, flushMicrotasks } = await import(`${repo}/packages/web/src/test-utils/renderHook.tsx`);
const { HubSessions } = await import(`${repo}/packages/web/app/HubSessions.tsx`);
const { createHubSessions } = await import(`${repo}/packages/server/src/hub/session-management.ts`);
const guardedFetch = globalThis.fetch;
globalThis.fetch = (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? input, origin);
  const headers = new Headers(init?.headers);
  if (!headers.has("cookie") && cookie) headers.set("cookie", cookie);
  if (!headers.has("origin")) headers.set("origin", origin);
  return guardedFetch(url, { ...init, headers });
};

const nodes = (node: any): any[] => [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
const props = (node: any): any => { const key = Object.keys(node).find(k => k.startsWith("__reactProps$")); return key ? node[key] : {}; };
const text = (node: any): string => (node.textContent ?? "") + Array.from(node.childNodes ?? []).map(text).join("");
async function until(check: () => boolean, label: string) {
  const end = performance.now() + 3000;
  while (!check()) { if (performance.now() > end) throw Error("timeout " + label + "; frames=" + JSON.stringify(bridge?.emitted)); await act(async () => { await new Promise(r => setTimeout(r, 5)); await flushMicrotasks(); }); }
}

test("real authenticated Hub history fails to recognize a real Core admitted asynchronous-answer follow-up as running", async () => {
  const own = mkdtempSync(join(tmpdir(), "codeshell-hub-session-round18-"));
  const cwd = join(own, "workspace"), data = join(own, "data"), id = "owned-followup-session";
  mkdirSync(cwd);
  const initialGate = deferred(), followupGate = deferred();
  let ask: any, runs = 0, coreManager: any, host: any, ws: any, root: any, container: any;
  const engine: any = {
    setAskUser() {}, setAskUserAsync(fn: any) { ask = fn; }, setPlanMode() {}, setBrowserBridge() {}, setInjectCredential() {}, setSessionMessageRouter() {},
    isHeadless: () => false, getGoal: () => undefined, resolveSessionRunWorkspace: () => ({ cwd }), enqueueSteer: () => ({ accepted: false }), unsteer: () => false, switchModel() {}, resetSessionUsage() {},
    getEffectiveDisabledLists: () => ({ disabledPlugins: [], disabledSkills: [], disabledMcpServers: [], disabledTools: [] }), refreshRuntimeConfig() {},
    async run(task: string, options: any) {
      runs++;
      options.onStream?.({ type: "session_started", sessionId: id, promptTokens: 0, runId: "owned-run-" + runs, clientMessageId: options.clientMessageId });
      options.onStream?.({ type: "stream_request_start", model: "owned-memory-engine" });
      options.signal?.addEventListener("abort", () => { initialGate.resolve(); followupGate.resolve(); }, { once: true });
      if (runs === 1) { await ask("Owned question for later answer"); await initialGate.promise; }
      else { await followupGate.promise; }
      options.onStream?.({ type: "turn_complete", reason: "completed" });
      return { text: "owned fixture only", reason: "completed", sessionId: id, turnCount: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
  };
  createCore = () => {
    coreManager = new ChatSessionManager({ runtime: { reloadModelsFromSettings() {} } as any, idleTtlMs: 60_000, engineFactory: () => engine });
    let receive: any;
    const server = new AgentServer({ chatManager: coreManager, settingsReader: () => new SettingsManager(cwd, "full").get(), transport: { send: (value: any) => bridge.emit(value), onMessage: (cb: any) => receive = cb, close() {} } as any });
    return { server, receive: (value: any) => receive(value) };
  };
  const messages: any[] = [];
  const patch = (body: any) => fetch(origin + "/api/v1/sessions/" + id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    host = await startHeadlessServer({ host: "127.0.0.1", port, cwd, dataDir: data, workerEntryPath: join(own, "never-spawn.cjs"), authMode: "hub" });
    const disk = new SessionManager(join(data, "worker", "sessions"));
    const durable = disk.create(cwd, "owned-model", "owned-provider", id);
    disk.updateSessionState(id, { title: "Owned follow-up history" });
    durable.transcript.append("message", { role: "user", content: "Persisted owned source" });
    const setup = await fetch(origin + "/api/v1/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: host.bootstrapToken, username: "owned", password: "owned-session-password" }) });
    expect(setup.status).toBe(200); cookie = setup.headers.get("set-cookie")!.split(";", 1)[0];
    ws = new OwnedWebSocket(origin.replace("http:", "ws:") + "/ws");
    ws.addEventListener("message", (event: any) => messages.push(JSON.parse(String(event.data))));
    await until(() => messages.some(m => m.method === "serve/hello"), "hello");
    const send = (requestId: string, method: string, params: any) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
    send("first-run", "agent/run", { sessionId: id, model: "owned-model", task: "Owned fixture asks, no model" });
    try { await until(() => coreManager?.get(id)?.isBusy() && messages.some(m => m.method === "agent/approvalRequest"), "first run active with async question"); } catch (error) { console.log("owned protocol diagnostic", JSON.stringify(messages), JSON.stringify(bridge.frames)); throw error; }
    expect((await patch({ archived: true })).status).toBe(409);
    expect((await fetch(origin + "/api/v1/sessions/" + id + "/export")).status).toBe(409);
    expect(disk.readSessionArchivedAt(id)).toBeUndefined();
    initialGate.resolve();
    await until(() => messages.some(m => m.id === "first-run" && m.result), "first run completes");
    expect(coreManager.get(id).isBusy()).toBe(false);
    const question = messages.find(m => m.method === "agent/approvalRequest").params;
    send("answer", "agent/approve", { sessionId: id, requestId: question.requestId, decision: { approved: true, answer: "Owned later answer" } });
    await until(() => messages.some(m => m.id === "answer" && m.result) && runs === 2, "answer ACK and follow-up active");
    expect(coreManager.get(id).isBusy()).toBe(true);
    expect(host.pendingResponseCount()).toBe(0);
    expect(bridge.emitted.some((m: any) => m.method === "agent/streamEvent" && m.params.event.type === "session_started" && m.params.event.clientMessageId === "ask-user-" + question.requestId)).toBe(true);
    const listed = await (await fetch(origin + "/api/v1/sessions?archived=false")).json();
    expect(listed.sessions.find((s: any) => s.sessionId === id).running).toBe(false);

    ensureMiniDom();
    globalThis.requestAnimationFrame = ((cb: any) => { cb(0); return 0; }) as any;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    const changed: string[] = [], opened: string[] = [];
    await act(async () => { root.render(React.createElement(HubSessions, { onAuthLost: () => { throw Error("auth lost"); }, onOpen: (sid: string) => opened.push(sid), onChanged: () => changed.push("changed") })); await flushMicrotasks(); });
    const button = (text: string) => nodes(container).find(n => n.tagName === "BUTTON" && n.textContent === text);
    await until(() => Boolean(button("归档")), "actual history loaded");
    expect(props(button("归档")).disabled).toBe(false);
    await act(async () => { props(button("归档")).onClick(); await flushMicrotasks(); });
    await until(() => disk.readSessionArchivedAt(id) !== undefined, "actual history archive committed");
    await until(() => changed.length === 1, "actual archive response consumed");
    await until(() => !button("归档"), "active follow-up hidden from current history");
    expect(coreManager.get(id).isBusy()).toBe(true);
    expect(changed).toEqual(["changed"]);
    expect(opened).toEqual([]);
    expect(disk.readSessionState(id)?.sessionId).toBe(id);

    // Explicitly restore via the real current API. This is a normal recovery
    // control, not a claim that the history page offers cancellation itself.
    expect((await patch({ archived: false })).status).toBe(200);
    expect(disk.readSessionArchivedAt(id)).toBeUndefined();
    followupGate.resolve();
    await until(() => !coreManager.get(id).isBusy(), "follow-up completes");
    expect(disk.readSessionState(id)?.sessionId).toBe(id);
    console.log(JSON.stringify({ actualHeadlessAuthHttpWs: true, actualCoreAgentServerAndChatSessionManager: true, actualHubSessionsArchiveHandler: true, bridge: "in-memory all Core frames forwarded", engine: "fake controlled run; no model or native worker", normalRunArchiveAndExport: 409, asyncAnswerFollowupCoreBusy: true, hostHistoryRunning: false, archiveSucceedsWhileFollowupActive: true, durableSessionRetained: true, restoreAndCompletionControl: true }));
  } finally {
    initialGate.resolve(); followupGate.resolve();
    if (root) await act(async () => { root.unmount(); await flushMicrotasks(); });
    container?.parentNode?.removeChild(container);
    ws?.close();
    if (host) await host.close();
    await bridge?.core?.server.close();
    rmSync(own, { recursive: true, force: true });
  }
}, 15000);

test("actual Hub history title editor preserves drafts through conflict, failed storage and vanished session; explicit review and same-draft retry recover", async () => {
  const own = mkdtempSync(join(tmpdir(), "codeshell-hub-title-round18-"));
  const cwd = join(own, "workspace"), data = join(own, "data"), sessionRoot = join(own, "sessions"), id = "owned-title-session";
  mkdirSync(cwd); mkdirSync(data);
  const disk = new SessionManager(sessionRoot);
  disk.create(cwd, "owned-model", "owned-provider", id);
  disk.updateSessionState(id, { title: "Owned generated title" });
  cookie = "owned-title-fixture=1";
  const changed: string[] = [], requests: string[] = [];
  const running = new Set<string>();
  const service = createHubSessions({ cwd, sessionRootDir: sessionRoot, dataDir: data, isAuthorized: async (req: any) => req.headers.cookie === cookie, isRunning: (sid: string) => running.has(sid), onChanged: (sid: string) => changed.push(sid) });
  const server = createServer((req, res) => { requests.push(`${req.method} ${req.url}`); void service.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  let root: any, container: any;
  const patch = (body: any) => fetch(origin + "/api/v1/sessions/" + id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const detail = async () => (await (await fetch(origin + "/api/v1/sessions/" + id)).json());
  try {
    await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
    ensureMiniDom();
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    const dirty: boolean[] = [];
    await act(async () => { root.render(React.createElement(HubSessions, { onAuthLost: () => { throw Error("unexpected auth loss"); }, onOpen() {}, onDirtyChange: (value: boolean) => dirty.push(value) })); await flushMicrotasks(); });
    const button = (text: string) => nodes(container).find(n => n.tagName === "BUTTON" && n.textContent === text);
    const editor = () => nodes(container).find(n => n.tagName === "FORM");
    const title = () => nodes(container).find(n => n.tagName === "INPUT" && props(n).className === "library-title-input");
    const edit = async (value: string) => { await act(async () => { props(button("重命名")).onClick({ currentTarget: button("重命名") }); await flushMicrotasks(); }); await act(async () => { props(title()).onChange({ target: { value } }); await flushMicrotasks(); }); };
    const submit = async (twice = false) => { await act(async () => { props(editor()).onSubmit({ preventDefault() {} }); if (twice) props(editor()).onSubmit({ preventDefault() {} }); await flushMicrotasks(); }); };
    await until(() => Boolean(button("重命名")), "title history loaded");
    await edit("Owned draft C");
    expect(props(title()).value).toBe("Owned draft C");
    expect(dirty.at(-1)).toBe(true);
    expect((await patch({ title: "Other device B", expectedTitle: "" })).status).toBe(200);
    const writesBefore = requests.filter(r => r.startsWith("PATCH")).length;
    await submit(true);
    await until(() => text(container).includes("另一设备已修改标题"), "actual conflict shown");
    expect(requests.filter(r => r.startsWith("PATCH")).length - writesBefore).toBe(1);
    expect(props(title()).value).toBe("Owned draft C");
    expect(props(button("保存标题")).disabled).toBe(true);
    expect((await detail()).customTitle).toBe("Other device B");
    await act(async () => { props(button("读取最新标题")).onClick(); await flushMicrotasks(); });
    await until(() => Boolean(button("确认保存我的标题")), "review latest title");
    expect(props(title()).value).toBe("Owned draft C");
    expect(text(container)).toContain("Other device B");
    await submit();
    await until(() => !editor(), "reviewed draft saved");
    expect((await detail()).customTitle).toBe("Owned draft C");

    await until(() => Boolean(button("重命名")), "title row reloaded");
    await edit("Owned registry-failure draft D");
    renameSync(join(data, "session-titles.json"), join(data, "owned-titles-backup.json"));
    mkdirSync(join(data, "session-titles.json"));
    await submit();
    await until(() => text(container).includes("会话操作失败，原有记录仍保留"), "storage refusal visible");
    expect(props(title()).value).toBe("Owned registry-failure draft D");
    expect(props(button("保存标题")).disabled).toBe(false);
    expect((await detail()).title).toBe("Owned generated title");
    rmSync(join(data, "session-titles.json"), { recursive: true });
    renameSync(join(data, "owned-titles-backup.json"), join(data, "session-titles.json"));
    await submit();
    await until(() => !editor(), "same draft storage retry succeeds");
    expect((await detail()).customTitle).toBe("Owned registry-failure draft D");

    await until(() => Boolean(button("重命名")), "stored title reloaded");
    await edit("Owned vanished session draft E");
    renameSync(join(sessionRoot, id), join(own, "owned-session-backup"));
    await submit();
    await until(() => text(container).includes("当前工作区没有这个会话"), "vanished session refused");
    expect(props(title()).value).toBe("Owned vanished session draft E");
    expect(props(button("保存标题")).disabled).toBe(true);
    renameSync(join(own, "owned-session-backup"), join(sessionRoot, id));
    await act(async () => { props(button("读取最新标题")).onClick(); await flushMicrotasks(); });
    await until(() => Boolean(button("确认保存我的标题")), "session returned and explicit read succeeds");
    expect(props(title()).value).toBe("Owned vanished session draft E");
    await submit(); await until(() => !editor(), "same returned-session draft saved");
    expect((await detail()).customTitle).toBe("Owned vanished session draft E");
    expect(disk.readSessionState(id)?.title).toBe("Owned generated title");
    expect(changed).toEqual([id, id, id, id]);
    console.log(JSON.stringify({ control: "real HubSessions editor and real HTTP session service", authenticationBoundary: "owned fixture Cookie predicate, not HubAuth in this control", conflictPreservesDraftAndRequiresExplicitReview: true, synchronousWriteRefSuppressesDoubleSubmit: true, realNonFileRegistry500PreservesDraftAndSameDraftRetries: true, realVanishedSession404PreservesDraftAndExplicitReadRecovers: true, generatedEngineTitleUnchanged: true, noModelOrWorker: true }));
  } finally {
    chmodSync(data, 0o700);
    if (root) await act(async () => { root.unmount(); await flushMicrotasks(); });
    container?.parentNode?.removeChild(container);
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(own, { recursive: true, force: true });
  }
}, 15000);

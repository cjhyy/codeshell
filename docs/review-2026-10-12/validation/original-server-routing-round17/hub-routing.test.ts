import { expect, mock, test } from "bun:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded HOME required");
const repo = process.cwd();
const reservation = createServer();
await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = (reservation.address() as any).port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard(origin);
const deny = () => { throw Error("NETWORK_FORBIDDEN_round17"); };
net.connect = net.createConnection = deny as any; tls.connect = deny as any;
const OriginalWebSocket = globalThis.WebSocket;
let browserCookie = "";
class OwnedWebSocket extends OriginalWebSocket {
  constructor(url: any, options?: any) {
    const parsed = new URL(String(url));
    if (parsed.origin !== origin.replace("http:", "ws:")) throw Error("WS_NETWORK_FORBIDDEN_round17");
    super(url, options ?? { headers: { cookie: browserCookie, origin } });
  }
}
globalThis.WebSocket = OwnedWebSocket as any;

const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => resolve = r); return { promise, resolve }; };
let bridge: any;
class ControlledBridge {
  frames: any[] = [];
  listeners = new Set<(line: string) => void>();
  child = false;
  configure: any;
  constructor(readonly options: any) { bridge = this; }
  subscribeLines(callback: any) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  ensureWorker() { this.child = true; }
  hasChild() { return this.child; }
  canSend() { return true; }
  workerGeneration() { return 1; }
  injectWorkerMessage(line: string) { this.frames.push(JSON.parse(line)); }
  emit(value: any) { for (const cb of this.listeners) cb(JSON.stringify({ jsonrpc: "2.0", ...value })); }
  request(method: string) {
    if (method !== "agent/configure") throw Error("unexpected worker RPC " + method);
    this.configure = deferred();
    return this.configure.promise;
  }
  async stopAndWait() { this.child = false; }
  kill() { throw Error("unexpected worker kill"); }
}
mock.module(`${repo}/packages/server/src/worker-bridge-core.ts`, () => ({ WorkerBridgeCore: ControlledBridge, previewLine: (v: string) => v.slice(0, 100) }));
const { startHeadlessServer } = await import(`${repo}/packages/server/src/serve/headless-server.ts`);
const { SessionManager } = await import(`${repo}/packages/core/dist/index.js`);
const React = (await import(`${repo}/packages/desktop/node_modules/react/index.js`)).default;
const { act } = await import(`${repo}/packages/desktop/node_modules/react/index.js`);
const { createRoot } = await import(`${repo}/packages/desktop/node_modules/react-dom/client`);
const { ensureMiniDom, flushMicrotasks } = await import(`${repo}/packages/web/src/test-utils/renderHook.tsx`);
const { useHubController } = await import(`${repo}/packages/web/app/useHubController.tsx`);
const guardedFetch = globalThis.fetch;
globalThis.fetch = (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? input, origin);
  const headers = new Headers(init?.headers);
  if (!headers.has("cookie") && browserCookie) headers.set("cookie", browserCookie);
  if (!headers.has("origin")) headers.set("origin", origin);
  return guardedFetch(url, { ...init, headers });
};

const sleep = () => new Promise(r => setTimeout(r, 5));
async function until(check: () => boolean, label: string) {
  const end = performance.now() + 3000;
  while (!check()) { if (performance.now() > end) throw Error("timeout " + label); await act(async () => { await sleep(); await flushMicrotasks(); }); }
}
test("actual Hub routing: detached approval error recovers; config reload can strand an idle async question submitted before its gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-hub-routing-round17-"));
  const cwd = join(directory, "workspace"), data = join(directory, "data");
  mkdirSync(join(cwd, ".code-shell", "skills", "owned"), { recursive: true });
  writeFileSync(join(cwd, ".code-shell", "skills", "owned", "SKILL.md"), "---\nname: owned\ndescription: owned routing control\n---\nOwned fixture.\n");
  const sockets: any[] = [];
  let server: any;
  let uiRoot: any, container: any, view: any;
  const originalNow = Date.now;
  let clockOffset = 0;
  Date.now = () => originalNow() + clockOffset;
  const observations: any = {};
  try {
    server = await startHeadlessServer({ host: "127.0.0.1", port, cwd, dataDir: data, workerEntryPath: join(directory, "never-spawn.cjs"), authMode: "hub" });
    const request = (path: string, body: any, cookie?: string) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const setup = await request("/api/v1/auth/setup", { token: server.bootstrapToken, username: "owned", password: "owned-routing-password" });
    expect(setup.status).toBe(200);
    const cookie = setup.headers.get("set-cookie")!.split(";", 1)[0];
    browserCookie = cookie;
    const connect = async () => {
      const ws = new OwnedWebSocket(origin.replace("http:", "ws:") + "/ws", { headers: { cookie, origin } });
      sockets.push(ws);
      const messages: any[] = [];
      ws.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
      await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(Error("owned ws error")), { once: true }); });
      await until(() => messages.some(m => m.method === "serve/hello"), "hello");
      return { ws, messages, send: (id: string, method: string, params: any) => ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })) };
    };
    const sm = new SessionManager(join(data, "worker", "sessions"));
    sm.create(cwd, "owned-model", "owned-provider", "owned-session");
    const a = await connect(), b = await connect();
    bridge.ensureWorker();
    const approval = (requestId: string) => ({ method: "agent/approvalRequest", params: { requestId, sessionId: "owned-session", connectionId: "owned-connection", generation: 1, request: { toolName: "__ask_user__", args: { question: "Owned question", asynchronous: true }, description: "Owned question", riskLevel: "low" } } });

    // A submitted approval survives its originating tab closing until actual
    // worker ACK. The controlled worker emits error, then another tab retries.
    bridge.emit(approval("normal-question"));
    await until(() => b.messages.some(m => m.method === "agent/approvalRequest"), "broadcast question");
    a.send("same-local-id", "agent/approve", { sessionId: "owned-session", requestId: "normal-question", decision: { approved: true, answer: "A" }, generation: 999 });
    await until(() => bridge.frames.length === 1, "approval dispatched");
    expect(bridge.frames[0].params.generation).toBe(1);
    expect(bridge.frames[0].id).not.toBe("same-local-id");
    expect(server.pendingResponseCount()).toBe(1);
    a.ws.close(); await until(() => server.tabCount() === 1, "first tab closes");
    expect(server.pendingResponseCount()).toBe(1);
    bridge.emit({ id: bridge.frames[0].id, error: { code: -32009, message: "owned decision rejected before consumption" } });
    await until(() => b.messages.some(m => m.method === "serve/approvalSnapshot" && m.params.approvals.some((p: any) => p.requestId === "normal-question")), "retry snapshot");
    expect(server.pendingResponseCount()).toBe(0);
    b.send("same-local-id", "agent/approve", { sessionId: "owned-session", requestId: "normal-question", decision: { approved: true, answer: "A" } });
    await until(() => bridge.frames.length === 2, "second tab retry dispatched");
    bridge.emit({ id: bridge.frames[1].id, result: { approved: true } });
    await until(() => b.messages.some(m => m.id === "same-local-id"), "original local id reply");
    expect(b.messages.find(m => m.id === "same-local-id").result).toEqual({ approved: true });
    observations.detachedErrorAckReopensAndOtherTabRetries = true;

    // Idle AsyncAskUser survives turn completion in Core. A legitimate config
    // save has a real asynchronous worker configure/ACK boundary after writing.
    ensureMiniDom();
    let location = new URL(origin + "/?session=owned-session");
    Object.defineProperty(globalThis, "location", { configurable: true, get: () => location });
    Object.defineProperty(window, "location", { configurable: true, get: () => location });
    Object.defineProperty(window, "history", { configurable: true, value: { state: null, replaceState(_s: any, _u: any, next: any) { location = new URL(String(next), location); } } });
    Object.defineProperty(globalThis, "history", { configurable: true, value: window.history });
    container = document.createElement("div"); document.body.appendChild(container); uiRoot = createRoot(container);
    function UI() { view = useHubController({ hub: true }); return React.createElement("div", null, view.approvalContent, React.createElement("p", { role: "alert" }, view.error)); }
    await act(async () => { uiRoot.render(React.createElement(UI)); await flushMicrotasks(); });
    await until(() => view?.connection === "open", "actual controller connects");
    b.send("owned-run", "agent/run", { sessionId: "owned-session", model: "owned-model", task: "owned fixture only" });
    await until(() => bridge.frames.length === 3, "asking run dispatch");
    const whileActive = await fetch(origin + "/api/v1/configuration/skills", { method: "PUT", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ name: "owned", enabled: false }) });
    expect(whileActive.status).toBe(409);
    expect(bridge.configure).toBeUndefined();
    await act(async () => { bridge.emit(approval("candidate-question")); bridge.emit({ id: bridge.frames[2].id, result: { reason: "completed" } }); await flushMicrotasks(); });
    await until(() => b.messages.some(m => m.params?.requestId === "candidate-question"), "candidate question");
    await until(() => view.approvals.length === 1, "actual question UI");
    expect(server.pendingResponseCount()).toBe(0);
    const save = fetch(origin + "/api/v1/configuration/skills", { method: "PUT", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ name: "owned", enabled: false }) });
    await until(() => Boolean(bridge.configure), "actual configure request");
    const nodes = (n: any): any[] => [n, ...Array.from(n.childNodes ?? []).flatMap(nodes)];
    const props = (n: any): any => { const key = Object.keys(n).find(k => k.startsWith("__reactProps$")); return key ? n[key] : {}; };
    const answerButton = () => nodes(container).find(n => n.tagName === "BUTTON" && props(n).className === "send");
    const textarea = () => nodes(container).find(n => n.tagName === "TEXTAREA");
    await act(async () => { props(textarea()).onChange({ target: { value: "A" } }); await flushMicrotasks(); });
    expect(props(answerButton()).disabled).toBe(false);
    await act(async () => { props(answerButton()).onClick(); await flushMicrotasks(); });
    await until(() => view.error.includes("配置正在保存"), "actual UI config gate error");
    expect(bridge.frames).toHaveLength(3);
    expect(server.pendingResponseCount()).toBe(0);
    expect(props(answerButton()).disabled).toBe(true);
    bridge.configure.resolve({ status: "result", result: { ok: true } });
    expect((await save).status).toBe(200);
    clockOffset = 31_000;
    await until(() => props(answerButton()).disabled === false, "lease UI expires by injected clock");
    await act(async () => { props(answerButton()).onClick(); await flushMicrotasks(); });
    await until(() => view.error === "approval is no longer pending", "actual UI retry after config");
    const c = await connect();
    expect(c.messages.find(m => m.method === "serve/approvalSnapshot").params.approvals).toEqual([]);
    expect(bridge.frames).toHaveLength(3);
    observations.idleQuestionStrandedByConfigurationGate = true;
    observations.reloadCompletedButRetryRejected = true;
    observations.reconnectedSnapshotMissingPendingQuestion = true;
    observations.realControllerAndAnswerButton = true;
    observations.leaseExpiryClockInjectedNotWallClock = true;

    // Actual UI Stop still reaches the worker. Separate actual-Core control
    // proves cancel retires the question and emits this resolution, whereas
    // this Headless network fixture controls the worker protocol outcome.
    await act(async () => { view.stop(); await flushMicrotasks(); });
    await until(() => bridge.frames.length === 4, "explicit cancel dispatch");
    expect(bridge.frames[3].method).toBe("agent/cancel");
    await act(async () => { bridge.emit({ method: "agent/approvalResolved", params: { requestId: "candidate-question", sessionId: "owned-session" } }); bridge.emit({ id: bridge.frames[3].id, result: { cancelled: true } }); await flushMicrotasks(); });
    await until(() => b.messages.some(m => m.method === "agent/approvalResolved" && m.params.requestId === "candidate-question"), "resolution cleanup");
    await until(() => view.approvals.length === 0, "UI cancel clears old card");
    await act(async () => { bridge.emit(approval("fresh-after-cancel")); await flushMicrotasks(); });
    await until(() => Boolean(textarea()), "fresh card");
    await act(async () => { props(textarea()).onChange({ target: { value: "A fresh answer" } }); await flushMicrotasks(); });
    expect(props(answerButton()).disabled).toBe(false);
    await act(async () => { props(answerButton()).onClick(); await flushMicrotasks(); });
    await until(() => bridge.frames.length === 5, "fresh answer dispatch");
    expect(bridge.frames[4].params.requestId).toBe("fresh-after-cancel");
    await act(async () => { bridge.emit({ id: bridge.frames[4].id, result: { approved: true } }); await flushMicrotasks(); });
    await until(() => view.approvals.length === 0, "fresh ACK clears card");
    observations.explicitStopAndFreshQuestionRecovery = "actual UI/protocol; controlled worker resolution plus separate actual-Core cancel control";
    console.log(JSON.stringify({ ...observations, realHeadlessHttpWsAuth: true, workerBoundary: "memory-only; no spawn/Core engine", model: false }));
  } finally {
    Date.now = originalNow;
    if (uiRoot) await act(async () => { uiRoot.unmount(); await flushMicrotasks(); });
    container?.parentNode?.removeChild(container);
    for (const ws of sockets) ws.close();
    if (server) await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

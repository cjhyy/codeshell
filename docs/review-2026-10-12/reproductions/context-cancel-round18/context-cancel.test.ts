import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded HOME required");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
installLocalNetworkGuard("http://127.0.0.1:9");
let network = 0;
const deny = () => { network++; throw Error("round18 unexpected direct network"); };
net.connect = net.createConnection = deny as any;
tls.connect = deny as any;

const React = (await import(repo + "/packages/desktop/node_modules/react")).default;
const { act } = React;
const { createRoot } = await import(repo + "/packages/desktop/node_modules/react-dom/client");
const { ensureMiniDom, flushMicrotasks } = await import(repo + "/packages/desktop/src/renderer/test-utils/renderHook.tsx");
const { ChatView } = await import(repo + "/packages/desktop/src/renderer/ChatView.tsx");
ensureMiniDom();

let preloadApi: any;
let deliverLine: undefined | ((line: string) => void);
const listeners = new Map<string, Set<(...args: any[]) => void>>();
const ipcSent: any[] = [];
mock.module("electron", () => ({
  contextBridge: { exposeInMainWorld: (_key: string, value: any) => { preloadApi = value; } },
  webUtils: { getPathForFile: () => "" },
  ipcRenderer: {
    on(channel: string, callback: any) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(callback); return this; },
    removeListener(channel: string, callback: any) { listeners.get(channel)?.delete(callback); return this; },
    send(channel: string, line: string) {
      if (channel !== "agent:msg" || !deliverLine) throw Error("unexpected owned IPC send: " + channel);
      ipcSent.push(JSON.parse(line)); deliverLine(line);
    },
    invoke: async (channel: string) => { throw Error("unexpected owned IPC invoke: " + channel); },
  },
}));
await import(repo + "/packages/desktop/src/preload/index.ts");
const emitReply = (message: any) => { for (const callback of listeners.get("agent:msg") ?? []) callback({}, JSON.stringify(message)); };

const { LLMClientBase } = await import(repo + "/packages/core/src/llm/client-base.ts");
const { registerProvider } = await import(repo + "/packages/core/src/llm/client-factory.ts");
const { Engine } = await import(repo + "/packages/core/src/engine/engine.ts");
const { ChatSessionManager } = await import(repo + "/packages/core/src/protocol/chat-session-manager.ts");
const { AgentServer } = await import(repo + "/packages/core/src/protocol/server.ts");
const provider = "owned-review-context-cancel-round18";
const clients = new Map<string, any>();
class OwnedClient extends LLMClientBase {
  protected initClient() {}
  async createMessage(options: any) {
    const control = clients.get(this.model);
    if (!control) throw Error("unknown owned model");
    control.calls++; control.signal = options.signal;
    if (control.wait) await new Promise<void>((resolve, reject) => {
      control.release = resolve;
      control.abort = () => { control.aborts++; reject(Error("owned summary aborted")); };
      if (options.signal?.aborted) control.abort();
      else options.signal?.addEventListener("abort", control.abort, { once: true });
    });
    if (control.signal && control.abort) control.signal.removeEventListener("abort", control.abort);
    const usage = { promptTokens: 5, completionTokens: 2, totalTokens: 7 };
    this.recordUsage(usage, options);
    return { text: "owned cancellation audit summary", toolCalls: [], stopReason: "stop", usage };
  }
}
registerProvider(provider, OwnedClient);
const nodes = (n: any): any[] => [n, ...Array.from(n?.childNodes ?? []).flatMap(nodes)];
const props = (n: any): any => { const key = Object.keys(n ?? {}).find(x => x.startsWith("__reactProps$")); return key ? n[key] : {}; };
const textOf = (n: any): string => n?.nodeType === 3 ? n.nodeValue ?? "" : Array.from(n?.childNodes ?? []).map(textOf).join("") || n?.textContent || "";
const hidden = (n: any): boolean => { for (let current = n; current; current = current.parentNode) if (String(props(current).className ?? "").split(/\s+/).includes("hidden")) return true; return false; };
const tick = async () => { await flushMicrotasks(); await new Promise(r => setTimeout(r, 0)); await flushMicrotasks(); };
const fixtures: any[] = [];

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-context-cancel-round18-"));
  const model = provider + "-" + crypto.randomUUID();
  const control: any = { wait: true, calls: 0, aborts: 0 };
  clients.set(model, control);
  const engine = new Engine({ cwd: dir, sessionStorageDir: join(dir, "sessions"), llm: { provider, model, apiKey: "owned-placeholder" }, enabledBuiltinTools: [], headless: true, maxTurns: 1, permissionMode: "default" } as any);
  (engine as any).hooks.clear();
  const sm = engine.getSessionManager();
  const source = sm.create(dir, model, provider, "owned-source");
  source.transcript.appendMessage("user", "owned source question");
  source.transcript.appendMessage("assistant", "owned source answer");
  const to = source.transcript.appendTurnBoundary();
  source.state.status = "completed"; source.state.completedSnapshotVersion = 1;
  source.state.completedThroughEventId = to.id; sm.saveState(source.state);
  sm.create(dir, model, provider, "owned-other");
  const manager = new ChatSessionManager({ runtime: {} as any, engineFactory: () => engine });
  await manager.getOrCreate("owned-source", {} as any);
  let deliver!: (message: any) => void;
  const responses: any[] = [], created: any[] = [], forks: any[] = [];
  const server = new AgentServer({ chatManager: manager, transport: { onMessage: (callback: any) => { deliver = callback; }, close() {}, send(message: any) { responses.push(message); emitReply(message); } } as any });
  deliverLine = (line) => deliver(JSON.parse(line));
  ipcSent.length = 0;
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const timeouts: { callback: () => void; handle: any }[] = [];
  let captureForkTimer = false, stopClicks = 0;
  Object.defineProperty(window, "codeshell", { configurable: true, value: {
    getSessionRawEvents: async (id: string) => sm.resume(id).transcript.getEvents(),
    forkSession: (params: any) => {
      forks.push(params);
      if (!captureForkTimer) return preloadApi.forkSession(params);
      const original = globalThis.setTimeout;
      globalThis.setTimeout = ((callback: any, ms: number, ...args: any[]) => {
        if (ms !== 30_000) return original(callback, ms, ...args);
        const handle = original(() => {}, 60_000); handle.unref?.();
        timeouts.push({ callback, handle }); return handle;
      }) as any;
      try { return preloadApi.forkSession(params); } finally { globalThis.setTimeout = original; }
    },
  } });
  const draw = async (id: string, nonce: number, busy = false) => act(async () => {
    root.render(React.createElement(ChatView, {
      messages: [{ kind: "user", id: "display-question", text: "owned source question" }, { kind: "assistant", id: "display-answer", text: "owned source answer", done: true }],
      engineSessionId: id, liveTurnActive: false, contextSelectionRequest: nonce,
      onContextPackageCreated: (result: any, options: any) => { created.push({ result, activate: options.shouldActivate() }); },
      onSend: () => { throw Error("no owned run authorized"); },
      onStop: () => { stopClicks++; void preloadApi.cancel(id); },
      busy, activeProjectId: null, permissionMode: "default", onPermissionChange() {},
      goalEnabled: false, onGoalToggle() {}, modelOptions: [], activeModelKey: null, onModelChange() {},
      contextTokens: 0, projects: [], onSelectProject() {}, onAddProject() {},
      configurationTarget: { noRepo: true }, configurationAvailable: false,
      conversationRoot: null, conversationRootId: null,
      draft: "", onDraftChange() {}, attachments: [], onAttachmentsChange() {},
    } as any)); await tick();
  });
  const until = async (check: () => boolean) => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error("owned wait timed out: " + textOf(container)); await act(tick); } };
  const merge = () => nodes(container).find(n => props(n)["data-context-action"] === "merge");
  const exit = () => nodes(container).find(n => props(n)["aria-label"] === "退出上下文选择");
  const stop = () => nodes(container).find(n => props(n)["aria-label"] === "停止");
  const composer = () => nodes(container).find(n => n.tagName === "TEXTAREA");
  const click = async (node: any) => { expect(node).toBeDefined(); expect(Boolean(props(node).disabled)).toBe(false); expect(hidden(node)).toBe(false); await act(async () => { props(node).onClick(); await tick(); }); };
  const open = async () => { await draw("owned-source", 0); await draw("owned-source", 1); await click(nodes(container).find(n => props(n)["data-context-turn-index"] === 0)); };
  const f = { dir, model, control, engine, sm, source, manager, server, responses, created, forks, root, container, timeouts, draw, until, merge, exit, stop, composer, click, open, captureTimer: () => { captureForkTimer = true; }, stopClicks: () => stopClicks };
  fixtures.push(f); return f;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    try {
      await act(async () => { f.root.unmount(); await tick(); });
    } finally {
      f.control.release?.();
      await f.server.close(); await f.engine.dispose();
      for (const timeout of f.timeouts) clearTimeout(timeout.handle);
      if (f.control.signal && f.control.abort) f.control.signal.removeEventListener("abort", f.control.abort);
      f.container.parentNode?.removeChild(f.container);
      clients.delete(f.model); rmSync(f.dir, { recursive: true, force: true }); deliverLine = undefined;
    }
  }
  expect(network).toBe(0);
});

test("actual ChatView allows exiting selection before submission, but hides Stop and disables exit during actual Core summary; completion restores composer", async () => {
  const f = await fixture();
  await f.open(); expect(hidden(f.composer())).toBe(true); await f.click(f.exit());
  expect(f.exit()).toBeUndefined(); expect(hidden(f.composer())).toBe(false); expect(f.forks).toHaveLength(0);
  await f.draw("owned-source", 2); await f.click(nodes(f.container).find(n => props(n)["data-context-turn-index"] === 0));
  await f.click(f.merge()); await f.until(() => Boolean(f.control.release));
  expect(f.manager.get("owned-source")!.isBusy()).toBe(true);
  expect(f.control.signal instanceof AbortSignal).toBe(true); expect(f.control.signal.aborted).toBe(false);
  expect(props(f.exit()).disabled).toBe(true); expect(hidden(f.composer())).toBe(true); expect(f.stop()).toBeUndefined();
  expect(f.responses.filter((x: any) => x.method === "agent/status").map((x: any) => x.params)).toEqual([{ status: "ready" }]);
  expect(ipcSent.map(x => x.method)).toEqual(["agent/forkSession"]); expect(f.stopClicks()).toBe(0);
  // Even a hypothetical busy projection would leave Stop under the hidden composer.
  await f.draw("owned-source", 2, true); expect(f.stop()).toBeDefined(); expect(hidden(f.stop())).toBe(true);
  f.control.release(); await f.until(() => f.created.length === 1);
  expect(f.created[0].activate).toBe(true); expect(f.sm.exists(f.created[0].result.sessionId)).toBe(true);
  expect(f.manager.get("owned-source")!.isBusy()).toBe(false); expect(f.exit()).toBeUndefined();
  expect(hidden(f.composer())).toBe(false); expect(f.control.aborts).toBe(0);
});

test("service-only cancellation through actual preload aborts summary and re-enables the real selection exit; ordinary busy Stop is reachable", async () => {
  const f = await fixture(); await f.open(); await f.click(f.merge()); await f.until(() => Boolean(f.control.release));
  expect(props(f.exit()).disabled).toBe(true); expect(f.stop()).toBeUndefined();
  // Positive service control, not a Desktop cancellation button.
  await preloadApi.cancel("owned-source"); await f.until(() => textOf(f.container).includes("owned summary aborted"));
  expect(f.control.aborts).toBe(1); expect(f.manager.get("owned-source")!.isBusy()).toBe(false);
  expect(f.created).toHaveLength(0); expect(props(f.merge()).disabled).toBe(false);
  expect(props(f.exit()).disabled).toBe(false); await f.click(f.exit()); expect(hidden(f.composer())).toBe(false);
  await f.draw("owned-source", 1, true); await f.click(f.stop()); expect(f.stopClicks()).toBe(1);
  expect(ipcSent.map(x => x.method)).toEqual(["agent/forkSession", "agent/cancel", "agent/cancel"]);
});

test("actual preload 30s fork timeout restores selection controls but does not abort Core; leaving and returning exposes no Stop and late success has no created callback", async () => {
  const f = await fixture(); f.captureTimer(); await f.open(); await f.click(f.merge()); await f.until(() => Boolean(f.control.release));
  expect(f.timeouts).toHaveLength(1); expect(props(f.exit()).disabled).toBe(true);
  await act(async () => { f.timeouts[0].callback(); clearTimeout(f.timeouts[0].handle); await tick(); });
  await f.until(() => textOf(f.container).includes("timed out after 30000ms"));
  expect(f.control.signal.aborted).toBe(false); expect(f.manager.get("owned-source")!.isBusy()).toBe(true);
  expect(props(f.exit()).disabled).toBe(false); await f.click(f.exit()); expect(hidden(f.composer())).toBe(false); expect(f.stop()).toBeUndefined();
  await f.draw("owned-other", 1); await f.draw("owned-source", 1);
  expect(hidden(f.composer())).toBe(false); expect(f.stop()).toBeUndefined(); expect(f.manager.get("owned-source")!.isBusy()).toBe(true);
  expect(ipcSent.map(x => x.method)).toEqual(["agent/forkSession"]);
  f.control.release(); await f.until(() => f.responses.some((x: any) => x.result?.mode === "summary"));
  const result = f.responses.find((x: any) => x.result?.mode === "summary").result;
  expect(f.sm.exists(result.sessionId)).toBe(true); expect(f.created).toHaveLength(0);
  expect(f.control.aborts).toBe(0); expect(f.manager.get("owned-source")!.isBusy()).toBe(false);
});

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded HOME required");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
installLocalNetworkGuard("http://127.0.0.1:9");
let network = 0;
const deny = () => { network++; throw Error("round17 unexpected network"); };
net.connect = net.createConnection = deny as any; tls.connect = deny as any;
const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import(repo + "/packages/desktop/node_modules/react-dom/client");
const { ensureMiniDom, flushMicrotasks } = await import(repo + "/packages/desktop/src/renderer/test-utils/renderHook.tsx");
const { MessageStream } = await import(repo + "/packages/desktop/src/renderer/MessageStream.tsx");
const { LLMClientBase } = await import(repo + "/packages/core/src/llm/client-base.ts");
const { registerProvider } = await import(repo + "/packages/core/src/llm/client-factory.ts");
const { Engine } = await import(repo + "/packages/core/src/engine/engine.ts");
const { ChatSessionManager } = await import(repo + "/packages/core/src/protocol/chat-session-manager.ts");
const { AgentServer } = await import(repo + "/packages/core/src/protocol/server.ts");
const { Methods } = await import(repo + "/packages/core/src/protocol/types.ts");
const provider = "owned-review-context-round17";
const clients = new Map<string, any>();
class OwnedClient extends LLMClientBase {
  protected initClient() {}
  async createMessage(options: any) {
    const control = clients.get(this.model);
    if (!control) throw Error("unknown owned fixture model");
    control.calls++;
    control.prompts.push(options.messages);
    if (control.mode === "fail") throw Error("owned summary unavailable");
    if (control.mode === "wait") {
      await new Promise<void>((resolve, reject) => {
        control.release = resolve;
        const abort = () => { control.aborts++; reject(new Error("owned summary aborted")); };
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    const usage = { promptTokens: 5, completionTokens: 2, totalTokens: 7 };
    this.recordUsage(usage, options);
    return { text: "owned portable summary", toolCalls: [], stopReason: "stop", usage };
  }
}
registerProvider(provider, OwnedClient);
ensureMiniDom();
const nodes = (n: any): any[] => [n, ...Array.from(n?.childNodes ?? []).flatMap(nodes)];
const props = (n: any): any => { const key = Object.keys(n ?? {}).find(x => x.startsWith("__reactProps$")); return key ? n[key] : {}; };
const textOf = (n: any): string => n?.nodeType === 3 ? n.nodeValue ?? "" : Array.from(n?.childNodes ?? []).map(textOf).join("") || n?.textContent || "";
const tick = async () => { await flushMicrotasks(); await new Promise(r => setTimeout(r, 0)); await flushMicrotasks(); };
const fixtures: any[] = [];
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-context-round17-"));
  const model = provider + "-" + crypto.randomUUID();
  const control: any = { mode: "ok", calls: 0, aborts: 0, prompts: [] };
  clients.set(model, control);
  const engine = new Engine({ cwd: dir, sessionStorageDir: join(dir, "sessions"),
    llm: { provider, model, apiKey: "owned-placeholder" }, enabledBuiltinTools: [],
    headless: true, maxTurns: 1, permissionMode: "default" } as any);
  (engine as any).hooks.clear();
  const sm = engine.getSessionManager();
  const source = sm.create(dir, model, provider, "owned-source");
  const from = source.transcript.appendMessage("user", "owned selected question");
  source.transcript.appendMessage("assistant", "owned selected answer");
  const to = source.transcript.appendTurnBoundary();
  source.state.status = "completed"; source.state.completedSnapshotVersion = 1;
  source.state.completedThroughEventId = to.id; sm.saveState(source.state);
  const manager = new ChatSessionManager({ runtime: {} as any, engineFactory: () => engine });
  await manager.getOrCreate("owned-source", {} as any);
  let deliver!: (message: any) => void, next = 1;
  const pending = new Map<number, any>(), responses: any[] = [];
  const server = new AgentServer({ chatManager: manager, transport: {
    onMessage: (callback: any) => { deliver = callback; }, close() {},
    send: (message: any) => { responses.push(message); const entry = pending.get(message.id); if (entry) { pending.delete(message.id); entry(message); } },
  } as any });
  const request = (method: string, params: any) => new Promise<any>(resolve => {
    const id = next++; pending.set(id, resolve); deliver({ jsonrpc: "2.0", id, method, params });
  });
  const range = { sourceSessionId: "owned-source", mode: "summary", fromEventId: from.id, toEventId: to.id };
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container); const created: any[] = [], forks: any[] = [];
  Object.defineProperty(window, "codeshell", { configurable: true, value: {
    getSessionRawEvents: async () => source.transcript.getEvents(),
    forkSession: async (params: any) => { forks.push(params); const reply = await request(Methods.ForkSession, params); if (reply.error) throw Error(reply.error.message); return reply.result; },
  } });
  const draw = async (id: string, nonce: number) => act(async () => {
    root.render(<MessageStream messages={[{ kind: "user", id: "owned-display", text: "owned selected question" }, { kind: "assistant", id: "owned-answer", text: "owned selected answer", done: true }]}
      engineSessionId={id} liveTurnActive={false} contextSelectionRequest={nonce}
      onContextPackageCreated={(result: any, options: any) => { created.push({ result, activate: options.shouldActivate() }); }} />);
    await tick();
  });
  const until = async (check: () => boolean) => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error("owned wait timed out: " + textOf(container)); await act(tick); } };
  const merge = () => nodes(container).find(n => props(n)["data-context-action"] === "merge");
  const choose = async () => { const button = nodes(container).find(n => props(n)["data-context-turn-index"] === 0); expect(button).toBeDefined(); await act(async () => { props(button).onClick(); await tick(); }); };
  const clickMerge = async () => { expect(props(merge()).disabled).toBe(false); await act(async () => { props(merge()).onClick(); await tick(); }); };
  const f = { dir, model, control, engine, sm, source, manager, server, request, range, from, to, root, container, created, forks, draw, until, merge, choose, clickMerge };
  fixtures.push(f); return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await act(async () => { f.root.unmount(); await tick(); });
    f.control.release?.(); await f.server.close(); await f.engine.dispose();
    f.container.parentNode?.removeChild(f.container); clients.delete(f.model);
    rmSync(f.dir, { recursive: true, force: true });
  }
  expect(network).toBe(0);
});
test("actual context UI and actual Core summary failure preserve selection for retry; successful target contains only transfer summary", async () => {
  const f = await fixture(); f.control.mode = "fail";
  await f.draw("owned-source", 0); await f.draw("owned-source", 1); await f.choose(); await f.clickMerge();
  await f.until(() => textOf(f.container).includes("owned summary unavailable"));
  expect(f.control.calls).toBe(1); expect(f.created).toHaveLength(0); expect(f.forks).toHaveLength(1);
  expect(readdirSync(join(f.dir, "sessions")).filter(x => !x.startsWith("."))).toEqual(["owned-source"]);
  expect(props(f.merge()).disabled).toBe(false);
  f.control.mode = "ok"; await f.clickMerge(); await f.until(() => f.created.length === 1);
  expect(f.control.calls).toBe(2); expect(f.forks[1]).toEqual(f.forks[0]); expect(f.created[0].activate).toBe(true);
  const target = f.sm.resume(f.created[0].result.sessionId);
  const events = target.transcript.getEvents();
  expect(events.map((e: any) => e.type)).toEqual(["session_meta", "context_transfer"]);
  expect(events[1].data.summary).toBe("owned portable summary");
  expect(events[1].data.sourceRange).toEqual({ sessionId: "owned-source", fromEventId: f.from.id, toEventId: f.to.id });
  expect(f.source.transcript.getEvents().filter((e: any) => e.type === "message")).toHaveLength(2);
});
test("actual Core rejects invalid source range or existing target before any owned summarizer call", async () => {
  const f = await fixture();
  const invalid = await f.request(Methods.ForkSession, { ...f.range, fromEventId: "unknown-owned-event", targetSessionId: "owned-invalid-target" });
  expect(invalid.error).toBeDefined(); expect(f.control.calls).toBe(0); expect(f.sm.exists("owned-invalid-target")).toBe(false);
  const existing = await f.request(Methods.ForkSession, { ...f.range, targetSessionId: "owned-source" });
  expect(existing.error.message).toContain("already exists"); expect(f.control.calls).toBe(0);
  expect(f.source.transcript.getEvents().filter((e: any) => e.type === "message")).toHaveLength(2);
});
test("actual Core cancel aborts exclusive summary without publishing and permits a subsequent retry", async () => {
  const f = await fixture(); f.control.mode = "wait";
  const pending = f.request(Methods.ForkSession, { ...f.range, targetSessionId: "owned-cancel-target" });
  await f.until(() => f.control.calls === 1 && Boolean(f.control.release));
  expect(f.manager.get("owned-source")?.isBusy()).toBe(true);
  const cancelled = await f.request(Methods.Cancel, { sessionId: "owned-source" });
  expect(cancelled.error).toBeUndefined();
  const result = await pending; expect(result.error.message).toContain("aborted");
  expect(f.control.aborts).toBe(1); expect(f.sm.exists("owned-cancel-target")).toBe(false);
  expect(f.manager.get("owned-source")?.isBusy()).toBe(false);
  f.control.mode = "ok";
  const retry = await f.request(Methods.ForkSession, { ...f.range, targetSessionId: "owned-retry-target" });
  expect(retry.error).toBeUndefined(); expect(f.sm.exists("owned-retry-target")).toBe(true); expect(f.control.calls).toBe(2);
});
test("actual context UI delivers a delayed real Core target callback without activating after switching the source session", async () => {
  const f = await fixture(); f.control.mode = "wait";
  f.sm.create(f.dir, f.model, provider, "owned-next-source");
  await f.draw("owned-source", 0); await f.draw("owned-source", 1); await f.choose(); await f.clickMerge();
  await f.until(() => Boolean(f.control.release)); expect(f.created).toHaveLength(0);
  await f.draw("owned-next-source", 1); f.control.release();
  await f.until(() => f.created.length === 1);
  expect(f.created[0].activate).toBe(false); expect(f.sm.exists(f.created[0].result.sessionId)).toBe(true);
  expect(nodes(f.container).filter(n => props(n)["data-context-turn-index"] !== undefined)).toHaveLength(0);
});

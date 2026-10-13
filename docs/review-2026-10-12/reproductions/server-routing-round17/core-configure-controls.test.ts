import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded HOME required");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard("http://127.0.0.1:9");
const deny = () => { throw Error("NETWORK_FORBIDDEN_round17"); };
net.connect = net.createConnection = deny as any; tls.connect = deny as any;
const { AgentServer } = await import(`${repo}/packages/core/src/protocol/server.ts`);
const { ChatSessionManager } = await import(`${repo}/packages/core/src/protocol/chat-session-manager.ts`);
const { SettingsManager } = await import(`${repo}/packages/core/dist/index.js`);

test("actual Core idle async question survives the exact global configure RPC without replay, and explicit cancel retires it before a fresh question", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codeshell-core-configure-round17-"));
  let ask: (question: string) => Promise<unknown>;
  let runs = 0, reloads = 0, refreshes = 0;
  const engine: any = {
    setAskUser() {}, setAskUserAsync(fn: any) { ask = fn; }, setPlanMode() {}, setBrowserBridge() {}, setInjectCredential() {}, setSessionMessageRouter() {},
    isHeadless: () => false, getGoal: () => undefined,
    resolveSessionRunWorkspace: () => ({ cwd }),
    getEffectiveDisabledLists: () => ({ disabledPlugins: [], disabledSkills: [], disabledMcpServers: [], disabledTools: [] }),
    refreshRuntimeConfig() { refreshes++; },
    async run(_task: string, options: any) {
      runs++;
      options.onStream?.({ type: "session_started", sessionId: "owned-core-session", promptTokens: 0, runId: "owned-core-run-" + runs, clientMessageId: options.clientMessageId });
      await ask("owned idle async question " + runs);
      options.onStream?.({ type: "turn_complete", reason: "completed" });
      return { text: "continued without answer", reason: "completed", sessionId: "owned-core-session", turnCount: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
  };
  const manager = new ChatSessionManager({ runtime: { reloadModelsFromSettings() { reloads++; } } as any, idleTtlMs: 60_000, engineFactory: () => engine });
  const sent: any[] = [];
  let onMessage: any;
  const server = new AgentServer({ chatManager: manager, settingsReader: () => new SettingsManager(cwd, "full").get(), transport: { send: (value: any) => sent.push(value), onMessage: (callback: any) => onMessage = callback, close() {} } as any });
  let sequence = 0;
  const request = (method: string, params: any) => { const id = ++sequence; onMessage({ jsonrpc: "2.0", id, method, params }); return id; };
  const until = async (check: () => boolean) => { const end = performance.now() + 2000; while (!check()) { if (performance.now() > end) throw Error("Core control timeout: " + JSON.stringify(sent)); await new Promise(r => setTimeout(r, 2)); } };
  try {
    const run = request("agent/run", { sessionId: "owned-core-session", cwd, task: "owned fake-engine asking run" });
    await until(() => sent.some(m => m.id === run && m.result));
    const questions = () => sent.filter(m => m.method === "agent/approvalRequest");
    expect(questions()).toHaveLength(1);
    const question = questions()[0];
    expect(question.params.request.toolName).toBe("__ask_user__");
    expect(question.params.request.args.asynchronous).toBe(true);
    expect(manager.get("owned-core-session")!.isBusy()).toBe(false);
    expect(manager.get("owned-core-session")!.pendingApprovals.has(question.params.requestId)).toBe(true);
    const sentBefore = sent.length;
    const configure = request("agent/configure", { reloadModels: true, reloadSettings: true });
    await until(() => sent.some(m => m.id === configure));
    expect(sent.find(m => m.id === configure).result).toEqual({ ok: true });
    expect(reloads).toBe(1);
    expect(refreshes).toBe(1);
    expect(manager.get("owned-core-session")!.pendingApprovals.has(question.params.requestId)).toBe(true);
    expect(sent.slice(sentBefore).filter(m => m.method === "agent/approvalRequest" || m.method === "serve/approvalSnapshot" || m.method === "agent/approvalResolved")).toEqual([]);
    const cancel = request("agent/cancel", { sessionId: "owned-core-session" });
    await until(() => sent.some(m => m.id === cancel));
    expect(manager.get("owned-core-session")!.pendingApprovals.size).toBe(0);
    expect(sent.some(m => m.method === "agent/approvalResolved" && m.params.requestId === question.params.requestId)).toBe(true);
    const next = request("agent/run", { sessionId: "owned-core-session", cwd, task: "owned fresh asking run" });
    await until(() => sent.some(m => m.id === next && m.result));
    expect(questions()).toHaveLength(2);
    expect(questions()[1].params.requestId).not.toBe(question.params.requestId);
    expect(manager.get("owned-core-session")!.pendingApprovals.has(questions()[1].params.requestId)).toBe(true);
    console.log(JSON.stringify({ actualCoreAgentServerAndChatSessionManager: true, fakeEngineNoModel: true, exactGlobalConfigurePreservesPendingWithoutReplay: true, explicitCancelRetiresAndFreshRunAsksAgain: true }));
  } finally { await server.close(); rmSync(cwd, { recursive: true, force: true }); }
}, 10000);

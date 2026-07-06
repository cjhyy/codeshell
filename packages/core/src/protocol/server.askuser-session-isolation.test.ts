import { describe, expect, it } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { ErrorCodes, Methods } from "./types.js";
import type { Engine, EngineResult } from "../engine/engine.js";

function makeTransport() {
  const sent: any[] = [];
  let onMsg: (msg: unknown) => void = () => {};
  return {
    sent,
    deliver: (msg: unknown) => onMsg(msg),
    transport: {
      send: (m: unknown) => sent.push(m),
      onMessage: (cb: (msg: unknown) => void) => {
        onMsg = cb;
      },
      close: () => {},
    } as any,
  };
}

function result(text: string, sessionId: string): EngineResult {
  return {
    text,
    reason: "completed",
    sessionId,
    turnCount: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

async function waitFor(assertion: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function makeAskingEngine(sessionId: string) {
  const state = {
    askUser: undefined as ((q: string) => Promise<string>) | undefined,
    answer: undefined as string | undefined,
  };
  const engine = {
    setAskUser(fn: (q: string) => Promise<string>) {
      state.askUser = fn;
    },
    setPlanMode() {},
    setBrowserBridge() {},
    setInjectCredential() {},
    isHeadless: () => false,
    async run(): Promise<EngineResult> {
      state.answer = await state.askUser!(`question for ${sessionId}`);
      return result(state.answer, sessionId);
    },
  } as unknown as Engine;
  return { engine, state };
}

function askRequests(sent: any[]) {
  return sent.filter(
    (m) => m.method === Methods.ApprovalRequest && m.params?.request?.toolName === "__ask_user__",
  );
}

describe("AgentServer AskUserQuestion session isolation", () => {
  it("resolves an askUser answer only for the matching sessionId and requestId", async () => {
    const sessionA = makeAskingEngine("sess-a");
    const sessionB = makeAskingEngine("sess-b");
    const engines = [sessionA.engine, sessionB.engine];
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        const engine = engines.shift();
        if (!engine) throw new Error("unexpected session creation");
        return engine;
      },
    });
    const t = makeTransport();
    const server = new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.Run,
      params: { sessionId: "sess-a", task: "ask A" },
    });
    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.Run,
      params: { sessionId: "sess-b", task: "ask B" },
    });

    await waitFor(
      () => askRequests(t.sent).length === 2,
      "both askUser requests should be pending",
    );

    const reqA = askRequests(t.sent).find((m) => m.params?.sessionId === "sess-a")!;
    const reqB = askRequests(t.sent).find((m) => m.params?.sessionId === "sess-b")!;
    expect(reqA).toBeDefined();
    expect(reqB).toBeDefined();
    expect(chatManager.get("sess-a")!.pendingApprovals.size).toBe(1);
    expect(chatManager.get("sess-b")!.pendingApprovals.size).toBe(1);
    expect((server as any).pendingApprovals.size).toBe(0);

    t.deliver({
      jsonrpc: "2.0",
      id: 3,
      method: Methods.Approve,
      params: {
        sessionId: "sess-b",
        requestId: reqA.params.requestId,
        decision: { approved: true, answer: "answer meant for B" },
      },
    });

    await waitFor(
      () => t.sent.some((m) => m.id === 3 && m.error?.code === ErrorCodes.InvalidParams),
      "mismatched session/request approval should be rejected",
    );
    expect(sessionA.state.answer).toBeUndefined();
    expect(sessionB.state.answer).toBeUndefined();
    expect(chatManager.get("sess-a")!.pendingApprovals.size).toBe(1);
    expect(chatManager.get("sess-b")!.pendingApprovals.size).toBe(1);

    t.deliver({
      jsonrpc: "2.0",
      id: 4,
      method: Methods.Approve,
      params: {
        sessionId: "sess-b",
        requestId: reqB.params.requestId,
        decision: { approved: true, answer: "B answer" },
      },
    });

    await waitFor(() => sessionB.state.answer === "B answer", "session B should resolve");
    expect(sessionA.state.answer).toBeUndefined();
    expect(chatManager.get("sess-a")!.pendingApprovals.size).toBe(1);
    expect(chatManager.get("sess-b")!.pendingApprovals.size).toBe(0);

    t.deliver({
      jsonrpc: "2.0",
      id: 5,
      method: Methods.Approve,
      params: {
        sessionId: "sess-a",
        requestId: reqA.params.requestId,
        decision: { approved: true, answer: "A answer" },
      },
    });

    await waitFor(() => sessionA.state.answer === "A answer", "session A should resolve");
    expect(chatManager.get("sess-a")!.pendingApprovals.size).toBe(0);

    server.close();
  });
});

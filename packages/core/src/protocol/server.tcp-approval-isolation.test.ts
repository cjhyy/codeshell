import { afterEach, describe, expect, it } from "bun:test";
import { connect, type Socket } from "node:net";
import type { Engine, EngineResult } from "../engine/engine.js";
import { getInteractiveApprovalBackend, getApprovalRouter } from "../tool-system/permission.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";
import { listenTcp, type TcpListenResult } from "./tcp-transport.js";
import { Methods } from "./types.js";

interface WireClient {
  socket: Socket;
  messages: any[];
  send(message: unknown): void;
}

async function waitFor(assertion: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function openClient(port: number): Promise<WireClient> {
  const socket = connect({ port, host: "127.0.0.1" });
  const messages: any[] = [];
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
  });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  return {
    socket,
    messages,
    send(message) {
      socket.write(`${JSON.stringify(message)}\n`);
    },
  };
}

function approvalRequests(client: WireClient) {
  return client.messages.filter((message) => message.method === Methods.ApprovalRequest);
}

function makeApprovalEngine(decisions: Array<{ sessionId: string; approved: boolean }>) {
  return {
    setAskUser() {},
    setPlanMode() {},
    setBrowserBridge() {},
    setInjectCredential() {},
    isHeadless: () => false,
    async run(_task: string, opts: { sessionId?: string }): Promise<EngineResult> {
      const sessionId = opts.sessionId!;
      const decision = await getInteractiveApprovalBackend().requestApproval({
        sessionId,
        toolName: "Bash",
        args: { command: "rm protected.txt" },
        description: `approval for ${sessionId}`,
        riskLevel: "high",
      });
      decisions.push({ sessionId, approved: decision.approved });
      return {
        text: decision.approved ? "approved" : "denied",
        reason: "completed",
        sessionId,
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
}

describe("TCP approval routing is connection-owned", () => {
  let listener: TcpListenResult | undefined;
  const clients: WireClient[] = [];
  const servers = new Set<AgentServer>();

  afterEach(async () => {
    for (const client of clients.splice(0)) client.socket.destroy();
    for (const server of servers) server.disconnect();
    servers.clear();
    if (listener) await listener.close();
    listener = undefined;
  });

  async function setup() {
    const decisions: Array<{ sessionId: string; approved: boolean }> = [];
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => makeApprovalEngine(decisions),
    });
    let accepted = 0;
    listener = await listenTcp({ port: 0, host: "127.0.0.1" }, (transport, socket) => {
      const connectionId = `tcp-connection-${++accepted}`;
      const server = new AgentServer({
        chatManager: manager,
        transport,
        connectionId,
        approvalRouter: getApprovalRouter(),
      });
      servers.add(server);
      socket.once("close", () => {
        server.disconnect();
        servers.delete(server);
      });
    });
    const a = await openClient(listener.port);
    const b = await openClient(listener.port);
    clients.push(a, b);
    return { a, b, decisions };
  }

  it("does not expose A's approval to B and accepts A's matching four-tuple", async () => {
    const { a, b, decisions } = await setup();
    a.send({
      jsonrpc: "2.0",
      id: "run-a",
      method: Methods.Run,
      params: { sessionId: "tcp-approval-a", task: "needs approval" },
    });

    await waitFor(() => approvalRequests(a).length === 1, "A should receive its approval");
    expect(approvalRequests(b)).toHaveLength(0);
    const notice = approvalRequests(a)[0]!.params;
    expect(notice).toMatchObject({
      connectionId: "tcp-connection-1",
      sessionId: "tcp-approval-a",
    });
    expect(typeof notice.generation).toBe("number");

    b.send({
      jsonrpc: "2.0",
      id: "cross-approve",
      method: Methods.Approve,
      params: { ...notice, decision: { approved: true } },
    });
    await waitFor(
      () => b.messages.some((message) => message.id === "cross-approve" && message.error),
      "B's forged response should be rejected",
    );
    expect(decisions).toEqual([]);

    a.send({
      jsonrpc: "2.0",
      id: "stale-generation",
      method: Methods.Approve,
      params: {
        connectionId: notice.connectionId,
        sessionId: notice.sessionId,
        generation: notice.generation + 1,
        requestId: notice.requestId,
        decision: { approved: true },
      },
    });
    await waitFor(
      () => a.messages.some((message) => message.id === "stale-generation" && message.error),
      "a stale generation should be rejected",
    );
    expect(decisions).toEqual([]);

    a.send({
      jsonrpc: "2.0",
      id: "approve-a",
      method: Methods.Approve,
      params: {
        connectionId: notice.connectionId,
        sessionId: notice.sessionId,
        generation: notice.generation,
        requestId: notice.requestId,
        decision: { approved: true },
      },
    });
    await waitFor(() => decisions.length === 1, "matching approval should resolve");
    expect(decisions).toEqual([{ sessionId: "tcp-approval-a", approved: true }]);
  });

  it("fails a pending approval closed when its owning TCP connection disconnects", async () => {
    const { a, b, decisions } = await setup();
    a.send({
      jsonrpc: "2.0",
      id: "run-disconnect",
      method: Methods.Run,
      params: { sessionId: "tcp-approval-disconnect", task: "needs approval" },
    });
    await waitFor(() => approvalRequests(a).length === 1, "approval should be pending on A");
    expect(approvalRequests(b)).toHaveLength(0);

    a.socket.destroy();

    await waitFor(() => decisions.length === 1, "disconnect should reject the pending approval");
    expect(decisions).toEqual([{ sessionId: "tcp-approval-disconnect", approved: false }]);

    const late = await getInteractiveApprovalBackend().requestApproval({
      sessionId: "tcp-approval-disconnect",
      toolName: "Bash",
      args: { command: "rm after-disconnect.txt" },
      description: "late approval after owner disconnect",
      riskLevel: "high",
    });
    expect(late.approved).toBe(false);
    expect(approvalRequests(b)).toHaveLength(0);
  });
});

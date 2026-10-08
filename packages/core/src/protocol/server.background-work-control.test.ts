import { afterEach, expect, test } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { createInProcessTransport } from "./transport.js";
import { Methods, type RpcResponse } from "./types.js";
import { backgroundJobRegistry } from "../tool-system/builtin/background-jobs.js";

const servers: AgentServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  backgroundJobRegistry.reset();
});

function rpc(params: Record<string, unknown>): Promise<RpcResponse> {
  const [client, serverTransport] = createInProcessTransport();
  const chatManager = new ChatSessionManager({
    runtime: {} as never,
    engineFactory: () => {
      throw new Error("A registry query must never start an Engine");
    },
  });
  servers.push(new AgentServer({ transport: serverTransport, chatManager }));
  return new Promise((resolve) => {
    client.onMessage((message) => {
      if ("id" in message && message.id === "cancel-background") resolve(message as RpcResponse);
    });
    client.send({
      jsonrpc: "2.0",
      id: "cancel-background",
      method: Methods.BackgroundWorkCancel,
      params,
    });
  });
}

test("background cancellation RPC rejects missing attempt fence and invalid kind", async () => {
  let aborts = 0;
  backgroundJobRegistry.start("job-a", "parent-a", "Work", {
    abort: () => {
      aborts++;
    },
  });
  expect((await rpc({ sessionId: "parent-a", kind: "job", workId: "job-a" })).error?.code).toBe(
    -32602,
  );
  expect(
    (await rpc({ sessionId: "parent-a", kind: "unknown", workId: "job-a", expectedStartedAt: 1 }))
      .error?.code,
  ).toBe(-32602);
  expect(aborts).toBe(0);
});

test("background cancellation RPC checks authoritative owner and executes real abort", async () => {
  let aborts = 0;
  backgroundJobRegistry.start("job-a", "parent-a", "Work", {
    abort: () => {
      aborts++;
    },
  });
  const expectedStartedAt = backgroundJobRegistry.get("job-a")!.startedAt;
  expect(
    (await rpc({ sessionId: "other-parent", kind: "job", workId: "job-a", expectedStartedAt }))
      .result,
  ).toEqual({ cancelled: false });
  expect(aborts).toBe(0);
  expect(
    (await rpc({ sessionId: "parent-a", kind: "job", workId: "job-a", expectedStartedAt })).result,
  ).toEqual({ cancelled: true });
  expect(aborts).toBe(1);
});

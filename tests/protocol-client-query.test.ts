import { describe, expect, test } from "bun:test";
import { AgentServer } from "../packages/core/src/protocol/server.js";
import { AgentClient } from "../packages/core/src/protocol/client.js";
import type { Engine } from "../packages/core/src/engine/engine.js";
import type { Transport } from "../packages/core/src/protocol/transport.js";
import type { RpcMessage, RpcRequest, RpcResponse } from "../packages/core/src/protocol/types.js";

/**
 * Capture-only fake transport: records every outgoing request so we can
 * assert on the wire shape. Never delivers a response back, so awaited
 * queries stay pending — the test inspects `sent` after kicking off the
 * call instead of awaiting it.
 */
function captureTransport(): { transport: Transport; sent: RpcRequest[] } {
  const sent: RpcRequest[] = [];
  const transport: Transport = {
    send(msg: RpcMessage) {
      if ("method" in msg && "id" in msg) sent.push(msg as RpcRequest);
    },
    onMessage() {},
    close() {},
  };
  return { transport, sent };
}

describe("AgentClient.query param mapping", () => {
  test("permission_set sends mode as `params.value` (server reads value, not key)", () => {
    // Regression: the client briefly shared a branch with config_get and
    // wrote the mode to `params.key`, which the server rejected as
    // `invalid permission mode: undefined`. The mode must land on `value`.
    const { transport, sent } = captureTransport();
    const client = new AgentClient({ transport });
    void client.query("permission_set", "acceptEdits");
    expect(sent).toHaveLength(1);
    expect(sent[0].params).toEqual({ type: "permission_set", value: "acceptEdits" });
    expect((sent[0].params as Record<string, unknown>).key).toBeUndefined();
  });

  test("config_get still sends key on `params.key`", () => {
    const { transport, sent } = captureTransport();
    const client = new AgentClient({ transport });
    void client.query("config_get", "model");
    expect(sent[0].params).toEqual({ type: "config_get", key: "model" });
  });

  test("config_set sends both key and value", () => {
    const { transport, sent } = captureTransport();
    const client = new AgentClient({ transport });
    void client.query("config_set", "model", "claude-opus-4-7");
    expect(sent[0].params).toEqual({
      type: "config_set",
      key: "model",
      value: "claude-opus-4-7",
    });
  });
});

describe("agent/run cwd mapping", () => {
  test("AgentClient.run sends cwd on params", () => {
    const { transport, sent } = captureTransport();
    const client = new AgentClient({ transport });
    void client.run("hello", { cwd: "/tmp/workspace", sessionId: "sid-1" });
    expect(sent).toHaveLength(1);
    expect(sent[0].params).toEqual({
      task: "hello",
      cwd: "/tmp/workspace",
      sessionId: "sid-1",
    });
  });

  test("AgentServer passes params.cwd into engine.run options", async () => {
    let onMessage: ((msg: RpcMessage) => void) | undefined;
    let resolveResponse: ((msg: RpcResponse) => void) | undefined;
    const response = new Promise<RpcResponse>((resolve) => {
      resolveResponse = resolve;
    });
    const sent: RpcMessage[] = [];
    const transport: Transport = {
      send(msg: RpcMessage) {
        sent.push(msg);
        if ("id" in msg && !("method" in msg) && msg.id === 1) {
          resolveResponse?.(msg as RpcResponse);
        }
      },
      onMessage(cb) {
        onMessage = cb;
      },
      close() {},
    };

    const calls: Array<{ task: string; options?: { cwd?: string } }> = [];
    const engine = {
      setAskUser() {},
      setPermissionMode() {},
      async run(task: string, options?: { cwd?: string }) {
        calls.push({ task, options });
        return {
          text: "ok",
          reason: "completed",
          sessionId: "sid-1",
          turnCount: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    } as unknown as Engine;

    new AgentServer({ engine, transport });
    onMessage?.({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/run",
      params: { task: "hello", cwd: "/tmp/workspace" },
    });

    await response;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      task: "hello",
      options: { cwd: "/tmp/workspace" },
    });
  });
});

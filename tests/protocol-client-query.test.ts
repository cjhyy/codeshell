import { describe, expect, test } from "bun:test";
import { AgentClient } from "../src/protocol/client.js";
import type { Transport } from "../src/protocol/transport.js";
import type { RpcMessage, RpcRequest } from "../src/protocol/types.js";

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

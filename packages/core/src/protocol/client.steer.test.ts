import { describe, it, expect } from "bun:test";
import { AgentClient } from "./client.js";
import { createInProcessTransport } from "./transport.js";
import { isRequest, createResponse, Methods, type RpcRequest } from "./types.js";

/**
 * Regression: the steer refactor (commit 3d48a9e8) added server handleSteer /
 * handleUnsteer + the desktop preload steer()/unsteer(), but skipped the core
 * AgentClient — leaving the SDK unable to reach the methods (request() is
 * private), an asymmetric protocol. These assert the client now sends the right
 * RPC method + params and decodes the reply.
 */
describe("AgentClient.steer / unsteer", () => {
  function setup() {
    const [clientSide, serverSide] = createInProcessTransport();
    const seen: RpcRequest[] = [];
    // Minimal fake server: echo back the expected response shape per method.
    serverSide.onMessage((m) => {
      if (!isRequest(m)) return;
      seen.push(m);
      if (m.method === Methods.Steer) {
        serverSide.send(createResponse(m.id, { ok: true, accepted: true, id: "draft-1" }));
      } else if (m.method === Methods.Unsteer) {
        const id = (m.params as { id?: string }).id;
        serverSide.send(createResponse(m.id, { ok: true, removed: id === "live" }));
      }
    });
    const client = new AgentClient({ transport: clientSide });
    return { client, seen };
  }

  it("steer() sends agent/steer with sessionId+text+id", async () => {
    const { client, seen } = setup();
    const result = await client.steer("s1", "hello", "draft-1", "client-1");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe(Methods.Steer);
    expect(seen[0]!.params).toEqual({
      sessionId: "s1",
      text: "hello",
      id: "draft-1",
      clientMessageId: "client-1",
    });
    expect(result).toEqual({ accepted: true, id: "draft-1" });
  });

  it("unsteer() returns true when the entry was still pending (removed)", async () => {
    const { client } = setup();
    expect(await client.unsteer("s1", "live")).toBe(true);
  });

  it("unsteer() returns false when the loop already consumed the entry", async () => {
    const { client } = setup();
    expect(await client.unsteer("s1", "consumed")).toBe(false);
  });
});

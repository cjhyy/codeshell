import { describe, expect, it } from "bun:test";

import type { Transport } from "./transport.js";
import { AgentClient } from "./client.js";
import { Methods, type RpcMessage } from "./types.js";

describe("AgentClient run response boundary", () => {
  it("fires synchronously before a following stream notification and Promise continuation", async () => {
    const sent: RpcMessage[] = [];
    let deliver!: (message: RpcMessage) => void;
    const transport: Transport = {
      send(message) {
        sent.push(message);
      },
      onMessage(handler) {
        deliver = handler;
      },
      close() {},
    };
    const client = new AgentClient({ transport });
    const order: string[] = [];
    client.onStreamEvent(() => order.push("stream"));

    const run = client
      .run("work", "session-run-response", () => order.push("response"))
      .then(() => {
        order.push("promise");
      });
    const request = sent[0] as { id: string | number };

    deliver({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        text: "done",
        reason: "completed",
        sessionId: "session-run-response",
        turnCount: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    });
    deliver({
      jsonrpc: "2.0",
      method: Methods.StreamEvent,
      params: {
        sessionId: "session-run-response",
        event: {
          type: "session_started",
          sessionId: "session-run-response",
          promptTokens: 0,
        },
      },
    });

    expect(order).toEqual(["response", "stream"]);
    await run;
    expect(order).toEqual(["response", "stream", "promise"]);
  });
});

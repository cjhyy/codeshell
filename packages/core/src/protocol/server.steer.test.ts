import { describe, expect, it } from "bun:test";
import type { Engine } from "../engine/engine.js";
import { AgentServer } from "./server.js";

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

describe("AgentServer steer", () => {
  it("returns the engine accepted flag and id", () => {
    const calls: unknown[] = [];
    const engine = {
      isHeadless: () => true,
      enqueueSteer(
        sessionId: string,
        text: string,
        id?: string,
        clientMessageId?: string,
      ) {
        calls.push({ sessionId, text, id, clientMessageId });
        return { accepted: false, id: id ?? "generated" };
      },
    } as unknown as Engine;
    const t = makeTransport();
    new AgentServer({ transport: t.transport, engine });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/steer",
      params: {
        sessionId: "s1",
        text: "hello",
        id: "steer-1",
        clientMessageId: "client-1",
      },
    });

    expect(calls).toEqual([
      { sessionId: "s1", text: "hello", id: "steer-1", clientMessageId: "client-1" },
    ]);
    expect(t.sent.at(-1)?.result).toEqual({ ok: true, accepted: false, id: "steer-1" });
  });
});

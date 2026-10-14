import { describe, expect, it } from "bun:test";
import { CONTRACTS } from "../contracts.js";
import { ChatSessionManager } from "./chat-session-manager.js";
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

async function reply(sent: any[], id: number) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const found = sent.find((message) => message.id === id);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no reply for ${id}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

describe("initialize", () => {
  it("returns the protocol version and the contract table without touching sessions", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        throw new Error("initialize must not create an engine");
      },
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });
    t.deliver({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const response = await reply(t.sent, 1);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ protocolVersion: "1", contracts: CONTRACTS });
  });

  it("ignores client params: no version negotiation until S1", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        throw new Error("initialize must not create an engine");
      },
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });
    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersions: ["2.0"] },
    });
    const response = await reply(t.sent, 2);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ protocolVersion: "1", contracts: CONTRACTS });
  });
});

import { describe, it, expect } from "bun:test";
import { createInProcessTransport } from "./transport.js";
import type { RpcMessage } from "./types.js";

const msg = (id: number): RpcMessage =>
  ({ jsonrpc: "2.0", id, method: "ping", params: {} }) as unknown as RpcMessage;

// Regression: close() used to clear listeners on BOTH emitters, so whichever
// side closed first broke the other side's ability to receive messages.
describe("createInProcessTransport — close isolation", () => {
  it("closing sideA does not stop sideB from receiving", () => {
    const [a, b] = createInProcessTransport();
    const received: RpcMessage[] = [];
    b.onMessage((m) => received.push(m));

    a.close();
    // a→b should still deliver: only a's own incoming channel was torn down.
    a.send(msg(1));
    expect(received.length).toBe(1);
  });

  it("closing sideB does not stop sideA from receiving", () => {
    const [a, b] = createInProcessTransport();
    const received: RpcMessage[] = [];
    a.onMessage((m) => received.push(m));

    b.close();
    b.send(msg(2));
    expect(received.length).toBe(1);
  });

  it("a closed side stops receiving its own messages", () => {
    const [a, b] = createInProcessTransport();
    const received: RpcMessage[] = [];
    a.onMessage((m) => received.push(m));

    a.close();
    b.send(msg(3)); // would arrive on a, but a is closed
    expect(received.length).toBe(0);
  });
});

import { describe, it, expect } from "bun:test";
import { IpcTransport } from "../../src/protocol/transport.js";
import type { RpcMessage } from "../../src/protocol/types.js";

/**
 * Build a paired pretend-IPC bridge: anything one transport sends out
 * shows up on the other side's subscribed handlers. Mirrors how the
 * Electron host will wire ipcMain.send/on against ipcRenderer.send/on
 * but stays in-process so the test runs without spinning up Electron.
 */
function makePairedIpc(): {
  mainTransport: IpcTransport;
  rendererTransport: IpcTransport;
} {
  // Two channels, one for each direction. Each "side" subscribes to its
  // inbound channel and pushes onto the outbound one.
  const mainInbound: Array<(m: RpcMessage) => void> = [];
  const rendererInbound: Array<(m: RpcMessage) => void> = [];

  const mainTransport = new IpcTransport(
    // main sends → renderer receives
    (msg) => rendererInbound.forEach((h) => h(msg)),
    (handler) => {
      mainInbound.push(handler);
      return () => {
        const i = mainInbound.indexOf(handler);
        if (i >= 0) mainInbound.splice(i, 1);
      };
    },
  );

  const rendererTransport = new IpcTransport(
    // renderer sends → main receives
    (msg) => mainInbound.forEach((h) => h(msg)),
    (handler) => {
      rendererInbound.push(handler);
      return () => {
        const i = rendererInbound.indexOf(handler);
        if (i >= 0) rendererInbound.splice(i, 1);
      };
    },
  );

  return { mainTransport, rendererTransport };
}

describe("IpcTransport", () => {
  it("delivers a message from one side to the other", () => {
    const { mainTransport, rendererTransport } = makePairedIpc();
    let receivedOnRenderer: RpcMessage | undefined;
    rendererTransport.onMessage((msg) => {
      receivedOnRenderer = msg;
    });

    const sent: RpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "run",
      params: { prompt: "hi" },
    };
    mainTransport.send(sent);
    expect(receivedOnRenderer).toEqual(sent);
  });

  it("works in both directions independently", () => {
    const { mainTransport, rendererTransport } = makePairedIpc();
    const mainSeen: RpcMessage[] = [];
    const rendererSeen: RpcMessage[] = [];
    mainTransport.onMessage((m) => mainSeen.push(m));
    rendererTransport.onMessage((m) => rendererSeen.push(m));

    mainTransport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    rendererTransport.send({ jsonrpc: "2.0", id: 2, method: "pong" });
    mainTransport.send({ jsonrpc: "2.0", id: 3, method: "ping" });

    // main never receives its own outbound; same for renderer.
    expect(mainSeen).toHaveLength(1);
    expect(mainSeen[0]).toMatchObject({ method: "pong" });
    expect(rendererSeen).toHaveLength(2);
    expect(rendererSeen.map((m) => m.method)).toEqual(["ping", "ping"]);
  });

  it("supports multiple handlers on the same transport (fan-out)", () => {
    const { mainTransport, rendererTransport } = makePairedIpc();
    let aCount = 0;
    let bCount = 0;
    rendererTransport.onMessage(() => aCount++);
    rendererTransport.onMessage(() => bCount++);

    mainTransport.send({ jsonrpc: "2.0", id: 1, method: "x" });
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
  });

  it("close() unsubscribes from the host channel and drops handlers", () => {
    const { mainTransport, rendererTransport } = makePairedIpc();
    let received = 0;
    rendererTransport.onMessage(() => received++);

    rendererTransport.close();

    // After close, inbound messages routed to renderer should not reach
    // the handler we registered above — the host-side subscription was
    // torn down via the unsubscribe callback.
    mainTransport.send({ jsonrpc: "2.0", id: 1, method: "x" });
    expect(received).toBe(0);
  });

  it("preserves message ordering on a single side", () => {
    const { mainTransport, rendererTransport } = makePairedIpc();
    const seen: number[] = [];
    rendererTransport.onMessage((m) => seen.push(m.id as number));

    for (let i = 0; i < 50; i++) {
      mainTransport.send({ jsonrpc: "2.0", id: i, method: "tick" });
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });
});

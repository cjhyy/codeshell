import { expect, test } from "bun:test";
import type { WebSocket } from "ws";
import { HubOutboundTransport, type HubOutboundDrop } from "./outbound-transport.js";

function socket(options: { backlog?: number; releaseOnTerminate?: boolean } = {}) {
  const value = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: options.backlog ?? 0,
    frames: [] as string[],
    terminated: 0,
    send(line: string, callback?: (error?: Error) => void) {
      value.frames.push(line);
      value.bufferedAmount += Buffer.byteLength(line) + 14;
      callback?.();
    },
    terminate() {
      value.terminated++;
      value.readyState = 3;
      if (options.releaseOnTerminate !== false) value.bufferedAmount = 0;
    },
  };
  return { state: value, ws: value as unknown as WebSocket };
}

test("one valid large history frame is allowed but a lagging socket cannot accumulate more", () => {
  const client = socket();
  const drops: HubOutboundDrop[] = [];
  const transport = new HubOutboundTransport({
    tabs: () => [client.ws],
    onDrop: (drop) => drops.push(drop),
  });
  const history = JSON.stringify({ transcript: [{ text: "x".repeat(33 * 1024 * 1024) }] });
  expect(transport.send(client.ws, history)).toBe(true);
  expect(client.state.terminated).toBe(0);
  expect(transport.send(client.ws, "next stream event")).toBe(false);
  expect(client.state.terminated).toBe(1);
  expect(drops[0]?.reason).toBe("socket-backlog");
  expect(JSON.stringify(drops)).not.toContain("transcript");
  expect(transport.send(client.ws, "late event")).toBe(false);
  expect(client.state.terminated).toBe(1);
});

test("a drained history connection keeps receiving new events", () => {
  const client = socket({ backlog: 40 * 1024 * 1024 });
  const transport = new HubOutboundTransport({ tabs: () => [client.ws] });
  client.state.bufferedAmount = 0;
  expect(transport.send(client.ws, "new event")).toBe(true);
  expect(client.state.frames).toEqual(["new event"]);
  expect(client.state.terminated).toBe(0);
});

test("a large history write can finish alongside a bounded live tail instead of being cut off", () => {
  const client = socket();
  const callbacks: Array<((error?: Error) => void) | undefined> = [];
  client.state.send = (line, callback) => {
    client.state.frames.push(line);
    client.state.bufferedAmount += Buffer.byteLength(line) + 14;
    callbacks.push(callback);
  };
  const transport = new HubOutboundTransport({
    tabs: () => [client.ws],
    limits: { maxSocketBacklogBytes: 100, maxFrameBytes: 1_000 },
  });
  expect(transport.send(client.ws, "h".repeat(500))).toBe(true);
  expect(transport.send(client.ws, "live notification")).toBe(true);
  expect(client.state.terminated).toBe(0);
  client.state.bufferedAmount = 10;
  callbacks[0]?.();
  expect(transport.send(client.ws, "after history")).toBe(true);
  expect(client.state.terminated).toBe(0);
});

test("an unread large history still has a fixed tail allowance and cannot queue a second history", () => {
  for (const extra of ["x".repeat(87), "h".repeat(500)]) {
    const client = socket();
    client.state.send = (line) => {
      client.state.frames.push(line);
      client.state.bufferedAmount += Buffer.byteLength(line) + 14;
    };
    const transport = new HubOutboundTransport({
      tabs: () => [client.ws],
      limits: { maxSocketBacklogBytes: 100, maxFrameBytes: 1_000 },
    });
    expect(transport.send(client.ws, "h".repeat(500))).toBe(true);
    expect(transport.send(client.ws, extra)).toBe(false);
    expect(client.state.terminated).toBe(1);
  }
});

test("oversized UTF-8 frames are rejected before send", () => {
  const client = socket();
  const drops: HubOutboundDrop[] = [];
  const transport = new HubOutboundTransport({
    tabs: () => [client.ws],
    limits: { maxFrameBytes: 10 },
    onDrop: (drop) => drops.push(drop),
  });
  expect(transport.send(client.ws, "部署服务")).toBe(false);
  expect(client.state.frames).toEqual([]);
  expect(drops[0]).toMatchObject({ reason: "frame-too-large", frameBytes: 12 });
});

test("shared pressure retires a lagging peer while delivering to a healthy recipient", () => {
  const lagging = socket({ backlog: 90 });
  const healthy = socket();
  const drops: HubOutboundDrop[] = [];
  const transport = new HubOutboundTransport({
    tabs: () => [lagging.ws, healthy.ws],
    limits: { maxTotalBacklogBytes: 100 },
    onDrop: (drop) => drops.push(drop),
  });
  expect(transport.send(healthy.ws, "hello")).toBe(true);
  expect(lagging.state.terminated).toBe(1);
  expect(healthy.state.terminated).toBe(0);
  expect(healthy.state.frames).toEqual(["hello"]);
  expect(drops[0]?.reason).toBe("total-backlog");
});

test("closing sockets remain in the shared budget until their queued data is released", () => {
  const lagging = socket({ backlog: 90, releaseOnTerminate: false });
  const recipient = socket();
  const transport = new HubOutboundTransport({
    tabs: () => [lagging.ws, recipient.ws],
    limits: { maxTotalBacklogBytes: 100 },
  });
  expect(transport.send(recipient.ws, "hello")).toBe(false);
  expect(lagging.state.terminated).toBe(1);
  expect(recipient.state.frames).toEqual([]);
});

test("send errors terminate only that recipient and never escape the stream router", () => {
  const failed = socket();
  const healthy = socket();
  const transport = new HubOutboundTransport({
    tabs: () => [failed.ws, healthy.ws],
    onDrop: () => {
      throw new Error("diagnostic failure");
    },
  });
  failed.state.send = () => {
    throw new Error("socket closed");
  };
  expect(transport.send(failed.ws, "payload")).toBe(false);
  expect(transport.send(healthy.ws, "payload")).toBe(true);
  expect(failed.state.terminated).toBe(1);
  expect(healthy.state.terminated).toBe(0);
});

test("asynchronous write failure terminates a broken socket once", () => {
  const client = socket();
  let callback: ((error?: Error) => void) | undefined;
  client.state.send = (_line, done) => {
    callback = done;
  };
  const transport = new HubOutboundTransport({ tabs: () => [client.ws] });
  expect(transport.send(client.ws, "payload")).toBe(true);
  callback?.(new Error("closed during write"));
  callback?.(new Error("duplicate failure"));
  expect(client.state.terminated).toBe(1);
});

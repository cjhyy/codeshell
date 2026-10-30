import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import {
  createCuaActivityServer,
  parseCompanionOperation,
  type CompanionOperation,
} from "./cua-activity-server";

test("activity payload contains only bounded presentation metadata", () => {
  const value = parseCompanionOperation({
    id: "one",
    action: "type",
    phase: "start",
    capture: false,
    target: { x: -10, y: 20 },
    text: "private input",
    script: "private script",
  });
  expect(value).toEqual({
    id: "one",
    action: "type",
    phase: "start",
    capture: false,
    target: { x: -10, y: 20 },
  });
  expect(parseCompanionOperation({ ...value, target: { x: Infinity, y: 0 } })).toBeNull();
  expect(parseCompanionOperation({ ...value, id: "x".repeat(161) })).toBeNull();
  expect(parseCompanionOperation({ ...value, action: "execute" })).toBeNull();
  expect(parseCompanionOperation({ ...value, phase: "update" })).toBeNull();
  expect(
    parseCompanionOperation({ ...value, phase: "update", targetSource: "native-cursor" }),
  ).toMatchObject({ phase: "update", targetSource: "native-cursor" });
  expect(
    parseCompanionOperation({
      ...value,
      phase: "update",
      targetSource: "native-cursor",
      capture: true,
    }),
  ).toBeNull();
  expect(parseCompanionOperation({ ...value, targetSource: "element" })?.targetSource).toBe(
    "element",
  );
  // An element frame may only open a value write, never move a running one.
  expect(
    parseCompanionOperation({ ...value, phase: "update", targetSource: "element" }),
  ).toBeNull();
  const avoidRect = { x: -2000, y: 100, width: 300, height: 80, label: "private field" };
  expect(parseCompanionOperation({ ...value, avoidRect })?.avoidRect).toEqual({
    x: -2000,
    y: 100,
    width: 300,
    height: 80,
  });
  for (const invalid of [
    null,
    { ...avoidRect, width: 0 },
    { ...avoidRect, height: -1 },
    { ...avoidRect, x: NaN },
    { ...avoidRect, width: 100_001 },
    { ...avoidRect, x: 99_999, width: 2 },
  ])
    expect(parseCompanionOperation({ ...value, avoidRect: invalid })).toBeNull();
});

test("native target updates stay inside the active operation and disconnect releases its latest target", async () => {
  const events: CompanionOperation[] = [];
  const server = await createCuaActivityServer((event) => {
    events.push(event);
  });
  const socket = createConnection(server.socketPath);
  let replies = 0;
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      replies += 1;
      buffer = buffer.slice(buffer.indexOf("\n") + 1);
    }
  });
  socket.on("error", () => {});
  try {
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const update = {
      id: "operation",
      action: "click",
      phase: "update",
      capture: false,
      target: { x: -1900, y: 700 },
      targetSource: "native-cursor",
      avoidRect: { x: -2000, y: 650, width: 300, height: 100 },
    };
    const send = (value: unknown) =>
      socket.write(JSON.stringify({ token: server.token, ...(value as object) }) + "\n");
    send(update); // An update cannot create an operation.
    send({ ...update, phase: "start", target: undefined });
    send({ ...update, action: "type" }); // Nor change its semantic identity.
    send(update);
    send({ ...update, id: "cleared", phase: "start" });
    send({ ...update, id: "cleared", target: { x: 100, y: 300 }, avoidRect: undefined });
    const deadline = Date.now() + 1_000;
    while (replies < 6 && Date.now() < deadline) await Bun.sleep(5);
    expect(replies).toBe(6);
    expect(events.map((event) => event.phase)).toEqual(["start", "update", "start", "update"]);
    expect(events[1]?.avoidRect).toEqual(update.avoidRect);
    expect(events[3]?.avoidRect).toBeUndefined();
    socket.destroy();
    await server.close();
    expect(events.find((event) => event.id === "operation" && event.phase === "end")).toMatchObject(
      {
        id: "operation",
        phase: "end",
        target: update.target,
        avoidRect: update.avoidRect,
        failed: true,
      },
    );
    expect(events.at(-1)).toMatchObject({ id: "cleared", phase: "end", failed: true });
    expect(events.at(-1)?.avoidRect).toBeUndefined();
  } finally {
    socket.destroy();
    await server.close();
  }
});

test("capture acknowledgement waits for hiding, and socket loss releases its operations", async () => {
  const events: CompanionOperation[] = [];
  let hidden!: () => void;
  const hide = new Promise<void>((resolve) => {
    hidden = resolve;
  });
  const server = await createCuaActivityServer(async (event) => {
    events.push(event);
    if (event.phase === "start") await hide;
  });
  const socket = createConnection(server.socketPath);
  let acknowledgement = "";
  socket.on("data", (chunk) => {
    acknowledgement += chunk.toString();
  });
  try {
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      JSON.stringify({
        token: server.token,
        id: "capture",
        action: "observe",
        phase: "start",
        capture: true,
      }) + "\n",
    );
    await Bun.sleep(20);
    expect(events).toHaveLength(1);
    expect(acknowledgement).toBe("");
    hidden();
    await Bun.sleep(20);
    expect(JSON.parse(acknowledgement)).toMatchObject({ id: "capture", phase: "start", ok: true });
    socket.destroy();
    await Bun.sleep(20);
    expect(events.at(-1)).toMatchObject({
      id: "capture",
      phase: "end",
      capture: true,
      failed: true,
    });
  } finally {
    hidden();
    socket.destroy();
    await server.close();
  }
});

test("unauthenticated clients cannot move or hide the character", async () => {
  const events: CompanionOperation[] = [];
  const server = await createCuaActivityServer((event) => {
    events.push(event);
  });
  const socket = createConnection(server.socketPath);
  socket.on("error", () => {});
  try {
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.write(
      JSON.stringify({ token: "wrong", id: "x", action: "click", phase: "start", capture: false }) +
        "\n",
    );
    await closed;
    expect(events).toEqual([]);
  } finally {
    socket.destroy();
    await server.close();
  }
});

test("an authenticated proxy receives the gate on hello and every later change", async () => {
  const { InputGate } = await import("./input-gate.js");
  const gate = new InputGate();
  const counts: number[] = [];
  const server = await createCuaActivityServer({
    onOperation: () => {},
    gate,
    onConnections: (count) => counts.push(count),
  });
  const socket = createConnection(server.socketPath);
  const lines: any[] = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  await new Promise((resolve) => socket.once("connect", resolve));
  // Nothing is pushed before authentication.
  gate.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(lines).toEqual([]);
  socket.write(JSON.stringify({ token: server.token, type: "hello" }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(lines[0]).toEqual({ type: "gate", gate: gate.snapshot() });
  gate.resume();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(lines[1].gate.holdAll).toBeUndefined();
  expect(lines[1].gate.version).toBeGreaterThan(lines[0].gate.version);
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(counts).toEqual([1, 0]);
  await server.close();
});

test("a wrong token on hello is disconnected without a gate", async () => {
  const server = await createCuaActivityServer(() => {});
  const socket = createConnection(server.socketPath);
  const received: string[] = [];
  socket.on("data", (chunk) => received.push(String(chunk)));
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(JSON.stringify({ token: "wrong", type: "hello" }) + "\n");
  await new Promise((resolve) => socket.once("close", resolve));
  expect(received).toEqual([]);
  await server.close();
});

test("window, process and control category are accepted only on a start", () => {
  const start = {
    id: "w1",
    action: "type",
    phase: "start",
    capture: false,
    pid: 42,
    window: { x: 0, y: 25, width: 1200, height: 800, title: "Inbox" },
    element: "text",
    appId: "chrome",
  };
  expect(parseCompanionOperation({ ...start, appId: "Not An Id!" })).not.toHaveProperty("appId");
  expect(parseCompanionOperation(start)).toEqual({
    id: "w1",
    action: "type",
    phase: "start",
    capture: false,
    pid: 42,
    window: { x: 0, y: 25, width: 1200, height: 800 },
    element: "text",
    appId: "chrome",
  });
  expect(
    parseCompanionOperation({ ...start, window: { x: 0, y: 0, width: -1, height: 2 } }),
  ).toBeNull();
  expect(parseCompanionOperation({ ...start, element: "secret label" })).not.toHaveProperty(
    "element",
  );
  expect(parseCompanionOperation({ ...start, pid: -1 })).not.toHaveProperty("pid");
  const update = parseCompanionOperation({
    ...start,
    phase: "update",
    target: { x: 1, y: 2 },
    targetSource: "native-cursor",
  });
  expect(update).not.toHaveProperty("window");
  expect(update).not.toHaveProperty("element");
  expect(update).not.toHaveProperty("pid");
});

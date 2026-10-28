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
    };
    const send = (value: unknown) =>
      socket.write(JSON.stringify({ token: server.token, ...(value as object) }) + "\n");
    send(update); // An update cannot create an operation.
    send({ ...update, phase: "start", target: undefined });
    send({ ...update, action: "type" }); // Nor change its semantic identity.
    send(update);
    const deadline = Date.now() + 1_000;
    while (replies < 4 && Date.now() < deadline) await Bun.sleep(5);
    expect(replies).toBe(4);
    expect(events.map((event) => event.phase)).toEqual(["start", "update"]);
    socket.destroy();
    await server.close();
    expect(events.at(-1)).toMatchObject({
      id: "operation",
      phase: "end",
      target: update.target,
      failed: true,
    });
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

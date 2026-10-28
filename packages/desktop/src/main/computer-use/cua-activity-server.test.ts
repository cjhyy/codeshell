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

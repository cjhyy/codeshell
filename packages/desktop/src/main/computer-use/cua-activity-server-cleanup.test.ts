import { expect, test } from "bun:test";
import { createConnection, type Socket } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createCuaActivityServer, type CompanionOperation } from "./cua-activity-server.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function connect(path: string) {
  const socket = createConnection(path);
  socket.on("error", () => {});
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  return socket;
}

function start(socket: Socket, token: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      socket.removeListener("data", onData);
      try {
        const ack = JSON.parse(buffer.trim());
        expect(ack).toEqual({ id, phase: "start", ok: true });
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    socket.on("data", onData);
    socket.write(
      JSON.stringify({ token, id, action: "observe", phase: "start", capture: true }) + "\n",
    );
  });
}

test("socket loss cleans every active capture even when one end callback throws", async () => {
  const events: CompanionOperation[] = [];
  const secondReleased = deferred();
  const server = await createCuaActivityServer(async (event) => {
    events.push(event);
    if (event.phase !== "end") return;
    if (event.id === "first") throw new Error("One presentation teardown failed");
    if (event.id === "second") secondReleased.resolve();
  });
  const socket = await connect(server.socketPath);
  try {
    await start(socket, server.token, "first");
    await start(socket, server.token, "second");
    socket.destroy();
    await secondReleased.promise;
    expect(events.filter((event) => event.phase === "end")).toEqual([
      { id: "first", action: "observe", phase: "end", capture: true, failed: true },
      { id: "second", action: "observe", phase: "end", capture: true, failed: true },
    ]);
  } finally {
    socket.destroy();
    await server.close();
  }
}, 5_000);

test("server close waits for asynchronous connection cleanup before resolving", async () => {
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  let cleaned = false;
  const server = await createCuaActivityServer(async (event) => {
    if (event.phase !== "end") return;
    cleanupStarted.resolve();
    await releaseCleanup.promise;
    cleaned = true;
  });
  const socket = await connect(server.socketPath);
  let closing: Promise<void> | undefined;
  try {
    await start(socket, server.token, "capture");
    let closed = false;
    closing = server.close().then(() => {
      closed = true;
    });
    await cleanupStarted.promise;
    await nextTurn();
    expect(closed).toBe(false);
    expect(cleaned).toBe(false);
    releaseCleanup.resolve();
    await closing;
    expect(cleaned).toBe(true);
    expect(closed).toBe(true);
  } finally {
    releaseCleanup.resolve();
    socket.destroy();
    await (closing ?? server.close());
  }
}, 5_000);

test("server close waits for a pending hide before issuing its terminal cleanup", async () => {
  const hideStarted = deferred();
  const releaseHide = deferred();
  const events: CompanionOperation[] = [];
  const server = await createCuaActivityServer(async (event) => {
    events.push(event);
    if (event.phase === "start") {
      hideStarted.resolve();
      await releaseHide.promise;
    }
  });
  const socket = await connect(server.socketPath);
  let closing: Promise<void> | undefined;
  try {
    socket.write(
      JSON.stringify({
        token: server.token,
        id: "pending-hide",
        action: "observe",
        phase: "start",
        capture: true,
      }) + "\n",
    );
    await hideStarted.promise;
    let closed = false;
    closing = server.close().then(() => {
      closed = true;
    });
    await nextTurn();
    expect(closed).toBe(false);
    expect(events.map((event) => event.phase)).toEqual(["start"]);
    releaseHide.resolve();
    await closing;
    expect(events.map((event) => event.phase)).toEqual(["start", "end"]);
    expect(events.at(-1)?.failed).toBe(true);
  } finally {
    releaseHide.resolve();
    socket.destroy();
    await (closing ?? server.close());
  }
}, 5_000);

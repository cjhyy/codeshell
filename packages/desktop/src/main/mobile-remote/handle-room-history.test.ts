import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomManager } from "../../../../server/src/mobile-remote/room-manager.js";
import { handleRoomEvent } from "./handle-room-event.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("room pages and failures reply only to the requesting viewer even on a shared device", async () => {
  const root = mkdtempSync(join(tmpdir(), "room-page-viewer-"));
  roots.push(root);
  const manager = new RoomManager({
    rootDir: root,
    createAgent: () => {
      throw new Error("unused");
    },
    onMessage() {},
  });
  const room = manager.createRoom({ cwd: "/fixture" });
  const viewers: unknown[][] = [];
  const devices: unknown[][] = [];
  const broadcast: unknown[] = [];
  const ctx = {
    roomManager: manager,
    remote: {
      sendToViewer: (...args: unknown[]) => viewers.push(args),
      sendToDevice: (...args: unknown[]) => devices.push(args),
      broadcast: (event: unknown) => broadcast.push(event),
    },
  } as any;
  await handleRoomEvent(ctx, {
    type: "room.history",
    roomId: room.id,
    page: true,
    sinceSeq: 0,
    requestId: "same-local-counter",
    deviceId: "shared-device",
    viewerId: "first",
  });
  await handleRoomEvent(ctx, {
    type: "room.history",
    roomId: room.id,
    page: true,
    sinceSeq: 1,
    requestId: "same-local-counter",
    deviceId: "shared-device",
    viewerId: "second",
  });
  expect(viewers).toMatchObject([
    [
      "first",
      {
        type: "room.history.ok",
        roomId: room.id,
        messages: [{ seq: 1 }],
        page: { complete: true, throughSeq: 1 },
      },
    ],
    [
      "second",
      {
        type: "room.history.ok",
        roomId: room.id,
        messages: [],
        page: { complete: true, throughSeq: 1 },
      },
    ],
  ]);
  await handleRoomEvent(ctx, {
    type: "room.history",
    roomId: room.id,
    page: true,
    cursor: "invalid",
    requestId: "same-local-counter",
    deviceId: "shared-device",
    viewerId: "first",
  });
  expect(viewers[2]).toMatchObject([
    "first",
    { type: "room.error", roomId: room.id, requestId: "same-local-counter" },
  ]);
  expect(devices).toEqual([]);
  expect(broadcast).toEqual([]);
});

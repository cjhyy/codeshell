import { expect, test } from "bun:test";
import { publishOwnedExternalStream } from "./owned-external-stream.js";
import { SessionSnapshotStore } from "./SessionSnapshotStore.js";

test("external live output reaches only its owner while shared history keeps exact snapshot identity", () => {
  const snapshots = new SessionSnapshotStore();
  const deliveries: Array<{ owner: number; envelope: any }> = [];
  const windows = [77, 88].map((id) => ({
    isDestroyed: () => false,
    webContents: {
      id,
      send: (_channel: string, envelope: unknown) => {
        deliveries.push({ owner: id, envelope });
      },
    },
  }));
  const event = { type: "text_delta", text: "private live", outputCursor: "fixture-cursor" };
  publishOwnedExternalStream(snapshots, windows, 77, "external", event);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].owner).toBe(77);
  expect(deliveries[0].envelope).toMatchObject({
    sessionId: "external",
    seq: 1,
    epoch: snapshots.epoch,
    event,
  });
  expect(snapshots.get("external").events[0]).toEqual({ seq: 1, event });
  windows[0].webContents.send = () => {
    throw new Error("owner remounted");
  };
  publishOwnedExternalStream(snapshots, windows, 77, "external", {
    type: "text_delta",
    text: "recoverable",
  });
  publishOwnedExternalStream(snapshots, windows, undefined, "external", {
    type: "text_delta",
    text: "owner absent",
  });
  expect(deliveries).toHaveLength(1);
  expect(snapshots.get("external").events).toHaveLength(3);
});

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFixtureNetworkGuard } from "../../../../../tests/helpers/network-fixture.js";

test.each([false, true])(
  "room retries retain exact intent across Host restart (uploaded image: %s)",
  async (uploaded) => {
    const guard = installFixtureNetworkGuard();
    const root = mkdtempSync(join(tmpdir(), "room-input-receipts-"));
    const { RoomManager } = await import("../../../../server/src/mobile-remote/room-manager.js");
    const { handleRoomEvent } = await import("./handle-room-event.js");
    const inputs: string[] = [];
    let starts = 0;
    const open = () =>
      new RoomManager({
        rootDir: join(root, "rooms"),
        onMessage() {},
        createAgent: () => {
          let running = false;
          return {
            start() {
              running = true;
              starts++;
            },
            isRunning() {
              return running;
            },
            stop() {
              running = false;
            },
            send(text: string) {
              inputs.push(text);
              return true;
            },
          };
        },
      });
    const manager = open();
    const room = manager.createRoom({ cwd: root });
    const replies: any[] = [];
    let settles = 0;
    let claimed = 0;
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const path = join(root, "image.png");
    writeFileSync(path, image);
    const descriptor = {
      transport: "upload" as const,
      clientId: "image",
      uploadId: "upload",
      name: "image.png",
      mime: "image/png" as const,
      size: image.length,
    };
    const ctx = {
      roomManager: manager,
      remote: {
        sendToViewer(_id: string, event: unknown) {
          replies.push(event);
        },
      },
      uploads: {
        async release() {},
        claim() {
          if (++claimed > 1) throw new Error("retry must not reclaim a consumed upload");
          return { ...descriptor, path, claimId: "claim" };
        },
      },
      async settleMobileUploadClaims() {
        settles++;
      },
    } as unknown as Parameters<typeof handleRoomEvent>[0];
    const event = {
      type: "room.send" as const,
      roomId: room.id,
      text: "perform once",
      clientMessageId: "intent",
      deviceId: "phone",
      viewerId: "first",
      ...(uploaded ? { attachments: [descriptor] } : {}),
    };
    let restarted: InstanceType<typeof RoomManager> | undefined;
    try {
      await Promise.all([
        handleRoomEvent(ctx, event),
        handleRoomEvent(ctx, { ...event, viewerId: "second" }),
      ]);
      expect(replies).toMatchObject([{ type: "room.accepted" }, { type: "room.accepted" }]);
      expect(inputs).toHaveLength(1);
      expect(settles).toBe(1);
      expect(claimed).toBe(uploaded ? 1 : 0);
      expect(replies.map((reply) => reply.type)).toEqual(["room.accepted", "room.accepted"]);
      await handleRoomEvent(ctx, { ...event, viewerId: "reconnected" });
      expect(inputs).toHaveLength(1);
      expect(replies.at(-1).type).toBe("room.accepted");
      await handleRoomEvent(ctx, { ...event, text: "changed intent" });
      expect(replies.at(-1).type).toBe("room.error");
      expect(inputs).toHaveLength(1);
      manager.close(room.id);
      restarted = open();
      ctx.roomManager = restarted;
      await handleRoomEvent(ctx, event);
      expect(replies.at(-1).type).toBe("room.accepted");
      expect(inputs).toHaveLength(1);
      expect(starts).toBe(1);
      expect(
        restarted.getMessages(room.id).filter((message) => message.from === "user"),
      ).toHaveLength(1);
      await handleRoomEvent(ctx, {
        ...event,
        clientMessageId: "new-intent",
        attachments: undefined,
      });
      expect(replies.at(-1).type).toBe("room.accepted");
      expect(inputs).toHaveLength(2);
    } finally {
      manager.close(room.id);
      restarted?.close(room.id);
      rmSync(root, { recursive: true, force: true });
      guard.restore();
    }
  },
);

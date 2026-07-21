import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelAdapter } from "./channel.js";
import { createDesktopNotificationHandler, splitNotificationText } from "./notification-relay.js";

describe("createDesktopNotificationHandler", () => {
  test("retries only failed targets for the same event", async () => {
    const sends: string[] = [];
    let failOnce = true;
    const adapter: ChannelAdapter = {
      channel: "telegram",
      run: async () => undefined,
      send: async (target) => {
        sends.push(target);
        if (target === "two" && failOnce) {
          failOnce = false;
          throw new Error("temporary failure");
        }
      },
    };
    const handle = createDesktopNotificationHandler(
      [adapter],
      [
        { channel: "telegram", target: "one" },
        { channel: "telegram", target: "two" },
      ],
    );
    const event = { id: 7, createdAt: 1, type: "tunnel.connected" as const, text: "ready" };

    await expect(handle(event, { streamId: "a".repeat(32) })).rejects.toThrow(
      "notification failed",
    );
    await handle(event, { streamId: "a".repeat(32) });
    expect(sends).toEqual(["one", "two", "two"]);

    await handle({ ...event, id: 8 }, { streamId: "a".repeat(32) });
    expect(sends).toEqual(["one", "two", "two", "one", "two"]);
  });

  test("delivers a targeted Pet completion even when general notifications are disabled", async () => {
    const sends: Array<{ target: string; text: string }> = [];
    const adapter: ChannelAdapter = {
      channel: "wechat",
      run: async () => undefined,
      send: async (target, message) => void sends.push({ target, text: message.text }),
    };
    const handle = createDesktopNotificationHandler([adapter], []);

    await handle(
      {
        id: 9,
        createdAt: 2,
        type: "pet.task.completed",
        text: "CodeShell 待办事项已经整理完成。",
        target: { channel: "wechat", target: "owner-conversation" },
      },
      { streamId: "b".repeat(32) },
    );

    expect(sends).toEqual([
      { target: "owner-conversation", text: "CodeShell 待办事项已经整理完成。" },
    ]);
  });

  test("splits long completion receipts and resumes at the failed chunk", async () => {
    const sends: string[] = [];
    let failed = false;
    const adapter: ChannelAdapter = {
      channel: "telegram",
      run: async () => undefined,
      send: async (_target, message) => {
        sends.push(message.text);
        if (!failed && sends.length === 2) {
          failed = true;
          throw new Error("temporary chunk failure");
        }
      },
    };
    const handle = createDesktopNotificationHandler([adapter], []);
    const text = `${"中".repeat(3_499)}\n${"🙂".repeat(2_000)}`;
    const event = {
      id: 10,
      createdAt: 3,
      type: "pet.task.completed" as const,
      text,
      target: { channel: "telegram", target: "owner" },
    };

    await expect(handle(event, { streamId: "c".repeat(32) })).rejects.toThrow(
      "notification failed",
    );
    await handle(event, { streamId: "c".repeat(32) });

    const deliveredChunks = splitNotificationText(text);
    expect(sends.every((chunk) => chunk.length <= 1_800)).toBe(true);
    expect(sends.slice(0, 1).join("") + sends.slice(2).join("")).toBe(text);
    expect(sends).toHaveLength(deliveredChunks.length + 1);
  });

  test("retries a failed image without repeating the completed text receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "notification-relay-"));
    const imagePath = join(root, "generated.png");
    const imageBytes = Uint8Array.from([137, 80, 78, 71]);
    await writeFile(imagePath, imageBytes);
    try {
      const sends: Array<{ text: string; imageBytes?: number[] }> = [];
      let failImageOnce = true;
      const adapter: ChannelAdapter = {
        channel: "wechat",
        supportsOutgoingAttachments: true,
        run: async () => undefined,
        send: async (_target, message) => {
          sends.push({
            text: message.text,
            ...(message.attachments ? { imageBytes: [...message.attachments[0]!.data] } : {}),
          });
          if (message.attachments && failImageOnce) {
            failImageOnce = false;
            throw new Error("temporary image failure");
          }
        },
      };
      const handle = createDesktopNotificationHandler([adapter], []);
      const event = {
        id: 11,
        createdAt: 4,
        type: "pet.task.completed" as const,
        text: "漫画已经生成完成。",
        target: { channel: "wechat", target: "owner" },
        attachments: [
          {
            kind: "image" as const,
            name: "generated.png",
            mimeType: "image/png",
            size: imageBytes.byteLength,
            path: imagePath,
          },
        ],
      };

      await expect(handle(event, { streamId: "d".repeat(32) })).rejects.toThrow(
        "notification failed",
      );
      await handle(event, { streamId: "d".repeat(32) });

      expect(sends).toEqual([
        { text: "漫画已经生成完成。" },
        { text: "", imageBytes: [...imageBytes] },
        { text: "", imageBytes: [...imageBytes] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never splits an emoji surrogate pair", () => {
    const chunks = splitNotificationText(`a${"🙂".repeat(5)}`, 4);
    expect(chunks.join("")).toBe(`a${"🙂".repeat(5)}`);
    expect(chunks.every((chunk) => chunk.length <= 4)).toBe(true);
    expect(
      chunks.every((chunk) => {
        const first = chunk.charCodeAt(0);
        const last = chunk.charCodeAt(chunk.length - 1);
        return !(first >= 0xdc00 && first <= 0xdfff) && !(last >= 0xd800 && last <= 0xdbff);
      }),
    ).toBe(true);
  });
});

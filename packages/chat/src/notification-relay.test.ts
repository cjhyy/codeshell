import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelAdapter } from "./channel.js";
import {
  createDesktopNotificationHandler,
  materializeEventAttachments,
  splitNotificationText,
} from "./notification-relay.js";

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

  test("delivers the image together with the final text chunk in one message", async () => {
    const root = await mkdtemp(join(tmpdir(), "notification-relay-"));
    const imagePath = join(root, "generated.png");
    const imageBytes = Uint8Array.from([137, 80, 78, 71]);
    await writeFile(imagePath, imageBytes);
    try {
      const sends: Array<{ text: string; imageBytes?: number[] }> = [];
      const adapter: ChannelAdapter = {
        channel: "wechat",
        supportsOutgoingAttachments: true,
        run: async () => undefined,
        send: async (_target, message) => {
          sends.push({
            text: message.text,
            ...(message.attachments ? { imageBytes: [...message.attachments[0]!.data] } : {}),
          });
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

      await handle(event, { streamId: "d".repeat(32) });

      expect(sends).toEqual([{ text: "漫画已经生成完成。", imageBytes: [...imageBytes] }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries a failed final chunk+image without repeating delivered chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "notification-relay-"));
    const imagePath = join(root, "generated.png");
    const imageBytes = Uint8Array.from([137, 80, 78, 71]);
    await writeFile(imagePath, imageBytes);
    try {
      const sends: Array<{ text: string; hasImage: boolean }> = [];
      let failCombinedOnce = true;
      const adapter: ChannelAdapter = {
        channel: "wechat",
        supportsOutgoingAttachments: true,
        run: async () => undefined,
        send: async (_target, message) => {
          sends.push({ text: message.text, hasImage: Boolean(message.attachments?.length) });
          if (message.attachments && failCombinedOnce) {
            failCombinedOnce = false;
            throw new Error("temporary image failure");
          }
        },
      };
      const handle = createDesktopNotificationHandler([adapter], []);
      const text = `${"前".repeat(1_900)}\n漫画已经生成完成。`;
      const event = {
        id: 12,
        createdAt: 5,
        type: "pet.task.completed" as const,
        text,
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

      await expect(handle(event, { streamId: "e".repeat(32) })).rejects.toThrow(
        "notification failed",
      );
      await handle(event, { streamId: "e".repeat(32) });

      const chunks = splitNotificationText(text);
      expect(chunks.length).toBe(2);
      // Chunk 1 delivered once; the combined final chunk+image send is the only
      // part retried.
      expect(sends).toEqual([
        { text: chunks[0]!, hasImage: false },
        { text: chunks[1]!, hasImage: true },
        { text: chunks[1]!, hasImage: true },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("still delivers the text when the attachment fails to materialize, then sends the image alone once it is valid", async () => {
    const root = await mkdtemp(join(tmpdir(), "notification-relay-"));
    const imagePath = join(root, "generated.png");
    const imageBytes = Uint8Array.from([137, 80, 78, 71]);
    // Published size says 4 bytes but write only 3 → materialization fails.
    await writeFile(imagePath, imageBytes.slice(0, 3));
    try {
      const sends: Array<{ text: string; hasImage: boolean }> = [];
      const adapter: ChannelAdapter = {
        channel: "wechat",
        supportsOutgoingAttachments: true,
        run: async () => undefined,
        send: async (_target, message) => {
          sends.push({ text: message.text, hasImage: Boolean(message.attachments?.length) });
        },
      };
      const handle = createDesktopNotificationHandler([adapter], []);
      const event = {
        id: 13,
        createdAt: 6,
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

      await expect(handle(event, { streamId: "f".repeat(32) })).rejects.toThrow(
        "notification failed",
      );
      // The file is restored to its published size; the retry must not repeat
      // the already-delivered text.
      await writeFile(imagePath, imageBytes);
      await handle(event, { streamId: "f".repeat(32) });

      expect(sends).toEqual([
        { text: "漫画已经生成完成。", hasImage: false },
        { text: "", hasImage: true },
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

  test("rejects relative paths and files whose size changed before IM delivery", async () => {
    await expect(
      materializeEventAttachments([
        {
          kind: "image",
          name: "relative.png",
          mimeType: "image/png",
          size: 4,
          path: "relative.png",
        },
      ]),
    ).rejects.toThrow("metadata is invalid");

    const root = await mkdtemp(join(tmpdir(), "notification-relay-invalid-"));
    const path = join(root, "changed.png");
    try {
      await writeFile(path, Uint8Array.from([137, 80, 78, 71]));
      await expect(
        materializeEventAttachments([
          {
            kind: "image",
            name: "changed.png",
            mimeType: "image/png",
            size: 3,
            path,
          },
        ]),
      ).rejects.toThrow("changed before delivery");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("materializes a validated host-local file attachment", async () => {
    const root = await mkdtemp(join(tmpdir(), "notification-relay-file-"));
    const path = join(root, "report.pdf");
    const bytes = Uint8Array.from([37, 80, 68, 70]);
    try {
      await writeFile(path, bytes);
      const [attachment] = await materializeEventAttachments([
        {
          kind: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          size: bytes.byteLength,
          path,
        },
      ]);
      expect(attachment).toMatchObject({
        kind: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
      });
      expect(attachment?.data).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

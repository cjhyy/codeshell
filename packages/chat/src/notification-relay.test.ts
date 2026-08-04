import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelAdapter } from "./channel.js";
import type {
  NotificationDeliveryProgressState,
  NotificationDeliveryProgressStore,
} from "./notification-progress.js";
import {
  createDesktopNotificationHandler,
  materializeOutgoingAttachments,
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

  test("resumes only unfinished targets after the notification handler is recreated", async () => {
    let saved: NotificationDeliveryProgressState | undefined;
    const progressStore: NotificationDeliveryProgressStore = {
      load: async () => (saved ? structuredClone(saved) : undefined),
      save: async (state) => {
        saved = structuredClone(state);
      },
    };
    const sends: string[] = [];
    let failSecondOnce = true;
    const adapter: ChannelAdapter = {
      channel: "telegram",
      run: async () => undefined,
      send: async (target) => {
        sends.push(target);
        if (target === "two" && failSecondOnce) {
          failSecondOnce = false;
          throw new Error("temporary failure");
        }
      },
    };
    const targets = [
      { channel: "telegram", target: "one" },
      { channel: "telegram", target: "two" },
    ] as const;
    const event = {
      id: 70,
      createdAt: 1,
      deliveryKey: "d".repeat(64),
      type: "tunnel.connected" as const,
      text: "ready",
    };
    const context = { streamId: "9".repeat(32) };

    const firstProcess = createDesktopNotificationHandler([adapter], targets, { progressStore });
    await expect(firstProcess(event, context)).rejects.toThrow("notification failed");

    const restartedProcess = createDesktopNotificationHandler([adapter], targets, {
      progressStore,
    });
    await restartedProcess(event, { streamId: "8".repeat(32) });

    expect(sends).toEqual(["one", "two", "two"]);
    expect(JSON.stringify(saved)).not.toContain("one");
    expect(JSON.stringify(saved)).not.toContain("two");
  });

  test("delivers a targeted Pet completion even when general notifications are disabled", async () => {
    const sends: Array<{ target: string; text: string }> = [];
    const adapter: ChannelAdapter = {
      channel: "wechat",
      run: async () => undefined,
      send: async (target, message) => void sends.push({ target, text: message.text }),
    };
    const handle = createAuthorizedTargetHandler(adapter);

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

  test("keeps a personal WeChat completion under its declared limit in one message", async () => {
    const sends: string[] = [];
    const adapter: ChannelAdapter = {
      channel: "wechat",
      capabilities: {
        inbound: { text: true, attachments: [] },
        outbound: {
          text: true,
          proactive: true,
          direct: true,
          maxTextLength: 8_000,
          button: "link",
          attachments: [],
        },
      },
      run: async () => undefined,
      send: async (_target, message) => void sends.push(message.text),
    };
    const handle = createAuthorizedTargetHandler(adapter);
    const text = "分析结果：" + "中".repeat(3_500);

    await handle(
      {
        id: 91,
        createdAt: 2,
        type: "pet.task.completed",
        text,
        target: { channel: "wechat", target: "owner-conversation" },
      },
      { streamId: "b".repeat(32) },
    );

    expect(sends).toEqual([text]);
  });

  test("revalidates target authorization for every event and skips an owner-revoked route", async () => {
    const sends: string[] = [];
    let authorized = false;
    const adapter: ChannelAdapter = {
      channel: "telegram",
      run: async () => undefined,
      send: async (target) => void sends.push(target),
    };
    const handle = createDesktopNotificationHandler([adapter], [], {
      authorizeTarget: async () => authorized,
    });
    const event = {
      id: 90,
      createdAt: 2,
      type: "pet.task.completed" as const,
      text: "ready",
      target: { channel: "telegram", target: "former-owner-route" },
    };

    await handle(event, { streamId: "6".repeat(32) });
    expect(sends).toEqual([]);
    authorized = true;
    await handle(event, { streamId: "6".repeat(32) });
    expect(sends).toEqual(["former-owner-route"]);
  });

  test("retries when current authorization cannot be read instead of treating it as revocation", async () => {
    let sends = 0;
    const adapter: ChannelAdapter = {
      channel: "wechat",
      run: async () => undefined,
      send: async () => void (sends += 1),
    };
    const handle = createDesktopNotificationHandler([adapter], [], {
      authorizeTarget: async () => {
        throw new Error("authorization store unavailable");
      },
    });

    await expect(
      handle(
        {
          id: 901,
          createdAt: 2,
          type: "pet.task.completed",
          text: "ready",
          target: { channel: "wechat", target: "owner-conversation" },
        },
        { streamId: "5".repeat(32) },
      ),
    ).rejects.toThrow("authorization store unavailable");
    expect(sends).toBe(0);
  });

  test("rejects malformed event text, actions, targets, and attachment metadata before transport", async () => {
    let sends = 0;
    const adapter: ChannelAdapter = {
      channel: "telegram",
      run: async () => undefined,
      send: async () => void (sends += 1),
    };
    const handle = createAuthorizedTargetHandler(adapter);
    const base = {
      id: 91,
      createdAt: 2,
      type: "pet.task.completed" as const,
      text: "ready",
      target: { channel: "telegram", target: "owner" },
    };
    const context = { streamId: "7".repeat(32) };

    await expect(handle({ ...base, text: "bad\u0000text" }, context)).rejects.toThrow(
      "event is invalid",
    );
    await expect(
      handle({ ...base, button: { text: "Open", url: "javascript:alert(1)" } }, context),
    ).rejects.toThrow("event is invalid");
    await expect(
      handle({ ...base, target: { channel: "telegram", target: "bad\u0000target" } }, context),
    ).rejects.toThrow("event is invalid");
    await expect(handle({ ...base, deliveryKey: "not-a-sha256" }, context)).rejects.toThrow(
      "event is invalid",
    );
    await expect(
      handle(
        {
          ...base,
          attachments: [
            {
              kind: "image",
              name: "result.png",
              mimeType: "image/png",
              size: 4,
              path: "relative/result.png",
            },
          ],
        },
        context,
      ),
    ).rejects.toThrow("event is invalid");
    expect(sends).toBe(0);
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
    const handle = createAuthorizedTargetHandler(adapter);
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
        combinesTextAndAttachmentsAtomically: true,
        run: async () => undefined,
        send: async (_target, message) => {
          sends.push({
            text: message.text,
            ...(message.attachments ? { imageBytes: [...message.attachments[0]!.data] } : {}),
          });
        },
      };
      const handle = createAuthorizedTargetHandler(adapter);
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

  test("retries a failed combined WeChat message as one visible text payload", async () => {
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
        combinesTextAndAttachmentsAtomically: true,
        run: async () => undefined,
        send: async (_target, message) => {
          sends.push({ text: message.text, hasImage: Boolean(message.attachments?.length) });
          if (message.attachments && failCombinedOnce) {
            failCombinedOnce = false;
            throw new Error("temporary image failure");
          }
        },
      };
      const handle = createAuthorizedTargetHandler(adapter);
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

      // Personal WeChat keeps text below its declared 8k limit together. Since
      // this fake adapter declares an atomic combined send, retry repeats that
      // one failed platform request rather than creating a separate text item.
      expect(sends).toEqual([
        { text, hasImage: true },
        { text, hasImage: true },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not repeat accepted text when a split-transport attachment fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "notification-relay-split-"));
    const imagePath = join(root, "generated.png");
    const imageBytes = Uint8Array.from([137, 80, 78, 71]);
    await writeFile(imagePath, imageBytes);
    try {
      const sends: Array<{ text: string; hasImage: boolean }> = [];
      let failImageOnce = true;
      const adapter: ChannelAdapter = {
        channel: "wechat",
        supportsOutgoingAttachments: true,
        run: async () => undefined,
        send: async (_target, message) => {
          sends.push({ text: message.text, hasImage: Boolean(message.attachments?.length) });
          if (message.attachments && failImageOnce) {
            failImageOnce = false;
            throw new Error("temporary image failure");
          }
        },
      };
      const handle = createAuthorizedTargetHandler(adapter);
      const event = {
        id: 120,
        createdAt: 5,
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

      await expect(handle(event, { streamId: "8".repeat(32) })).rejects.toThrow(
        "notification failed",
      );
      await handle(event, { streamId: "8".repeat(32) });

      expect(sends).toEqual([
        { text: "漫画已经生成完成。", hasImage: false },
        { text: "", hasImage: true },
        { text: "", hasImage: true },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("checkpoints each split attachment so a later failure repeats neither text nor prior media", async () => {
    const root = await mkdtemp(join(tmpdir(), "notification-relay-multi-split-"));
    const firstPath = join(root, "first.png");
    const secondPath = join(root, "second.png");
    await writeFile(firstPath, Uint8Array.from([1]));
    await writeFile(secondPath, Uint8Array.from([2]));
    try {
      const sends: Array<{ text: string; attachment?: string }> = [];
      let failSecondOnce = true;
      const adapter: ChannelAdapter = {
        channel: "telegram",
        supportsOutgoingAttachments: true,
        run: async () => undefined,
        send: async (_target, message) => {
          const attachment = message.attachments?.[0]?.name;
          sends.push({ text: message.text, ...(attachment ? { attachment } : {}) });
          if (attachment === "second.png" && failSecondOnce) {
            failSecondOnce = false;
            throw new Error("temporary second attachment failure");
          }
        },
      };
      const handle = createAuthorizedTargetHandler(adapter);
      const event = {
        id: 121,
        createdAt: 5,
        type: "pet.task.completed" as const,
        text: "两张图片已经生成。",
        target: { channel: "telegram", target: "owner" },
        attachments: [
          {
            kind: "image" as const,
            name: "first.png",
            mimeType: "image/png",
            size: 1,
            path: firstPath,
          },
          {
            kind: "image" as const,
            name: "second.png",
            mimeType: "image/png",
            size: 1,
            path: secondPath,
          },
        ],
      };

      await expect(handle(event, { streamId: "7".repeat(32) })).rejects.toThrow(
        "notification failed",
      );
      await handle(event, { streamId: "7".repeat(32) });

      expect(sends).toEqual([
        { text: "两张图片已经生成。" },
        { text: "", attachment: "first.png" },
        { text: "", attachment: "second.png" },
        { text: "", attachment: "second.png" },
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
      const handle = createAuthorizedTargetHandler(adapter);
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
      materializeOutgoingAttachments([
        {
          kind: "image",
          name: "relative.png",
          mimeType: "image/png",
          size: 4,
          path: "relative.png",
        },
      ]),
    ).rejects.toThrow("metadata is invalid");

    await expect(
      materializeOutgoingAttachments(
        Array.from({ length: 5 }, (_, index) => ({
          kind: "file" as const,
          name: `file-${index}.txt`,
          mimeType: "text/plain",
          size: 1,
          path: `/tmp/file-${index}.txt`,
        })),
      ),
    ).rejects.toThrow("metadata is invalid");

    await expect(
      materializeOutgoingAttachments([
        {
          kind: "file",
          name: "../secret.txt",
          mimeType: "text/plain",
          size: 1,
          path: "/tmp/secret.txt",
        },
      ]),
    ).rejects.toThrow("metadata is invalid");

    const root = await mkdtemp(join(tmpdir(), "notification-relay-invalid-"));
    const path = join(root, "changed.png");
    try {
      await writeFile(path, Uint8Array.from([137, 80, 78, 71]));
      await expect(
        materializeOutgoingAttachments([
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
      const [attachment] = await materializeOutgoingAttachments([
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

function createAuthorizedTargetHandler(adapter: ChannelAdapter) {
  return createDesktopNotificationHandler([adapter], [], {
    authorizeTarget: async () => true,
  });
}

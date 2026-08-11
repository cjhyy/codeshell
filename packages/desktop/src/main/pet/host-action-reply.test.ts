import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrichPetChatReplyWithHostActions } from "./host-action-reply";
import {
  PET_HOST_ACTION_RECEIPT_CLIENT_ID_PREFIX,
  replacementReceiptSourceClientMessageId,
} from "../../shared/pet-host-action-receipt";

describe("enrichPetChatReplyWithHostActions", () => {
  test("returns the base reply untouched without host actions", async () => {
    const enriched = await enrichPetChatReplyWithHostActions("你好", undefined, {
      qrDir: join(tmpdir(), "unused"),
    });
    expect(enriched).toEqual({ text: "你好", attachments: [] });
  });

  test("appends the opened tunnel details and renders a pairing QR image", async () => {
    const qrDir = await mkdtemp(join(tmpdir(), "pet-qr-"));
    try {
      const enriched = await enrichPetChatReplyWithHostActions(
        "我去打开手机遥控。",
        [
          {
            kind: "mobileRemote",
            payload: { action: "open" },
            ok: true,
            result: {
              action: "open",
              url: "https://demo.trycloudflare.com",
              pairingUrl: "https://demo.trycloudflare.com/mobile?pairing=one-time",
              expiresAt: Date.now() + 600_000,
            },
          },
        ],
        { qrDir },
      );

      expect(enriched.text).toContain("我去打开手机遥控。");
      expect(enriched.text).toContain("https://demo.trycloudflare.com");
      expect(enriched.text).toContain("https://demo.trycloudflare.com/mobile?pairing=one-time");
      expect(enriched.text).toContain("访问口令");

      expect(enriched.attachments).toHaveLength(1);
      const attachment = enriched.attachments[0]!;
      expect(attachment.kind).toBe("image");
      expect(attachment.mimeType).toBe("image/png");
      const bytes = await readFile(attachment.path);
      expect(bytes.byteLength).toBe(attachment.size);
      expect(bytes[0]).toBe(0x89);
      expect(bytes[1]).toBe(0x50);
    } finally {
      await rm(qrDir, { recursive: true, force: true });
    }
  });

  test("keeps the pairing URL but skips QR rendering when the route cannot send images", async () => {
    const enriched = await enrichPetChatReplyWithHostActions(
      "我去打开手机遥控。",
      [
        {
          kind: "mobileRemote",
          payload: { action: "open" },
          ok: true,
          result: {
            action: "open",
            url: "https://demo.trycloudflare.com",
            pairingUrl: "https://demo.trycloudflare.com/mobile?pairing=one-time",
          },
        },
      ],
      { qrDir: join(tmpdir(), "unused"), attachmentKinds: [] },
    );

    expect(enriched.text).toContain("https://demo.trycloudflare.com/mobile?pairing=one-time");
    expect(enriched.text).not.toContain("二维码");
    expect(enriched.attachments).toEqual([]);
  });

  test("keeps at most a bounded number of rendered QR files", async () => {
    const qrDir = await mkdtemp(join(tmpdir(), "pet-qr-"));
    try {
      for (let index = 0; index < 6; index += 1) {
        await enrichPetChatReplyWithHostActions(
          "打开",
          [
            {
              kind: "mobileRemote",
              payload: { action: "open" },
              ok: true,
              result: {
                action: "open",
                url: "https://demo.trycloudflare.com",
                pairingUrl: `https://demo.trycloudflare.com/mobile?pairing=${index}`,
                expiresAt: Date.now() + 600_000,
              },
            },
          ],
          { qrDir },
        );
      }
      const files = await readdir(qrDir);
      expect(files.length).toBeLessThanOrEqual(4);
    } finally {
      await rm(qrDir, { recursive: true, force: true });
    }
  });

  test("confirms long-task control and memory outcomes as plain text", async () => {
    const enriched = await enrichPetChatReplyWithHostActions(
      "好的。",
      [
        {
          kind: "longTaskControl",
          payload: { taskId: "pet-task-1", action: "cancel" },
          ok: true,
          result: { action: "cancel", objective: "整理发布说明" },
        },
        {
          kind: "memory",
          payload: { action: "remember", text: "喜欢暗色主题" },
          ok: true,
          result: { action: "remember", id: "mem-1" },
        },
        {
          kind: "memory",
          payload: { action: "remember", text: "偏爱深色界面" },
          ok: true,
          result: { action: "remember", id: "mem-1", unchanged: true },
        },
      ],
      { qrDir: join(tmpdir(), "unused") },
    );
    expect(enriched.text).toContain("已取消");
    expect(enriched.text).toContain("整理发布说明");
    expect(enriched.text).toContain("已记住");
    expect(enriched.text).toContain("已有等价的用户记忆，已保留原文");
    expect(enriched.attachments).toEqual([]);
  });

  test("renders authoritative follow-up, session archive, and outbound acceptance receipts", async () => {
    const enriched = await enrichPetChatReplyWithHostActions(
      "",
      [
        {
          kind: "followUpMutation",
          payload: { action: "complete", followUpId: "followup-one" },
          ok: true,
          result: { action: "complete", title: "整理发布说明" },
        },
        {
          kind: "sessionArchive",
          payload: { action: "archive", sessionIds: ["session-one", "session-two"] },
          ok: true,
          result: { count: 2, archived: ["session-one", "session-two"] },
        },
        {
          kind: "outboundMessage",
          payload: {
            targetId: "owner-one",
            text: "已经完成",
            attachmentPaths: ["/work/result.png"],
          },
          ok: true,
          result: { label: "微信", accepted: true, attachmentCount: 1 },
        },
      ],
      { qrDir: join(tmpdir(), "unused"), attachmentKinds: [] },
    );

    expect(enriched.text).toContain("跟进项已标记为已处理：「整理发布说明」");
    expect(enriched.text).toContain("已归档 2 个工作 Session");
    expect(enriched.text).toContain(
      "消息和 1 个附件已提交到 微信，平台接口已接受发送请求；尚未确认收件设备已展示",
    );
    expect(enriched.attachments).toEqual([]);
  });

  test("keeps outbound receipt generation and legacy replacement recognition in one contract", async () => {
    const sourceClientMessageId = "message-with-punctuation";
    const enriched = await enrichPetChatReplyWithHostActions(
      "",
      [
        {
          kind: "outboundMessage",
          payload: { targetId: "owner-one", text: "done" },
          ok: true,
          result: { label: "微信，项目。群", accepted: true, attachmentCount: 0 },
        },
      ],
      { qrDir: join(tmpdir(), "unused"), attachmentKinds: [] },
    );

    expect(
      replacementReceiptSourceClientMessageId(
        `${PET_HOST_ACTION_RECEIPT_CLIENT_ID_PREFIX}${sourceClientMessageId}`,
        enriched.text,
      ),
    ).toBe(sourceClientMessageId);
    expect(
      replacementReceiptSourceClientMessageId(
        `${PET_HOST_ACTION_RECEIPT_CLIENT_ID_PREFIX}${sourceClientMessageId}`,
        "消息已发送到 微信，项目。群。",
      ),
    ).toBe(sourceClientMessageId);
  });

  test("discards Mimi's premature delivery claim when outbound delivery fails", async () => {
    const enriched = await enrichPetChatReplyWithHostActions(
      "测试消息已经通过 SendMessage 发出去了。",
      [
        {
          kind: "outboundMessage",
          payload: { targetId: "owner-one", text: "测试消息" },
          ok: false,
          error: "微信发送失败：prepare failed",
        },
      ],
      { qrDir: join(tmpdir(), "unused"), attachmentKinds: [] },
    );

    expect(enriched.text).toBe("主动消息操作失败：微信发送失败：prepare failed");
    expect(enriched.text).not.toContain("已经通过 SendMessage 发出去了");
  });

  test("uses host-validated Gateway text, button, and every media kind as the IM reply", async () => {
    const enriched = await enrichPetChatReplyWithHostActions(
      "给你。",
      [
        {
          kind: "gatewayReply",
          payload: {
            text: "这是完整结果。",
            button: { text: "打开", url: "https://example.test/result" },
            attachmentPaths: [
              "/work/comic.png",
              "/work/report.pdf",
              "/work/voice.opus",
              "/work/clip.mp4",
            ],
          },
          ok: true,
          result: {
            text: "这是完整结果。",
            button: { text: "打开", url: "https://example.test/result" },
            attachments: [
              {
                kind: "image",
                path: "/work/comic.png",
                name: "comic.png",
                mimeType: "image/png",
                size: 123,
              },
              {
                kind: "file",
                path: "/work/report.pdf",
                name: "report.pdf",
                mimeType: "application/pdf",
                size: 456,
              },
              {
                kind: "audio",
                path: "/work/voice.opus",
                name: "voice.opus",
                mimeType: "audio/ogg",
                size: 321,
              },
              {
                kind: "video",
                path: "/work/clip.mp4",
                name: "clip.mp4",
                mimeType: "video/mp4",
                size: 654,
              },
            ],
          },
        },
      ],
      { qrDir: join(tmpdir(), "unused") },
    );

    expect(enriched.text).toBe("这是完整结果。");
    expect(enriched.button).toEqual({ text: "打开", url: "https://example.test/result" });
    expect(enriched.attachments.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: "image", name: "comic.png" },
      { kind: "file", name: "report.pdf" },
      { kind: "audio", name: "voice.opus" },
      { kind: "video", name: "clip.mp4" },
    ]);
  });

  test("keeps a post-launch host reply instead of a stale pre-launch GatewayReply", async () => {
    const enriched = await enrichPetChatReplyWithHostActions(
      "任务已启动，正在处理。完成后我会在当前会话回复结果。",
      [
        {
          kind: "gatewayReply",
          payload: { text: "微信消息已发送。系统提示当前没有活跃任务，待命。" },
          ok: true,
          result: { text: "微信消息已发送。系统提示当前没有活跃任务，待命。" },
        },
      ],
      {
        qrDir: join(tmpdir(), "unused"),
        authoritativeBaseText: true,
      },
    );

    expect(enriched).toEqual({
      text: "任务已启动，正在处理。完成后我会在当前会话回复结果。",
      attachments: [],
    });
  });

  test("reports close and failure outcomes as plain text", async () => {
    const closed = await enrichPetChatReplyWithHostActions(
      "好的。",
      [
        {
          kind: "mobileRemote",
          payload: { action: "close" },
          ok: true,
          result: { action: "close" },
        },
      ],
      { qrDir: join(tmpdir(), "unused") },
    );
    expect(closed.text).toContain("公网隧道已关闭");
    expect(closed.attachments).toEqual([]);

    const failed = await enrichPetChatReplyWithHostActions(
      "我去打开。",
      [
        {
          kind: "mobileRemote",
          payload: { action: "open" },
          ok: false,
          error: "cloudflared exited",
        },
        {
          kind: "memory",
          payload: { action: "forget", memoryId: "mem-9" },
          ok: false,
          error: "memory not found: mem-9",
        },
      ],
      { qrDir: join(tmpdir(), "unused") },
    );
    expect(failed.text).toContain("cloudflared exited");
    expect(failed.text).toContain("memory not found");
    expect(failed.attachments).toEqual([]);
  });

  test("replaces a premature sent claim when host attachment validation fails", async () => {
    const failed = await enrichPetChatReplyWithHostActions(
      "漫画版 JPEG 已经作为附件发出去了。",
      [
        {
          kind: "gatewayReply",
          payload: { text: "给你。", attachmentPaths: ["/outside/pet-comic.jpg"] },
          ok: false,
          error: "附件不在允许的目录内",
        },
      ],
      { qrDir: join(tmpdir(), "unused") },
    );

    expect(failed.text).toBe("Gateway 回复未发送：附件不在允许的目录内");
    expect(failed.text).not.toContain("已经作为附件发出去了");
    expect(failed.attachments).toEqual([]);
  });
});

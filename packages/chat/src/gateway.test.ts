import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGateway, createAllowlistMiddleware } from "./chat-gateway.js";
import {
  BUILTIN_CHANNEL_CAPABILITIES,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelMessage,
  type OutgoingMessage,
} from "./channel.js";
import { DesktopControlUnavailableError } from "./desktop-control-client.js";
import {
  createCodeShellRemoteCommands,
  createMimiPetChat,
  parseGatewayCommand,
  parseGatewayIntent,
} from "./gateway.js";

describe("CodeShell remote command integration", () => {
  test("parses Telegram command mentions and ignores trailing arguments", () => {
    expect(parseGatewayCommand(" /OPEN@CodeShellBot now ")).toBe("open");
    expect(parseGatewayCommand("/close")).toBe("close");
    expect(parseGatewayCommand("/status")).toBe("status");
    expect(parseGatewayCommand("hello")).toBe("unsupported");
  });

  test("routes every natural-language message to Mimi; only slash commands short-circuit", () => {
    expect(parseGatewayIntent("/open")).toBe("open");
    expect(parseGatewayIntent("/close")).toBe("close");
    expect(parseGatewayIntent("/status")).toBe("status");
    // Natural language is Mimi's job (MobileRemote tool), never regex-matched here.
    expect(parseGatewayIntent("帮我开一下手机遥控")).toBe("unsupported");
    expect(parseGatewayIntent("给我手机遥控地址")).toBe("unsupported");
    expect(parseGatewayIntent("请关闭公网入口")).toBe("unsupported");
    expect(parseGatewayIntent("看看手机遥控状态")).toBe("unsupported");
    expect(parseGatewayIntent("open the mobile remote")).toBe("unsupported");
  });

  test("open reply attaches a pairing QR image when the adapter supports attachments", async () => {
    const adapter = fakeAdapter({ capabilities: BUILTIN_CHANNEL_CAPABILITIES.telegram });
    const pairingUrl = "https://demo.trycloudflare.com/mobile?pairing=one-time";
    const gateway = new ChatGateway({ adapters: [adapter] });
    gateway.use(
      createCodeShellRemoteCommands({
        desktop: {
          open: async () => ({
            url: "https://demo.trycloudflare.com",
            pairingUrl,
            expiresAt: Date.now() + 600_000,
            mode: "tunnel",
          }),
          close: async () => undefined,
          status: async () => {
            throw new Error("unexpected");
          },
        },
      }),
    );

    await gateway.dispatch(adapter, message("/open"));
    const attachment = adapter.replies[0]?.message.attachments?.[0];
    expect(attachment?.kind).toBe("image");
    expect(attachment?.mimeType).toBe("image/png");
    // PNG magic bytes prove a real image was rendered from the pairing URL.
    expect(attachment && attachment.data[0]).toBe(0x89);
    expect(attachment && attachment.data[1]).toBe(0x50);
    expect(adapter.replies[0]?.message.button?.url).toBe(pairingUrl);
  });

  test("open reply stays text-only when the adapter cannot send attachments", async () => {
    const adapter = fakeAdapter();
    const gateway = new ChatGateway({ adapters: [adapter] });
    gateway.use(
      createCodeShellRemoteCommands({
        desktop: {
          open: async () => ({
            url: "https://demo.trycloudflare.com",
            pairingUrl: "https://demo.trycloudflare.com/mobile?pairing=x",
            expiresAt: Date.now() + 600_000,
            mode: "tunnel",
          }),
          close: async () => undefined,
          status: async () => {
            throw new Error("unexpected");
          },
        },
      }),
    );

    await gateway.dispatch(adapter, message("/open"));
    expect(adapter.replies[0]?.message.attachments).toBeUndefined();
  });

  test("drops non-allowlisted senders before invoking CodeShell", async () => {
    let calls = 0;
    const adapter = fakeAdapter();
    const gateway = new ChatGateway({ adapters: [adapter] });
    gateway.use(createAllowlistMiddleware({ telegram: { targetIds: ["other-chat"] } }));
    gateway.use(
      createCodeShellRemoteCommands({
        desktop: {
          open: async () => {
            calls++;
            throw new Error("unexpected");
          },
          close: async () => {
            calls++;
          },
          status: async () => {
            calls++;
            throw new Error("unexpected");
          },
        },
      }),
    );

    await gateway.dispatch(adapter, message("/open"));
    expect(calls).toBe(0);
    expect(adapter.replies).toEqual([]);
  });

  test("opens the tunnel and returns a clickable one-time pairing URL", async () => {
    const adapter = fakeAdapter();
    const pairingUrl = "https://demo.trycloudflare.com/mobile?pairing=one-time";
    const gateway = new ChatGateway({ adapters: [adapter] });
    gateway.use(
      createCodeShellRemoteCommands({
        desktop: {
          open: async () => ({
            url: "https://demo.trycloudflare.com",
            pairingUrl,
            expiresAt: Date.now() + 600_000,
            mode: "tunnel",
          }),
          close: async () => undefined,
          status: async () => ({
            running: true,
            tunnelRunning: true,
            tunnelConnected: true,
            passcodeSet: true,
            onlineDeviceCount: 0,
          }),
        },
      }),
    );

    await gateway.dispatch(adapter, message("/open"));
    expect(adapter.replies[0]?.message.button?.url).toBe(pairingUrl);
    expect(adapter.replies[0]?.message.text).toContain("10 分钟内有效");
    expect(adapter.replies[0]?.message.text).toContain("https://demo.trycloudflare.com");
    expect(adapter.replies[0]?.message.text).not.toContain("pairing=");
  });

  test("reports offline desktop without throwing out of the adapter loop", async () => {
    const adapter = fakeAdapter();
    const gateway = new ChatGateway({ adapters: [adapter] });
    gateway.use(
      createCodeShellRemoteCommands({
        desktop: {
          open: async () => {
            throw new DesktopControlUnavailableError("未就绪");
          },
          close: async () => undefined,
          status: async () => {
            throw new DesktopControlUnavailableError("未就绪");
          },
        },
      }),
    );

    await gateway.dispatch(adapter, message("/status"));
    expect(adapter.replies[0]?.message.text).toContain("桌面端未在线");
  });

  test("routes ordinary text and lazily downloaded media to Mimi Pet", async () => {
    const adapter = fakeAdapter();
    const staleTelegram = {
      ...fakeAdapter({ capabilities: BUILTIN_CHANNEL_CAPABILITIES.teams }),
      channel: "telegram",
    };
    const line = {
      ...fakeAdapter({ capabilities: BUILTIN_CHANNEL_CAPABILITIES.line }),
      channel: "line",
    };
    const gateway = new ChatGateway({ adapters: [adapter] });
    let observed: any;
    gateway.use(
      createMimiPetChat({
        channels: [staleTelegram, line],
        desktop: {
          petChat: async (input) => {
            observed = input;
            return { text: "看到了图片", petSessionId: "pet-1" };
          },
        },
      }),
    );
    await gateway.dispatch(adapter, {
      ...message("帮我看看"),
      attachments: [
        {
          id: "image-1",
          kind: "image",
          name: "shot.png",
          mimeType: "application/octet-stream",
          size: 3,
          load: async () => Uint8Array.from([1, 2, 3]),
        },
      ],
    });
    expect(observed.message).toBe("帮我看看");
    expect(observed.attachments[0]).toMatchObject({
      id: "image-1",
      size: 3,
      dataBase64: "AQID",
      mimeType: "application/octet-stream",
    });
    expect(observed.origin).toMatchObject({ channel: "telegram", senderId: "user-1" });
    expect(observed.origin.capabilities).toEqual({
      inbound: { text: true, attachments: [] },
      outbound: { text: true, maxTextLength: 8_000, button: "link", attachments: [] },
    });
    expect(observed.origin.channels).toEqual([
      {
        channel: "telegram",
        capabilities: observed.origin.capabilities,
      },
      {
        channel: "line",
        capabilities: BUILTIN_CHANNEL_CAPABILITIES.line,
      },
    ]);
    expect(adapter.replies[0]?.message.text).toBe("看到了图片");
  });

  test("delivers image attachments from the Mimi result back to the channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-pet-reply-"));
    try {
      const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
      const imagePath = join(root, "pairing-qr.png");
      await writeFile(imagePath, imageBytes);
      const adapter = fakeAdapter({ capabilities: BUILTIN_CHANNEL_CAPABILITIES.telegram });
      const gateway = new ChatGateway({ adapters: [adapter] });
      gateway.use(
        createMimiPetChat({
          desktop: {
            petChat: async () => ({
              text: "隧道已开启",
              petSessionId: "pet-1",
              attachments: [
                {
                  kind: "image" as const,
                  name: "pairing-qr.png",
                  mimeType: "image/png",
                  size: imageBytes.byteLength,
                  path: imagePath,
                },
              ],
            }),
          },
        }),
      );

      await gateway.dispatch(adapter, message("打开手机遥控隧道"));
      expect(adapter.replies).toHaveLength(1);
      expect(adapter.replies[0]?.message.text).toBe("隧道已开启");
      const attachment = adapter.replies[0]?.message.attachments?.[0];
      expect(attachment?.name).toBe("pairing-qr.png");
      expect(Buffer.from(attachment?.data ?? []).equals(imageBytes)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("delivers a validated GatewayReply button and drops an unsafe one", async () => {
    let button: { text: string; url: string } = {
      text: "打开结果",
      url: "https://example.test/result",
    };
    const adapter = fakeAdapter({ capabilities: BUILTIN_CHANNEL_CAPABILITIES.whatsapp });
    const gateway = new ChatGateway({ adapters: [adapter] });
    gateway.use(
      createMimiPetChat({
        desktop: {
          petChat: async () => ({ text: "处理完成", petSessionId: "pet-1", button }),
        },
      }),
    );

    await gateway.dispatch(adapter, { ...message("第一次"), messageId: "button-valid" });
    expect(adapter.replies[0]?.message).toMatchObject({
      text: "处理完成",
      button: { text: "打开结果", url: "https://example.test/result" },
    });

    button = { text: "危险链接", url: "javascript:alert(1)" };
    await gateway.dispatch(adapter, { ...message("第二次"), messageId: "button-invalid" });
    expect(adapter.replies[1]?.message).toEqual({ text: "处理完成" });
  });

  test("replays the complete enriched reply after adapter.send fails without rerunning Mimi", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-pet-retry-"));
    try {
      const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
      const imagePath = join(root, "pairing-qr.png");
      await writeFile(imagePath, imageBytes);
      let petCalls = 0;
      let sendCalls = 0;
      const delivered: OutgoingMessage[] = [];
      const adapter: ChannelAdapter = {
        channel: "telegram",
        capabilities: BUILTIN_CHANNEL_CAPABILITIES.telegram,
        run: async () => undefined,
        send: async (_target, outgoing) => {
          sendCalls += 1;
          if (sendCalls === 1) throw new Error("temporary adapter failure");
          delivered.push(outgoing);
        },
      };
      const gateway = new ChatGateway({ adapters: [adapter] });
      gateway.use(
        createMimiPetChat({
          desktop: {
            petChat: async () => {
              petCalls += 1;
              return {
                text: "公网隧道已开启：https://demo.trycloudflare.com",
                petSessionId: "pet-1",
                attachments: [
                  {
                    kind: "image" as const,
                    name: "pairing-qr.png",
                    mimeType: "image/png",
                    size: imageBytes.byteLength,
                    path: imagePath,
                  },
                ],
              };
            },
          },
        }),
      );
      const stableMessage = { ...message("打开手机遥控"), messageId: "platform-message-1" };

      await expect(gateway.dispatch(adapter, stableMessage)).rejects.toThrow(
        "temporary adapter failure",
      );
      // The host-local attachment may disappear before DeliveryQueue retries;
      // replay uses the already materialized bytes, not the path again.
      await rm(imagePath);
      await gateway.dispatch(adapter, stableMessage);

      expect(petCalls).toBe(1);
      expect(sendCalls).toBe(2);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.text).toContain("https://demo.trycloudflare.com");
      expect(delivered[0]?.attachments?.[0]).toMatchObject({
        kind: "image",
        name: "pairing-qr.png",
        mimeType: "image/png",
      });
      expect(Buffer.from(delivered[0]?.attachments?.[0]?.data ?? []).equals(imageBytes)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resumes a chunked GatewayReply after the failed chunk without duplicating earlier text", async () => {
    let petCalls = 0;
    let sendCalls = 0;
    const delivered: OutgoingMessage[] = [];
    const adapter: ChannelAdapter = {
      channel: "discord",
      capabilities: BUILTIN_CHANNEL_CAPABILITIES.discord,
      run: async () => undefined,
      send: async (_target, outgoing) => {
        sendCalls += 1;
        if (sendCalls === 2) throw new Error("second chunk failed");
        delivered.push(outgoing);
      },
    };
    const text = `${"a".repeat(1_800)}${"b".repeat(1_800)}tail`;
    const gateway = new ChatGateway({ adapters: [adapter] });
    gateway.use(
      createMimiPetChat({
        desktop: {
          petChat: async () => {
            petCalls += 1;
            return {
              text,
              petSessionId: "pet-1",
              button: { text: "打开", url: "https://example.test/result" },
            };
          },
        },
      }),
    );
    const stable = { ...message("长回复"), channel: "discord", messageId: "chunked-reply" };

    await expect(gateway.dispatch(adapter, stable)).rejects.toThrow("second chunk failed");
    await gateway.dispatch(adapter, stable);

    expect(petCalls).toBe(1);
    expect(delivered.map(({ text: chunk }) => chunk).join("")).toBe(text);
    expect(delivered).toHaveLength(3);
    expect(delivered[0]?.button).toBeUndefined();
    expect(delivered.at(-1)?.button).toEqual({
      text: "打开",
      url: "https://example.test/result",
    });
  });

  test("keeps the text reply and rejects a relative host attachment path", async () => {
    const adapter = fakeAdapter({ capabilities: BUILTIN_CHANNEL_CAPABILITIES.telegram });
    const gateway = new ChatGateway({ adapters: [adapter] });
    gateway.use(
      createMimiPetChat({
        desktop: {
          petChat: async () => ({
            text: "回复文本",
            petSessionId: "pet-1",
            attachments: [
              {
                kind: "image" as const,
                name: "missing.png",
                mimeType: "image/png",
                size: 8,
                path: "relative/missing.png",
              },
            ],
          }),
        },
      }),
    );

    await gateway.dispatch(adapter, message("hi"));
    expect(adapter.replies[0]?.message.text).toBe("回复文本");
    expect(adapter.replies[0]?.message.attachments).toBeUndefined();
  });

  test("skips result attachments silently when the adapter cannot send them", async () => {
    const adapter = fakeAdapter();
    const gateway = new ChatGateway({ adapters: [adapter] });
    gateway.use(
      createMimiPetChat({
        desktop: {
          petChat: async () => ({
            text: "文本",
            petSessionId: "pet-1",
            attachments: [
              {
                kind: "image" as const,
                name: "any.png",
                mimeType: "image/png",
                size: 8,
                path: join(tmpdir(), "unused.png"),
              },
            ],
          }),
        },
      }),
    );

    await gateway.dispatch(adapter, message("hi"));
    expect(adapter.replies[0]?.message.text).toBe("文本");
    expect(adapter.replies[0]?.message.attachments).toBeUndefined();
  });
});

function message(text: string): ChannelMessage {
  return { channel: "telegram", target: "chat-1", senderId: "user-1", text };
}

function fakeAdapter(options: { capabilities?: ChannelCapabilities } = {}): ChannelAdapter & {
  replies: Array<{ target: string; message: OutgoingMessage }>;
} {
  const replies: Array<{ target: string; message: OutgoingMessage }> = [];
  return {
    channel: "telegram",
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    replies,
    run: async () => undefined,
    send: async (target, outgoing) => void replies.push({ target, message: outgoing }),
  };
}

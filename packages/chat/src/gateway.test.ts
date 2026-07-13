import { describe, expect, test } from "bun:test";
import { ChatGateway, createAllowlistMiddleware } from "./chat-gateway.js";
import type { ChannelAdapter, ChannelMessage, OutgoingMessage } from "./channel.js";
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

  test("accepts explicit natural-language control prompts but leaves ambiguous chat to Pet", () => {
    expect(parseGatewayIntent("帮我开一下手机遥控")).toBe("open");
    expect(parseGatewayIntent("请关闭公网入口")).toBe("close");
    expect(parseGatewayIntent("看看手机遥控状态")).toBe("status");
    expect(parseGatewayIntent("为什么要打开手机遥控？")).toBe("unsupported");
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
    const gateway = new ChatGateway({ adapters: [adapter] });
    let observed: any;
    gateway.use(
      createMimiPetChat({
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
    expect(adapter.replies[0]?.message.text).toBe("看到了图片");
  });
});

function message(text: string): ChannelMessage {
  return { channel: "telegram", target: "chat-1", senderId: "user-1", text };
}

function fakeAdapter(): ChannelAdapter & {
  replies: Array<{ target: string; message: OutgoingMessage }>;
} {
  const replies: Array<{ target: string; message: OutgoingMessage }> = [];
  return {
    channel: "telegram",
    replies,
    run: async () => undefined,
    send: async (target, outgoing) => void replies.push({ target, message: outgoing }),
  };
}

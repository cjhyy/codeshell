import { describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isWebhookChannelAdapter,
  type ChannelAdapter,
  type ChannelMessageHandler,
  type OutgoingMessage,
  type WebhookChannelAdapter,
} from "./channel.js";
import type { ConfiguredChannel } from "./config.js";
import {
  ChannelAdapterLoadError,
  createChannelAdapter,
  createChannelAdapterAsync,
} from "./adapter-factory.js";

const telegramConfig = {
  channel: "telegram",
  botToken: "test-token",
  apiBaseUrl: "https://api.telegram.org",
  allowedTargetIds: ["chat-1"],
  allowedUserIds: [],
} satisfies ConfiguredChannel;

describe("channel adapter factory", () => {
  test("contains no eager platform-module imports", async () => {
    const source = await Bun.file(new URL("./adapter-factory.ts", import.meta.url)).text();
    for (const moduleName of [
      "telegram",
      "discord",
      "slack",
      "lark",
      "dingtalk",
      "wecom",
      "wechat",
      "wechat-storage",
      "matrix",
      "mattermost",
      "line",
      "whatsapp",
      "teams",
    ]) {
      expect(source).not.toMatch(
        new RegExp(
          `^import\\s+(?!type\\b)(?:[^;]*?\\sfrom\\s+)?["']\\./${moduleName}\\.js["'];?$`,
          "m",
        ),
      );
    }
  });

  test("the async factory loads only the selected channel module", async () => {
    const loaded: string[] = [];
    const adapter = await createChannelAdapterAsync(telegramConfig, {
      moduleLoader: async (channel) => {
        loaded.push(channel);
        if (channel !== "telegram") throw new Error(`unexpected module: ${channel}`);
        return {
          TelegramAdapter: class extends TestAdapter {
            constructor() {
              super("telegram");
            }
          },
        };
      },
    });

    expect(loaded).toEqual(["telegram"]);
    expect(adapter.channel).toBe("telegram");
  });

  test("the synchronous compatibility factory stays lazy and coalesces concurrent loads", async () => {
    let loadCount = 0;
    const sent: Array<{ target: string; message: OutgoingMessage }> = [];
    const adapter = createChannelAdapter(telegramConfig, {
      moduleLoader: async () => {
        loadCount += 1;
        return {
          TelegramAdapter: class extends TestAdapter {
            constructor() {
              super("telegram", sent);
            }
          },
        };
      },
    });

    expect(loadCount).toBe(0);
    expect(adapter.supportsOutgoingAttachments).toBe(true);
    await Promise.all([
      adapter.send("chat-1", { text: "one" }),
      adapter.send("chat-2", { text: "two" }),
    ]);

    expect(loadCount).toBe(1);
    expect(sent).toEqual([
      { target: "chat-1", message: { text: "one" } },
      { target: "chat-2", message: { text: "two" } },
    ]);
  });

  test("the lazy compatibility proxy exposes webhook metadata before module load", async () => {
    let loadCount = 0;
    let webhookCalls = 0;
    const config = {
      channel: "line",
      channelSecret: "secret",
      channelAccessToken: "token",
      allowedTargetIds: ["owner"],
      allowedUserIds: [],
    } satisfies ConfiguredChannel;
    const adapter = createChannelAdapter(config, {
      moduleLoader: async () => {
        loadCount += 1;
        return {
          LineAdapter: class extends TestAdapter implements WebhookChannelAdapter {
            readonly webhookPath = "/webhooks/line";

            constructor() {
              super("line");
            }

            async handleWebhook(): Promise<void> {
              webhookCalls += 1;
            }
          },
        };
      },
    });

    expect(isWebhookChannelAdapter(adapter)).toBe(true);
    expect((adapter as WebhookChannelAdapter).webhookPath).toBe("/webhooks/line");
    expect(loadCount).toBe(0);
    await (adapter as WebhookChannelAdapter).handleWebhook(
      {} as IncomingMessage,
      {} as ServerResponse,
      async () => undefined,
      1024,
    );
    expect(loadCount).toBe(1);
    expect(webhookCalls).toBe(1);
  });

  test("wraps module-load failures with channel and dependency guidance", async () => {
    const config = {
      channel: "discord",
      botToken: "test-token",
      allowedTargetIds: ["channel-1"],
      allowedUserIds: [],
    } satisfies ConfiguredChannel;
    let caught: unknown;

    try {
      await createChannelAdapterAsync(config, {
        moduleLoader: async () => {
          throw new Error("Cannot find package 'discord.js'");
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ChannelAdapterLoadError);
    expect(caught).toMatchObject({
      name: "ChannelAdapterLoadError",
      code: "CHAT_ADAPTER_LOAD_FAILED",
      channel: "discord",
    });
    expect((caught as Error).message).toContain('chat adapter "discord"');
    expect((caught as Error).message).toContain("discord.js");
    expect((caught as Error).message).toContain("reinstall");
  });
});

class TestAdapter implements ChannelAdapter {
  constructor(
    readonly channel: string,
    private readonly sent: Array<{ target: string; message: OutgoingMessage }> = [],
  ) {}

  async run(_handler: ChannelMessageHandler, _signal: AbortSignal): Promise<void> {}

  async send(target: string, message: OutgoingMessage): Promise<void> {
    this.sent.push({ target, message });
  }
}

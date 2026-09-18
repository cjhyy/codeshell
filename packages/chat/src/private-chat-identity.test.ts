import { describe, expect, test } from "bun:test";
import { ChannelType, Collection } from "discord.js";
import { DiscordAdapter } from "./discord.js";
import { SlackAdapter } from "./slack.js";
import { LarkAdapter } from "./lark.js";
import { WeComAdapter } from "./wecom.js";
import { WechatAdapter } from "./wechat.js";
import { TelegramAdapter } from "./telegram.js";
import { parseDingTalkTextMessage } from "./dingtalk.js";
import type { ChannelMessage } from "./channel.js";

describe("adapter-authenticated private conversation identity", () => {
  test("Slack distinguishes DMs from group DMs and private channels independently of ids", async () => {
    const adapter = new SlackAdapter({ botToken: "test-bot", appToken: "test-app" });
    const socket = (adapter as any).socket;
    const callbacks = new Map<string, (...args: any[]) => Promise<void>>();
    socket.on = (name, callback) => callbacks.set(name, callback);
    socket.off = () => undefined;
    socket.start = async () => undefined;
    socket.disconnect = async () => undefined;
    const abort = new AbortController();
    const messages: ChannelMessage[] = [];
    const running = adapter.run(async (message) => void messages.push(message), abort.signal);
    await Promise.resolve();
    try {
      for (const channel_type of ["im", "mpim", "group", undefined]) {
        await callbacks.get("events_api")!({
          event: {
            type: "message",
            channel: "D-conversation",
            user: "U-owner",
            text: "enter",
            channel_type,
          },
          ack: async () => undefined,
        });
      }
      expect(messages.map((message) => message.isDirectMessage)).toEqual([
        true,
        false,
        false,
        false,
      ]);
      expect(messages[0]?.target).not.toBe(messages[0]?.senderId);

      // A channel merely named "directmessage" cannot impersonate a DM.
      (adapter as any).web.conversations.info = async () => ({ channel: { is_im: false } });
      await callbacks.get("slash_commands")!({
        body: {
          command: "/session",
          channel_id: "C-shared",
          user_id: "U-owner",
          channel_name: "directmessage",
        },
        ack: async () => undefined,
      });
      expect(messages.at(-1)?.isDirectMessage).toBe(false);
      (adapter as any).web.conversations.info = async () => ({ channel: { is_im: true } });
      await callbacks.get("slash_commands")!({
        body: { command: "/session", channel_id: "D-conversation", user_id: "U-owner" },
        ack: async () => undefined,
      });
      expect(messages.at(-1)?.isDirectMessage).toBe(true);
    } finally {
      abort.abort();
      await running;
    }
  });

  test("Discord marks only the DM enum private, excluding GroupDM", async () => {
    const adapter = new DiscordAdapter({ botToken: "test" });
    const client = (adapter as any).client;
    const callbacks = new Map<string, (...args: any[]) => void>();
    client.on = (name, callback) => callbacks.set(name, callback);
    client.off = () => undefined;
    client.login = async () => undefined;
    client.destroy = () => undefined;
    const abort = new AbortController();
    const messages: ChannelMessage[] = [];
    const running = adapter.run(async (message) => void messages.push(message), abort.signal);
    await Promise.resolve();
    try {
      for (const type of [ChannelType.DM, ChannelType.GroupDM, ChannelType.GuildText]) {
        callbacks.get("messageCreate")!({
          author: { id: "owner", bot: false },
          channelId: "conversation",
          channel: { type },
          content: "enter",
          id: `message-${type}`,
          attachments: new Collection(),
        });
      }
      expect(messages.map((message) => message.isDirectMessage)).toEqual([true, false, false]);
    } finally {
      abort.abort();
      await running;
    }
  });

  test("Lark uses chat_type=p2p with its distinct chat and user ids", async () => {
    const adapter = new LarkAdapter({ appId: "test", appSecret: "test" });
    let dispatcher: any;
    (adapter as any).ws.start = async (input) => {
      dispatcher = input.eventDispatcher;
    };
    (adapter as any).ws.close = () => undefined;
    const abort = new AbortController();
    const messages: ChannelMessage[] = [];
    const running = adapter.run(async (message) => void messages.push(message), abort.signal);
    await Promise.resolve();
    try {
      for (const chat_type of ["p2p", "group", undefined]) {
        await dispatcher.invoke(
          {
            schema: "2.0",
            header: { event_type: "im.message.receive_v1" },
            event: {
              sender: { sender_id: { open_id: "ou-owner" } },
              message: {
                chat_id: "oc-conversation",
                chat_type,
                message_type: "text",
                content: '{"text":"enter"}',
              },
            },
          },
          { needCheck: false },
        );
      }
      expect(messages.map((message) => message.isDirectMessage)).toEqual([true, false, false]);
    } finally {
      abort.abort();
      await running;
    }
  });

  test("WeCom uses its single/group message flag", async () => {
    const adapter = new WeComAdapter({ botId: "test", secret: "test" });
    const client = (adapter as any).client;
    const callbacks = new Map<string, (...args: any[]) => void>();
    client.on = (name, callback) => callbacks.set(name, callback);
    client.off = () => undefined;
    client.connect = () => undefined;
    client.disconnect = () => undefined;
    const abort = new AbortController();
    const messages: ChannelMessage[] = [];
    const running = adapter.run(async (message) => void messages.push(message), abort.signal);
    try {
      for (const chattype of ["single", "group", undefined]) {
        callbacks.get("message.text")!({
          body: {
            from: { userid: "owner" },
            chatid: "conversation",
            chattype,
            text: { content: "enter" },
          },
        });
      }
      expect(messages.map((message) => message.isDirectMessage)).toEqual([true, false, false]);
    } finally {
      abort.abort();
      await running;
    }
  });

  test("Telegram requires private chat metadata even when sender and target ids match", async () => {
    const abort = new AbortController();
    const adapter = new TelegramAdapter(
      { botToken: "test" },
      {
        fetch: async () =>
          Response.json({
            ok: true,
            result: ["private", "group", undefined].map((type, index) => ({
              update_id: index + 1,
              message: { text: "enter", from: { id: 123 }, chat: { id: 123, type } },
            })),
          }),
      },
    );
    const messages: ChannelMessage[] = [];
    await adapter.run(async (message) => {
      messages.push(message);
      if (messages.length === 3) abort.abort();
    }, abort.signal);
    expect(messages.map((message) => message.isDirectMessage)).toEqual([true, false, false]);
  });

  test("DingTalk uses conversationType=1 rather than conversation/user id equality", () => {
    const messages = ["1", "2", undefined].map((conversationType) =>
      parseDingTalkTextMessage(
        JSON.stringify({
          msgtype: "text",
          text: { content: "enter" },
          conversationId: "cid-chat",
          senderId: "owner",
          conversationType,
        }),
      ),
    );
    expect(messages.map((message) => message?.isDirectMessage)).toEqual([true, false, false]);
  });

  test("WeChat rejects a group marker despite its sender-addressed transport", () => {
    const adapter = new WechatAdapter({ accountId: "test", token: "test" });
    for (const [group_id, expected] of [
      [undefined, true],
      ["group-1", false],
    ] as const) {
      const message = (adapter as any).normalizeInbound({
        from_user_id: "owner",
        group_id,
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "enter" } }],
      });
      expect(message.isDirectMessage).toBe(expected);
    }
  });
});

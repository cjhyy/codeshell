import * as lark from "@larksuiteoapi/node-sdk";
import type { ChannelAdapter, ChannelMessageHandler, OutgoingMessage } from "./channel.js";
import { dispatchSafely, waitForAbort } from "./lifecycle.js";

export interface LarkAdapterConfig {
  appId: string;
  appSecret: string;
  domain?: string;
}

export class LarkAdapter implements ChannelAdapter {
  readonly channel = "lark";
  private readonly client: lark.Client;
  private readonly ws: lark.WSClient;

  constructor(config: LarkAdapterConfig) {
    const credentials = {
      appId: config.appId,
      appSecret: config.appSecret,
      ...(config.domain ? { domain: config.domain } : {}),
    };
    this.client = new lark.Client(credentials);
    this.ws = new lark.WSClient({ ...credentials, autoReconnect: true });
  }

  async run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (event) => {
        if (event.message.message_type !== "text") return;
        const text = parseLarkText(event.message.content);
        const sender =
          event.sender.sender_id?.open_id ??
          event.sender.sender_id?.user_id ??
          event.sender.sender_id?.union_id;
        if (!text || !sender) return;
        await dispatchSafely(handler, {
          channel: this.channel,
          target: event.message.chat_id,
          senderId: sender,
          text,
        });
      },
    });
    signal.addEventListener("abort", () => this.ws.close({ force: true }), { once: true });
    await this.ws.start({ eventDispatcher: dispatcher });
    await waitForAbort(signal);
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const payload = message.button
      ? {
          msg_type: "interactive" as const,
          content: JSON.stringify({
            config: { wide_screen_mode: true },
            elements: [
              { tag: "div", text: { tag: "plain_text", content: message.text } },
              {
                tag: "action",
                actions: [
                  {
                    tag: "button",
                    type: "primary",
                    text: { tag: "plain_text", content: message.button.text },
                    url: message.button.url,
                  },
                ],
              },
            ],
          }),
        }
      : { msg_type: "text" as const, content: JSON.stringify({ text: message.text }) };
    const result = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: target, ...payload },
    });
    if (result.code !== 0) throw new Error(`飞书发送失败：${result.msg ?? result.code}`);
  }
}

function parseLarkText(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : undefined;
  } catch {
    return undefined;
  }
}

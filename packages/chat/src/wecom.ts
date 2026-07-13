import { WSClient, type TextMessage, type WsFrame } from "@wecom/aibot-node-sdk";
import type { ChannelAdapter, ChannelMessageHandler, OutgoingMessage } from "./channel.js";
import { dispatchSafely, formatOutgoingMarkdown, waitForAbort } from "./lifecycle.js";

export interface WeComAdapterConfig {
  botId: string;
  secret: string;
}

export class WeComAdapter implements ChannelAdapter {
  readonly channel = "wecom";
  private readonly client: WSClient;

  constructor(config: WeComAdapterConfig) {
    this.client = new WSClient({
      botId: config.botId,
      secret: config.secret,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 5,
    });
  }

  async run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    const onMessage = (frame: WsFrame<TextMessage>): void => {
      const message = frame.body;
      if (!message?.text?.content) return;
      void dispatchSafely(handler, {
        channel: this.channel,
        target: message.chatid ?? message.from.userid,
        senderId: message.from.userid,
        text: message.text.content,
      });
    };
    this.client.on("message.text", onMessage);
    this.client.connect();
    try {
      await waitForAbort(signal);
    } finally {
      this.client.off("message.text", onMessage);
      this.client.disconnect();
    }
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    await this.client.sendMessage(target, {
      msgtype: "markdown",
      markdown: { content: formatOutgoingMarkdown(message.text, message.button) },
    });
  }
}

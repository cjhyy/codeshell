import { DWClient, TOPIC_ROBOT, type RobotTextMessage } from "dingtalk-stream";
import type { ChannelAdapter, ChannelMessageHandler, OutgoingMessage } from "./channel.js";
import { dispatchSafely, waitForAbort } from "./lifecycle.js";

export interface DingTalkAdapterConfig {
  clientId: string;
  clientSecret: string;
}

export class DingTalkAdapter implements ChannelAdapter {
  readonly channel = "dingtalk";
  private readonly client: DWClient;
  private readonly responseUrls = new Map<string, string>();

  constructor(
    config: DingTalkAdapterConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.client = new DWClient({ clientId: config.clientId, clientSecret: config.clientSecret });
  }

  async run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    this.client.registerCallbackListener(TOPIC_ROBOT, (frame) => {
      this.client.socketCallBackResponse(frame.headers.messageId, { status: "SUCCESS" });
      let message: RobotTextMessage;
      try {
        message = JSON.parse(frame.data) as RobotTextMessage;
      } catch {
        return;
      }
      if (message.msgtype !== "text" || !message.text?.content) return;
      this.responseUrls.set(message.conversationId, message.sessionWebhook);
      void dispatchSafely(handler, {
        channel: this.channel,
        target: message.conversationId,
        senderId: message.senderStaffId || message.senderId,
        text: message.text.content,
      });
    });
    await this.client.connect();
    try {
      await waitForAbort(signal);
    } finally {
      this.client.disconnect();
    }
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const responseUrl = this.responseUrls.get(target);
    if (!responseUrl) throw new Error(`钉钉会话 ${target} 没有可用的临时回复地址`);
    const body = message.button
      ? {
          msgtype: "actionCard",
          actionCard: {
            title: message.title ?? "Chat message",
            text: message.text,
            singleTitle: message.button.text,
            singleURL: message.button.url,
          },
        }
      : { msgtype: "text", text: { content: message.text } };
    const response = await this.fetchFn(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`钉钉回复失败（HTTP ${response.status}）`);
  }
}

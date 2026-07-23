import { DWClient, TOPIC_ROBOT, type RobotTextMessage } from "dingtalk-stream";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelMessageHandler,
  OutgoingMessage,
} from "./channel.js";
import { BUILTIN_CHANNEL_CAPABILITIES } from "./channel.js";
import { dispatchSafely, waitForAbort } from "./lifecycle.js";

export interface DingTalkAdapterConfig {
  clientId: string;
  clientSecret: string;
  onConnected?: () => void;
}

type DingTalkTextMessage = RobotTextMessage & {
  conversationTitle?: unknown;
};

/** Parse one Stream frame without exposing the SDK client, useful for discovery and tests. */
export function parseDingTalkTextMessage(
  data: string,
  messageId?: string,
): ChannelMessage | undefined {
  let message: DingTalkTextMessage;
  try {
    message = JSON.parse(data) as DingTalkTextMessage;
  } catch {
    return undefined;
  }
  if (message.msgtype !== "text" || !message.text?.content || !message.conversationId) {
    return undefined;
  }
  return {
    channel: "dingtalk",
    target: message.conversationId,
    senderId: message.senderStaffId || message.senderId,
    text: message.text.content,
    ...(messageId ? { messageId } : {}),
    metadata: {
      ...(typeof message.conversationTitle === "string" && message.conversationTitle.trim()
        ? { conversationTitle: message.conversationTitle.trim() }
        : {}),
      ...(typeof message.conversationType === "string"
        ? { conversationType: message.conversationType }
        : {}),
      ...(typeof message.senderNick === "string" && message.senderNick.trim()
        ? { senderName: message.senderNick.trim() }
        : {}),
    },
  };
}

export class DingTalkAdapter implements ChannelAdapter {
  readonly channel = "dingtalk";
  readonly capabilities = BUILTIN_CHANNEL_CAPABILITIES.dingtalk;
  private readonly client: DWClient;
  private readonly onConnected?: () => void;
  private readonly responseUrls = new Map<string, string>();

  constructor(
    config: DingTalkAdapterConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.client = new DWClient({ clientId: config.clientId, clientSecret: config.clientSecret });
    this.onConnected = config.onConnected;
  }

  async run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    this.client.registerCallbackListener(TOPIC_ROBOT, async (frame) => {
      const incoming = parseDingTalkTextMessage(frame.data, frame.headers.messageId);
      if (!incoming) return;
      const message = JSON.parse(frame.data) as RobotTextMessage;
      this.responseUrls.set(incoming.target, message.sessionWebhook);
      // dispatchSafely so a rejected delivery never escapes this stream
      // callback as an unhandled rejection (which would crash the process);
      // the SUCCESS ack below must still run so DingTalk stops redelivering.
      await dispatchSafely(handler, incoming);
      this.client.socketCallBackResponse(frame.headers.messageId, { status: "SUCCESS" });
    });
    await this.client.connect();
    this.onConnected?.();
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

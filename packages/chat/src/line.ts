import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChannelMessageHandler, OutgoingMessage, WebhookChannelAdapter } from "./channel.js";
import { BUILTIN_CHANNEL_CAPABILITIES } from "./channel.js";
import { waitForAbort } from "./lifecycle.js";
import { remoteAttachment, safeAttachmentName } from "./media.js";
import { readRequestBody, sendResponse } from "./webhook.js";

export interface LineAdapterConfig {
  channelSecret: string;
  channelAccessToken: string;
}

interface LineWebhookBody {
  events?: Array<{
    type?: string;
    source?: { userId?: string; groupId?: string; roomId?: string };
    message?: { id?: string; type?: string; text?: string; fileName?: string; fileSize?: number };
  }>;
}

export class LineAdapter implements WebhookChannelAdapter {
  readonly channel = "line";
  readonly capabilities = BUILTIN_CHANNEL_CAPABILITIES.line;
  readonly webhookPath = "/webhooks/line";

  constructor(
    private readonly config: LineAdapterConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  run(_handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    return waitForAbort(signal);
  }

  async handleWebhook(
    request: IncomingMessage,
    response: ServerResponse,
    handler: ChannelMessageHandler,
    maxBodyBytes: number,
  ): Promise<void> {
    if (request.method !== "POST") {
      sendResponse(response, 405, "Method not allowed");
      return;
    }
    const raw = await readRequestBody(request, maxBodyBytes);
    if (!verifyLineSignature(raw, request.headers["x-line-signature"], this.config.channelSecret)) {
      sendResponse(response, 401, "Invalid signature");
      return;
    }
    let body: LineWebhookBody;
    try {
      body = JSON.parse(raw.toString("utf8")) as LineWebhookBody;
    } catch {
      sendResponse(response, 400, "Invalid JSON");
      return;
    }
    const messages = (body.events ?? []).flatMap((event) => {
      const target = event.source?.groupId ?? event.source?.roomId ?? event.source?.userId;
      const senderId = event.source?.userId;
      if (event.type !== "message" || !event.message || !target || !senderId) return [];
      const { id, type } = event.message;
      const mediaKind =
        type === "image"
          ? ("image" as const)
          : type === "audio"
            ? ("audio" as const)
            : type === "video"
              ? ("video" as const)
              : type === "file"
                ? ("file" as const)
                : undefined;
      const attachment =
        id && mediaKind
          ? remoteAttachment({
              id,
              kind: mediaKind,
              name: safeAttachmentName(
                event.message.fileName,
                `line-${id}${mediaKind === "image" ? ".jpg" : mediaKind === "video" ? ".mp4" : ""}`,
              ),
              mimeType:
                mediaKind === "image"
                  ? "image/jpeg"
                  : mediaKind === "video"
                    ? "video/mp4"
                    : undefined,
              size: event.message.fileSize,
              url: `https://api-data.line.me/v2/bot/message/${encodeURIComponent(id)}/content`,
              headers: { authorization: `Bearer ${this.config.channelAccessToken}` },
              fetch: this.fetchFn,
            })
          : undefined;
      const text = type === "text" ? (event.message.text ?? "") : "";
      if (!text && !attachment) return [];
      return [
        {
          channel: this.channel,
          target,
          senderId,
          text,
          ...(id ? { messageId: id } : {}),
          ...(attachment ? { attachments: [attachment] } : {}),
        },
      ];
    });
    await Promise.all(messages.map((message) => handler(message)));
    sendResponse(response, 200, "OK");
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const messages: unknown[] = [{ type: "text", text: message.text }];
    if (message.button) {
      messages.push({
        type: "template",
        altText: message.button.text,
        template: {
          type: "buttons",
          text: "配对入口 10 分钟内有效",
          actions: [{ type: "uri", label: message.button.text, uri: message.button.url }],
        },
      });
    }
    const response = await this.fetchFn("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.channelAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: target, messages }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`LINE 发送失败（HTTP ${response.status}）`);
  }
}

function verifyLineSignature(
  body: Buffer,
  header: string | string[] | undefined,
  secret: string,
): boolean {
  if (typeof header !== "string") return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(header, "base64");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

import * as lark from "@larksuiteoapi/node-sdk";
import type { ChannelAdapter, ChannelMessageHandler, OutgoingMessage } from "./channel.js";
import { BUILTIN_CHANNEL_CAPABILITIES } from "./channel.js";
import { dispatchSafely, waitForAbort } from "./lifecycle.js";
import { OutgoingDeliveryTracker, outgoingAttachments, safeAttachmentName } from "./media.js";

export interface LarkAdapterConfig {
  appId: string;
  appSecret: string;
  domain?: string;
}

export class LarkAdapter implements ChannelAdapter {
  readonly channel = "lark";
  readonly capabilities = BUILTIN_CHANNEL_CAPABILITIES.lark;
  private readonly client: lark.Client;
  private readonly ws: lark.WSClient;
  private readonly delivery = new OutgoingDeliveryTracker();

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
        const messageId = event.message.message_id;
        const content = parseLarkContent(event.message.content);
        const text = event.message.message_type === "text" ? (content.text ?? "") : "";
        const attachment =
          messageId && event.message.message_type !== "text"
            ? this.toAttachment(messageId, event.message.message_type, content)
            : undefined;
        const sender =
          event.sender.sender_id?.open_id ??
          event.sender.sender_id?.user_id ??
          event.sender.sender_id?.union_id;
        if ((!text && !attachment) || !sender) return;
        // dispatchSafely so a rejected delivery never escapes the Lark event
        // dispatcher callback as an unhandled rejection.
        await dispatchSafely(handler, {
          channel: this.channel,
          target: event.message.chat_id,
          senderId: sender,
          text,
          ...(event.message.message_id ? { messageId: event.message.message_id } : {}),
          ...(attachment ? { attachments: [attachment] } : {}),
        });
      },
    });
    signal.addEventListener("abort", () => this.ws.close({ force: true }), { once: true });
    await this.ws.start({ eventDispatcher: dispatcher });
    await waitForAbort(signal);
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const attachments = outgoingAttachments(message, this.capabilities.outbound.attachments);
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
    await this.delivery.run(message, () => [
      ...(message.text || message.button ? [() => this.createMessage(target, payload)] : []),
      ...attachments.map((attachment) => () => this.sendAttachment(target, attachment)),
    ]);
  }

  private toAttachment(messageId: string, messageType: string, content: Record<string, string>) {
    const key = content.image_key ?? content.file_key;
    if (!key || !["image", "file", "audio", "media"].includes(messageType)) return undefined;
    const kind =
      messageType === "image"
        ? ("image" as const)
        : messageType === "audio"
          ? ("audio" as const)
          : messageType === "media"
            ? ("video" as const)
            : ("file" as const);
    const name = safeAttachmentName(
      content.file_name,
      `lark-${messageId}${kind === "image" ? ".jpg" : kind === "audio" ? ".opus" : kind === "video" ? ".mp4" : ""}`,
    );
    return {
      id: `${messageId}:${key}`,
      kind,
      name,
      ...(kind === "image"
        ? { mimeType: "image/jpeg" }
        : kind === "audio"
          ? { mimeType: "audio/ogg" }
          : kind === "video"
            ? { mimeType: "video/mp4" }
            : {}),
      load: (signal?: AbortSignal) =>
        this.loadMessageResource(
          messageId,
          key,
          messageType === "image" ? "image" : "file",
          signal,
        ),
    };
  }

  private async loadMessageResource(
    messageId: string,
    fileKey: string,
    type: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (signal?.aborted) throw signal.reason;
    const resource = await this.client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const raw of resource.getReadableStream()) {
      if (signal?.aborted) throw signal.reason;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      total += chunk.byteLength;
      if (total > 10 * 1024 * 1024) throw new Error("飞书附件超过大小限制");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }

  private async sendAttachment(
    target: string,
    attachment: NonNullable<OutgoingMessage["attachments"]>[number],
  ): Promise<void> {
    if (attachment.kind === "image") {
      const uploaded = await this.client.im.v1.image.create({
        data: { image_type: "message", image: Buffer.from(attachment.data) },
      });
      if (!uploaded?.image_key) throw new Error("飞书图片上传未返回 image_key");
      await this.createMessage(target, {
        msg_type: "image",
        content: JSON.stringify({ image_key: uploaded.image_key }),
      });
      return;
    }
    const extension = attachment.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    const fileType =
      attachment.kind === "audio" && ["opus", "ogg"].includes(extension ?? "")
        ? "opus"
        : attachment.kind === "video" && extension === "mp4"
          ? "mp4"
          : extension === "pdf"
            ? "pdf"
            : ["doc", "docx"].includes(extension ?? "")
              ? "doc"
              : ["xls", "xlsx"].includes(extension ?? "")
                ? "xls"
                : ["ppt", "pptx"].includes(extension ?? "")
                  ? "ppt"
                  : "stream";
    const uploaded = await this.client.im.v1.file.create({
      data: {
        file_type: fileType,
        file_name: attachment.name,
        file: Buffer.from(attachment.data),
      },
    });
    if (!uploaded?.file_key) throw new Error("飞书文件上传未返回 file_key");
    const msgType = fileType === "opus" ? "audio" : fileType === "mp4" ? "media" : "file";
    await this.createMessage(target, {
      msg_type: msgType,
      content: JSON.stringify({ file_key: uploaded.file_key }),
    });
  }

  private async createMessage(
    target: string,
    payload: { msg_type: string; content: string },
  ): Promise<void> {
    const result = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: target, ...payload },
    });
    if (result.code !== 0) throw new Error(`飞书发送失败：${result.msg ?? result.code}`);
  }
}

function parseLarkContent(content: string): Record<string, string> {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

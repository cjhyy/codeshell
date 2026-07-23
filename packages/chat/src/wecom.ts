import {
  WSClient,
  type BaseMessage,
  type FileMessage,
  type ImageMessage,
  type MixedMessage,
  type TextMessage,
  type VideoMessage,
  type VoiceMessage,
  type WsFrame,
} from "@wecom/aibot-node-sdk";
import type {
  ChannelAdapter,
  ChannelMessageHandler,
  ChatAttachment,
  OutgoingMessage,
} from "./channel.js";
import { BUILTIN_CHANNEL_CAPABILITIES } from "./channel.js";
import { dispatchSafely, formatOutgoingMarkdown, waitForAbort } from "./lifecycle.js";
import { OutgoingDeliveryTracker, outgoingAttachments, safeAttachmentName } from "./media.js";

export interface WeComAdapterConfig {
  botId: string;
  secret: string;
}

export class WeComAdapter implements ChannelAdapter {
  readonly channel = "wecom";
  readonly capabilities = BUILTIN_CHANNEL_CAPABILITIES.wecom;
  private readonly client: WSClient;
  private readonly delivery = new OutgoingDeliveryTracker();

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
        ...((frame as { headers?: { req_id?: string } }).headers?.req_id
          ? { messageId: (frame as { headers: { req_id: string } }).headers.req_id }
          : {}),
      });
    };
    const onImage = (frame: WsFrame<ImageMessage>): void => this.dispatchMedia(frame, handler);
    const onMixed = (frame: WsFrame<MixedMessage>): void => this.dispatchMedia(frame, handler);
    const onVoice = (frame: WsFrame<VoiceMessage>): void => this.dispatchMedia(frame, handler);
    const onFile = (frame: WsFrame<FileMessage>): void => this.dispatchMedia(frame, handler);
    const onVideo = (frame: WsFrame<VideoMessage>): void => this.dispatchMedia(frame, handler);
    this.client.on("message.text", onMessage);
    this.client.on("message.image", onImage);
    this.client.on("message.mixed", onMixed);
    this.client.on("message.voice", onVoice);
    this.client.on("message.file", onFile);
    this.client.on("message.video", onVideo);
    this.client.connect();
    try {
      await waitForAbort(signal);
    } finally {
      this.client.off("message.text", onMessage);
      this.client.off("message.image", onImage);
      this.client.off("message.mixed", onMixed);
      this.client.off("message.voice", onVoice);
      this.client.off("message.file", onFile);
      this.client.off("message.video", onVideo);
      this.client.disconnect();
    }
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const attachments = outgoingAttachments(message, this.capabilities.outbound.attachments);
    await this.delivery.run(message, () => [
      ...(message.text || message.button
        ? [
            () =>
              this.client
                .sendMessage(target, {
                  msgtype: "markdown",
                  markdown: { content: formatOutgoingMarkdown(message.text, message.button) },
                })
                .then(() => undefined),
          ]
        : []),
      ...attachments.map((attachment) => async () => {
        const type =
          attachment.kind === "image" ? "image" : attachment.kind === "video" ? "video" : "file";
        const uploaded = await this.client.uploadMedia(Buffer.from(attachment.data), {
          type,
          filename: safeAttachmentName(attachment.name),
        });
        await this.client.sendMediaMessage(
          target,
          type,
          uploaded.media_id,
          type === "video" ? { title: attachment.name } : undefined,
        );
      }),
    ]);
  }

  private dispatchMedia(frame: WsFrame<BaseMessage>, handler: ChannelMessageHandler): void {
    const message = frame.body;
    if (!message?.from?.userid) return;
    const attachments: ChatAttachment[] = [];
    let text = "";
    if (message.msgtype === "image") {
      const image = (message as ImageMessage).image;
      if (image?.url)
        attachments.push(this.downloadable(message.msgid, "image", image.url, image.aeskey));
    } else if (message.msgtype === "file") {
      const file = (message as FileMessage).file;
      if (file?.url)
        attachments.push(this.downloadable(message.msgid, "file", file.url, file.aeskey));
    } else if (message.msgtype === "video") {
      const video = (message as VideoMessage).video;
      if (video?.url)
        attachments.push(this.downloadable(message.msgid, "video", video.url, video.aeskey));
    } else if (message.msgtype === "voice") {
      // The current WeCom AI Bot protocol exposes voice transcription but no
      // downloadable voice URL, so preserve the useful text without claiming
      // an inbound audio attachment.
      text = (message as VoiceMessage).voice?.content ?? "";
    } else if (message.msgtype === "mixed") {
      for (const [index, item] of (message as MixedMessage).mixed?.msg_item.entries() ?? []) {
        if (item.msgtype === "text") text += item.text?.content ?? "";
        if (item.msgtype === "image" && item.image?.url) {
          attachments.push(
            this.downloadable(
              `${message.msgid}:${index}`,
              "image",
              item.image.url,
              item.image.aeskey,
            ),
          );
        }
      }
    }
    if (!text && attachments.length === 0) return;
    void dispatchSafely(handler, {
      channel: this.channel,
      target: message.chatid ?? message.from.userid,
      senderId: message.from.userid,
      text,
      messageId: message.msgid,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }

  private downloadable(
    id: string,
    kind: "image" | "file" | "video",
    url: string,
    aesKey?: string,
  ): ChatAttachment {
    return {
      id,
      kind,
      name: `wecom-${id}${kind === "image" ? ".jpg" : kind === "video" ? ".mp4" : ""}`,
      ...(kind === "image"
        ? { mimeType: "image/jpeg" }
        : kind === "video"
          ? { mimeType: "video/mp4" }
          : {}),
      load: async (signal) => {
        if (signal?.aborted) throw signal.reason;
        const downloaded = await this.client.downloadFile(url, aesKey);
        if (downloaded.buffer.byteLength > 10 * 1024 * 1024) {
          throw new Error("企业微信附件超过大小限制");
        }
        return downloaded.buffer;
      },
    };
  }
}

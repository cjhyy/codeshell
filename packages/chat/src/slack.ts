import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { ChannelAdapter, ChannelMessageHandler, OutgoingMessage } from "./channel.js";
import { BUILTIN_CHANNEL_CAPABILITIES } from "./channel.js";
import { dispatchSafely, formatOutgoingMarkdown, waitForAbort } from "./lifecycle.js";
import { mediaKind, outgoingAttachments, remoteAttachment } from "./media.js";

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
}

export class SlackAdapter implements ChannelAdapter {
  readonly channel = "slack";
  readonly capabilities = BUILTIN_CHANNEL_CAPABILITIES.slack;
  private readonly socket: SocketModeClient;
  private readonly web: WebClient;
  private readonly botToken: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: SlackAdapterConfig, fetchFn: typeof fetch = fetch) {
    this.socket = new SocketModeClient({ appToken: config.appToken });
    this.web = new WebClient(config.botToken);
    this.botToken = config.botToken;
    this.fetchFn = fetchFn;
  }

  async run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    const onEvent = async ({ event, ack }: any): Promise<void> => {
      if (
        event?.type !== "message" ||
        typeof event.channel !== "string" ||
        typeof event.user !== "string" ||
        event.bot_id ||
        (event.subtype && event.subtype !== "file_share")
      ) {
        await ack();
        return;
      }
      const files = Array.isArray(event.files) ? (event.files as SlackFile[]) : [];
      const attachments = files.flatMap((file) => {
        const url = file.url_private_download ?? file.url_private;
        if (!file.id || !url) return [];
        return [
          remoteAttachment({
            id: file.id,
            kind: mediaKind(file.mimetype, file.name),
            name: file.name,
            mimeType: file.mimetype,
            size: file.size,
            url,
            headers: { authorization: `Bearer ${this.botToken}` },
            fetch: this.fetchFn,
          }),
        ];
      });
      const text = typeof event.text === "string" ? event.text : "";
      if (!text && attachments.length === 0) {
        await ack();
        return;
      }
      // dispatchSafely so a rejected delivery (e.g. inbox backpressure) never
      // escapes this SocketMode listener as an unhandled rejection — emit does
      // not await listeners, so an unhandled rejection would crash the process
      // and skip the ack below.
      await dispatchSafely(handler, {
        channel: this.channel,
        target: event.channel,
        senderId: event.user,
        text,
        ...(event.client_msg_id || event.ts
          ? { messageId: String(event.client_msg_id ?? event.ts) }
          : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      await ack();
    };
    const onCommand = async ({ body, ack }: any): Promise<void> => {
      if (
        typeof body.command !== "string" ||
        typeof body.channel_id !== "string" ||
        typeof body.user_id !== "string"
      ) {
        await ack();
        return;
      }
      await dispatchSafely(handler, {
        channel: this.channel,
        target: body.channel_id,
        senderId: body.user_id,
        text: [body.command, typeof body.text === "string" ? body.text : ""]
          .filter(Boolean)
          .join(" "),
        ...(body.trigger_id ? { messageId: String(body.trigger_id) } : {}),
      });
      await ack();
    };
    this.socket.on("events_api", onEvent);
    this.socket.on("slash_commands", onCommand);
    await this.socket.start();
    try {
      await waitForAbort(signal);
    } finally {
      this.socket.off("events_api", onEvent);
      this.socket.off("slash_commands", onCommand);
      await this.socket.disconnect();
    }
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const attachments = outgoingAttachments(message, this.capabilities.outbound.attachments);
    if (attachments.length > 0) {
      // Slack's v2 upload can publish all files and the comment atomically,
      // avoiding a text-first partial send that would duplicate on retry.
      await this.web.filesUploadV2({
        channel_id: target,
        initial_comment: formatOutgoingMarkdown(message.text, message.button),
        file_uploads: attachments.map((attachment) => ({
          file: Buffer.from(attachment.data),
          filename: attachment.name,
        })),
      });
      return;
    }
    await this.web.chat.postMessage({
      channel: target,
      text: message.text,
      ...(message.button
        ? {
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: message.text } },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: message.button.text },
                    url: message.button.url,
                  },
                ],
              },
            ],
          }
        : {}),
    });
  }
}

interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

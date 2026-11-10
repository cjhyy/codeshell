import type { ChannelRunLifecycle } from "./channel.js";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type {
  ChannelAdapter,
  ChannelMessageHandler,
  ChannelSendOptions,
  OutgoingMessage,
} from "./channel.js";
import { BUILTIN_CHANNEL_CAPABILITIES, NotDeliveredError } from "./channel.js";
import { dispatchSafely, formatOutgoingMarkdown, waitForAbort } from "./lifecycle.js";
import { mediaKind, outgoingAttachments, remoteAttachment } from "./media.js";

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
}

export class SlackAdapter implements ChannelAdapter {
  readonly channel = "slack";
  readonly capabilities = BUILTIN_CHANNEL_CAPABILITIES.slack;
  readonly combinesTextAndAttachmentsAtomically = true;
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

  async run(
    handler: ChannelMessageHandler,
    signal: AbortSignal,
    lifecycle?: ChannelRunLifecycle,
  ): Promise<void> {
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
      // SocketMode does not await listeners. Catch admission errors without
      // acknowledging them: Slack must be able to retry an unpersisted event.
      const accepted = await dispatchSafely(handler, {
        channel: this.channel,
        target: event.channel,
        senderId: event.user,
        isDirectMessage: event.channel_type === "im",
        text,
        ...(event.client_msg_id || event.ts
          ? { messageId: String(event.client_msg_id ?? event.ts) }
          : {}),
        // Replies must carry the parent thread_ts, or Slack posts them at the
        // channel top level instead of in the thread the user is using.
        ...(typeof event.thread_ts === "string" && event.thread_ts
          ? { threadId: event.thread_ts }
          : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      if (accepted) await ack();
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
      // A user can name a channel "directmessage"; only Slack's conversation
      // metadata can distinguish a DM from a private channel or group DM.
      const isDirectMessage = await this.web.conversations
        .info({ channel: body.channel_id })
        .then(({ channel }) => channel?.is_im === true)
        .catch(() => false);
      const accepted = await dispatchSafely(handler, {
        channel: this.channel,
        target: body.channel_id,
        senderId: body.user_id,
        isDirectMessage,
        text: [body.command, typeof body.text === "string" ? body.text : ""]
          .filter(Boolean)
          .join(" "),
        ...(body.trigger_id ? { messageId: String(body.trigger_id) } : {}),
      });
      if (accepted) await ack();
    };
    this.socket.on("events_api", onEvent);
    this.socket.on("slash_commands", onCommand);
    const onReady = () => lifecycle?.ready();
    const onUnavailable = () => lifecycle?.unavailable();
    this.socket.on("connected", onReady);
    this.socket.on("disconnected", onUnavailable);
    try {
      await this.socket.start();
      lifecycle?.ready();
      await waitForAbort(signal);
    } finally {
      this.socket.off("connected", onReady);
      this.socket.off("disconnected", onUnavailable);
      this.socket.off("events_api", onEvent);
      this.socket.off("slash_commands", onCommand);
      await this.socket.disconnect();
    }
  }

  async send(
    target: string,
    message: OutgoingMessage,
    options: ChannelSendOptions = {},
  ): Promise<void> {
    try {
      await this.sendOnce(target, message, options);
    } catch (error) {
      // Slack answered with an error (channel_not_found, not_in_channel,
      // invalid_auth, rate limited, HTTP 4xx): nothing was posted.
      const { code, statusCode } = (error ?? {}) as { code?: unknown; statusCode?: unknown };
      const refused =
        code === "slack_webapi_platform_error" ||
        code === "slack_webapi_rate_limited_error" ||
        (code === "slack_webapi_http_error" &&
          typeof statusCode === "number" &&
          statusCode >= 400 &&
          statusCode < 500);
      if (refused)
        throw new NotDeliveredError(error instanceof Error ? error.message : String(error), {
          cause: error,
        });
      throw error;
    }
  }

  private async sendOnce(
    target: string,
    message: OutgoingMessage,
    options: ChannelSendOptions,
  ): Promise<void> {
    const attachments = outgoingAttachments(message, this.capabilities.outbound.attachments);
    const thread = options.threadId ? { thread_ts: options.threadId } : {};
    if (attachments.length > 0) {
      // Slack's v2 upload can publish all files and the comment atomically,
      // avoiding a text-first partial send that would duplicate on retry.
      await this.web.filesUploadV2({
        channel_id: target,
        ...thread,
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
      ...thread,
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

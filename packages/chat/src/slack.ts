import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { ChannelAdapter, ChannelMessageHandler, OutgoingMessage } from "./channel.js";
import { dispatchSafely, waitForAbort } from "./lifecycle.js";

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
}

export class SlackAdapter implements ChannelAdapter {
  readonly channel = "slack";
  private readonly socket: SocketModeClient;
  private readonly web: WebClient;

  constructor(config: SlackAdapterConfig) {
    this.socket = new SocketModeClient({ appToken: config.appToken });
    this.web = new WebClient(config.botToken);
  }

  async run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    const onEvent = async ({ event, ack }: any): Promise<void> => {
      await ack();
      if (
        event?.type !== "message" ||
        typeof event.channel !== "string" ||
        typeof event.user !== "string" ||
        typeof event.text !== "string" ||
        event.bot_id ||
        event.subtype
      ) {
        return;
      }
      await dispatchSafely(handler, {
        channel: this.channel,
        target: event.channel,
        senderId: event.user,
        text: event.text,
      });
    };
    const onCommand = async ({ body, ack }: any): Promise<void> => {
      await ack();
      if (
        typeof body.command !== "string" ||
        typeof body.channel_id !== "string" ||
        typeof body.user_id !== "string"
      ) {
        return;
      }
      await dispatchSafely(handler, {
        channel: this.channel,
        target: body.channel_id,
        senderId: body.user_id,
        text: [body.command, typeof body.text === "string" ? body.text : ""]
          .filter(Boolean)
          .join(" "),
      });
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

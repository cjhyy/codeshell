import WebSocket, { type RawData } from "ws";
import type { ChannelAdapter, ChannelMessageHandler, OutgoingMessage } from "./channel.js";
import { dispatchSafely, formatOutgoingMarkdown } from "./lifecycle.js";

export interface MattermostAdapterConfig {
  serverUrl: string;
  botToken: string;
  botUserId?: string;
}

interface MattermostEvent {
  event?: string;
  data?: {
    post?: string | MattermostPost;
    error?: { message?: string };
  };
}

interface MattermostPost {
  id?: string;
  channel_id?: string;
  user_id?: string;
  message?: string;
}

export class MattermostAdapter implements ChannelAdapter {
  readonly channel = "mattermost";

  constructor(
    private readonly config: MattermostAdapterConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    let retryMs = 1_000;
    while (!signal.aborted) {
      try {
        await this.connect(handler, signal);
        retryMs = 1_000;
      } catch {
        if (signal.aborted) return;
        await abortableDelay(retryMs, signal);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    }
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const response = await this.fetchFn(`${this.config.serverUrl}/api/v4/posts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channel_id: target,
        message: formatOutgoingMarkdown(message.text, message.button),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? `Mattermost 发送失败（HTTP ${response.status}）`);
    }
  }

  private connect(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(toWebSocketUrl(this.config.serverUrl));
      let opened = false;
      const abort = () => socket.close();
      signal.addEventListener("abort", abort, { once: true });
      socket.once("open", () => {
        opened = true;
        socket.send(
          JSON.stringify({
            seq: 1,
            action: "authentication_challenge",
            data: { token: this.config.botToken },
          }),
        );
      });
      socket.on("message", (raw) => this.onMessage(raw, handler, socket));
      socket.once("error", (error) => {
        if (!opened) reject(error);
      });
      socket.once("close", () => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
    });
  }

  private onMessage(raw: RawData, handler: ChannelMessageHandler, socket: WebSocket): void {
    let event: MattermostEvent;
    try {
      event = JSON.parse(raw.toString()) as MattermostEvent;
    } catch {
      return;
    }
    if (event.data?.error?.message) {
      socket.close(1008, "authentication failed");
      return;
    }
    if (event.event !== "posted" || !event.data?.post) return;
    let post: MattermostPost;
    try {
      post =
        typeof event.data.post === "string"
          ? (JSON.parse(event.data.post) as MattermostPost)
          : event.data.post;
    } catch {
      return;
    }
    if (
      !post.channel_id ||
      !post.user_id ||
      !post.message ||
      post.user_id === this.config.botUserId
    ) {
      return;
    }
    void dispatchSafely(handler, {
      channel: this.channel,
      target: post.channel_id,
      senderId: post.user_id,
      text: post.message,
      ...(post.id ? { messageId: post.id } : {}),
    });
  }
}

function toWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/v4/websocket`;
  return url.toString();
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

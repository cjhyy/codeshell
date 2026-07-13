import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelMessageHandler,
  OutgoingMessage,
} from "./channel.js";
import { dispatchSafely } from "./lifecycle.js";

export interface MatrixAdapterConfig {
  homeserverUrl: string;
  accessToken: string;
  botUserId?: string;
}

interface MatrixSyncResponse {
  next_batch?: string;
  rooms?: {
    join?: Record<
      string,
      {
        timeline?: {
          events?: Array<{
            type?: string;
            sender?: string;
            origin_server_ts?: number;
            content?: { msgtype?: string; body?: string };
          }>;
        };
      }
    >;
  };
}

export class MatrixAdapter implements ChannelAdapter {
  readonly channel = "matrix";

  constructor(
    private readonly config: MatrixAdapterConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    let since: string | undefined;
    let retryMs = 1_000;
    while (!signal.aborted) {
      try {
        const query = new URLSearchParams({ timeout: "30000" });
        if (since) query.set("since", since);
        const sync = await this.call<MatrixSyncResponse>(`/_matrix/client/v3/sync?${query}`, {
          method: "GET",
          signal,
        });
        retryMs = 1_000;
        since = sync.next_batch ?? since;
        for (const message of toMessages(sync, this.config.botUserId)) {
          await dispatchSafely(handler, message);
        }
      } catch (error) {
        if (signal.aborted) return;
        await abortableDelay(retryMs, signal);
        retryMs = Math.min(retryMs * 2, 30_000);
        if (error instanceof MatrixRateLimitError && error.retryAfterMs) {
          retryMs = Math.max(retryMs, error.retryAfterMs);
        }
      }
    }
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const body = message.button ? `${message.text}\n\n${message.button.text}` : message.text;
    await this.call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(target)}/send/m.room.message/${crypto.randomUUID()}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          msgtype: "m.text",
          body,
          ...(message.button
            ? {
                format: "org.matrix.custom.html",
                formatted_body: `${escapeHtml(message.text).replaceAll("\n", "<br>")}<br><br><a href="${escapeHtml(message.button.url)}">${escapeHtml(message.button.text)}</a>`,
              }
            : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchFn(`${this.config.homeserverUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        ...init.headers,
      },
    });
    const body = (await response.json().catch(() => ({}))) as {
      errcode?: string;
      error?: string;
      retry_after_ms?: number;
    };
    if (!response.ok) {
      if (response.status === 429) {
        throw new MatrixRateLimitError(body.error ?? "Matrix 请求过于频繁", body.retry_after_ms);
      }
      throw new Error(body.error ?? `Matrix 请求失败（HTTP ${response.status}）`);
    }
    return body as T;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

class MatrixRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

function toMessages(sync: MatrixSyncResponse, botUserId?: string): ChannelMessage[] {
  const messages: ChannelMessage[] = [];
  const now = Date.now();
  for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
    for (const event of room.timeline?.events ?? []) {
      if (
        event.type !== "m.room.message" ||
        event.content?.msgtype !== "m.text" ||
        typeof event.content.body !== "string" ||
        !event.sender ||
        event.sender === botUserId ||
        (event.origin_server_ts !== undefined && now - event.origin_server_ts > 5 * 60_000)
      ) {
        continue;
      }
      messages.push({
        channel: "matrix",
        target: roomId,
        senderId: event.sender,
        text: event.content.body,
      });
    }
  }
  return messages;
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

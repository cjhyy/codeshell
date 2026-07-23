import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelMessageHandler,
  OutgoingMessage,
} from "./channel.js";
import { BUILTIN_CHANNEL_CAPABILITIES } from "./channel.js";
import {
  downloadRemoteAttachment,
  OutgoingDeliveryTracker,
  outgoingAttachments,
  safeAttachmentName,
} from "./media.js";

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
            event_id?: string;
            type?: string;
            sender?: string;
            origin_server_ts?: number;
            content?: MatrixEventContent;
          }>;
        };
      }
    >;
  };
}

interface MatrixEventContent {
  msgtype?: string;
  body?: string;
  filename?: string;
  url?: string;
  info?: { mimetype?: string; size?: number };
}

export class MatrixAdapter implements ChannelAdapter {
  readonly channel = "matrix";
  readonly capabilities = BUILTIN_CHANNEL_CAPABILITIES.matrix;
  private readonly delivery = new OutgoingDeliveryTracker();

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
        for (const message of this.toMessages(sync)) {
          await handler(message);
        }
        // Matrix tokens acknowledge the whole sync batch. Advance only after
        // every accepted event has reached the durable inbox.
        since = sync.next_batch ?? since;
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
    const attachments = outgoingAttachments(message, this.capabilities.outbound.attachments);
    const body = message.button ? `${message.text}\n\n${message.button.text}` : message.text;
    await this.delivery.run(message, () => [
      ...(body
        ? [
            () =>
              this.sendRoomMessage(target, {
                msgtype: "m.text",
                body,
                ...(message.button
                  ? {
                      format: "org.matrix.custom.html",
                      formatted_body: `${escapeHtml(message.text).replaceAll("\n", "<br>")}<br><br><a href="${escapeHtml(message.button.url)}">${escapeHtml(message.button.text)}</a>`,
                    }
                  : {}),
              }).then(() => undefined),
          ]
        : []),
      ...attachments.map((attachment) => async () => {
        const contentUri = await this.uploadAttachment(attachment);
        await this.sendRoomMessage(target, {
          msgtype:
            attachment.kind === "image"
              ? "m.image"
              : attachment.kind === "audio"
                ? "m.audio"
                : attachment.kind === "video"
                  ? "m.video"
                  : "m.file",
          body: attachment.name,
          filename: attachment.name,
          url: contentUri,
          info: { mimetype: attachment.mimeType, size: attachment.data.byteLength },
        });
      }),
    ]);
  }

  private sendRoomMessage(target: string, content: Record<string, unknown>): Promise<unknown> {
    return this.call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(target)}/send/m.room.message/${crypto.randomUUID()}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(content),
        signal: AbortSignal.timeout(15_000),
      },
    );
  }

  private async uploadAttachment(
    attachment: NonNullable<OutgoingMessage["attachments"]>[number],
  ): Promise<string> {
    const query = new URLSearchParams({ filename: safeAttachmentName(attachment.name) });
    const result = await this.call<{ content_uri?: string }>(`/_matrix/media/v3/upload?${query}`, {
      method: "POST",
      headers: { "content-type": attachment.mimeType },
      body: new Uint8Array(attachment.data),
      signal: AbortSignal.timeout(30_000),
    });
    if (!result.content_uri) throw new Error("Matrix 媒体上传未返回 content_uri");
    return result.content_uri;
  }

  private toMessages(sync: MatrixSyncResponse): ChannelMessage[] {
    const messages: ChannelMessage[] = [];
    const now = Date.now();
    for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
      for (const event of room.timeline?.events ?? []) {
        const content = event.content;
        if (
          event.type !== "m.room.message" ||
          !content?.msgtype ||
          !event.sender ||
          event.sender === this.config.botUserId ||
          (event.origin_server_ts !== undefined && now - event.origin_server_ts > 5 * 60_000)
        ) {
          continue;
        }
        const kind =
          content.msgtype === "m.image"
            ? ("image" as const)
            : content.msgtype === "m.audio"
              ? ("audio" as const)
              : content.msgtype === "m.video"
                ? ("video" as const)
                : content.msgtype === "m.file"
                  ? ("file" as const)
                  : undefined;
        const attachment =
          kind && content.url
            ? this.matrixAttachment(event.event_id ?? `${roomId}:${content.url}`, kind, {
                ...content,
                url: content.url,
              })
            : undefined;
        const text = content.msgtype === "m.text" ? (content.body ?? "") : "";
        if (!text && !attachment) continue;
        messages.push({
          channel: "matrix",
          target: roomId,
          senderId: event.sender,
          text,
          ...(event.event_id ? { messageId: event.event_id } : {}),
          ...(attachment ? { attachments: [attachment] } : {}),
        });
      }
    }
    return messages;
  }

  private matrixAttachment(
    id: string,
    kind: "image" | "file" | "audio" | "video",
    content: MatrixEventContent & { url: string },
  ) {
    const url = matrixMediaUrl(this.config.homeserverUrl, content.url);
    return {
      id,
      kind,
      name: safeAttachmentName(content.filename ?? content.body, `matrix-${id}`),
      ...(content.info?.mimetype ? { mimeType: content.info.mimetype } : {}),
      ...(content.info?.size !== undefined ? { size: content.info.size } : {}),
      load: (signal?: AbortSignal) =>
        downloadRemoteAttachment(this.fetchFn, url, {
          headers: { authorization: `Bearer ${this.config.accessToken}` },
          ...(signal ? { signal } : {}),
          allowPrivateNetwork: true,
        }),
    };
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

function matrixMediaUrl(homeserverUrl: string, mxc: string): string {
  if (!mxc.startsWith("mxc://")) throw new Error("Matrix 媒体 URI 无效");
  const path = mxc.slice("mxc://".length).split("/").map(encodeURIComponent).join("/");
  return `${homeserverUrl}/_matrix/client/v1/media/download/${path}`;
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

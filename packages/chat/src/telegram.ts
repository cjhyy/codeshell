import type {
  ChannelAdapter,
  ChatAttachment,
  ChannelMessage,
  ChannelMessageHandler,
  OutgoingMessage,
} from "./channel.js";
import { BUILTIN_CHANNEL_CAPABILITIES } from "./channel.js";
import { OutgoingDeliveryTracker, outgoingAttachments } from "./media.js";

export interface TelegramAdapterConfig {
  botToken: string;
  apiBaseUrl?: string;
}

const DEFAULT_MAX_MESSAGE_AGE_MS = 5 * 60_000;

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    caption?: string;
    message_id?: number;
    date?: number;
    chat: { id: number | string };
    from?: { id: number | string };
    sender_chat?: { id: number | string };
    photo?: TelegramPhoto[];
    document?: TelegramMedia;
    audio?: TelegramMedia;
    voice?: TelegramMedia;
    video?: TelegramMedia;
  };
}

interface TelegramMedia {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramPhoto extends TelegramMedia {
  width?: number;
  height?: number;
}

interface TelegramFileResult {
  file_path?: string;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramAdapterOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
  maxMessageAgeMs?: number;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly channel = "telegram";
  readonly capabilities = BUILTIN_CHANNEL_CAPABILITIES.telegram;
  private readonly delivery = new OutgoingDeliveryTracker();
  readonly supportsOutgoingAttachments = true;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly maxMessageAgeMs: number;
  private readonly apiBaseUrl: string;

  constructor(
    private readonly config: TelegramAdapterConfig,
    opts: TelegramAdapterOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
    this.sleepFn = opts.sleep ?? abortableDelay;
    this.log = opts.log ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.maxMessageAgeMs = opts.maxMessageAgeMs ?? DEFAULT_MAX_MESSAGE_AGE_MS;
    this.apiBaseUrl = config.apiBaseUrl?.replace(/\/$/, "") ?? "https://api.telegram.org";
  }

  async run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    let offset: number | undefined;
    let retryMs = 1_000;

    while (!signal.aborted) {
      try {
        const updates = await this.call<TelegramUpdate[]>(
          "getUpdates",
          {
            offset,
            timeout: 30,
            allowed_updates: ["message"],
          },
          signal,
        );
        retryMs = 1_000;
        for (const update of updates) {
          const nextOffset = Math.max(offset ?? 0, update.update_id + 1);
          if (isStale(update, this.now(), this.maxMessageAgeMs)) {
            offset = nextOffset;
            continue;
          }
          const message = toChannelMessage(update, (fileId, signal) =>
            this.downloadFile(fileId, signal),
          );
          if (!message) {
            offset = nextOffset;
            continue;
          }
          try {
            await handler(message);
            // Commit the platform cursor only after ChatGateway has durably
            // accepted the delivery. A full/broken inbox is retried by Telegram.
            offset = nextOffset;
          } catch (error) {
            this.log(
              `Telegram update ${update.update_id} 处理失败，${retryMs}ms 后重试：${this.redact(formatError(error))}`,
            );
            // Back off before re-polling. The offset is intentionally NOT
            // advanced, so getUpdates returns the same pending batch instantly;
            // without a delay the loop would hot-spin and hammer the API (and
            // spam the log) until Telegram rate-limits us. Mirror the outer
            // error path's backoff so a persistently-full inbox settles down.
            await this.sleepFn(retryMs, signal).catch(() => undefined);
            retryMs = Math.min(retryMs * 2, 30_000);
            break;
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        this.log(
          `Telegram long polling 失败，${retryMs}ms 后重试：${this.redact(formatError(error))}`,
        );
        await this.sleepFn(retryMs, signal).catch(() => undefined);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    }
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const attachments = outgoingAttachments(message, this.capabilities.outbound.attachments);
    await this.delivery.run(message, () => [
      ...(message.text || message.button
        ? [
            () =>
              this.call(
                "sendMessage",
                {
                  chat_id: target,
                  text: message.text,
                  ...(message.button
                    ? {
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: message.button.text, url: message.button.url }],
                          ],
                        },
                      }
                    : {}),
                },
                AbortSignal.timeout(15_000),
              ).then(() => undefined),
          ]
        : []),
      ...attachments.map((attachment) => async () => {
        if (
          attachment.kind === "image" &&
          !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(attachment.mimeType)
        ) {
          throw new Error("Telegram 待发送图片的类型不受支持");
        }
        const media = telegramOutboundMethod(attachment.kind, attachment.mimeType);
        const form = new FormData();
        const bytes = new Uint8Array(attachment.data.byteLength);
        bytes.set(attachment.data);
        form.set("chat_id", target);
        form.set(media.field, new Blob([bytes], { type: attachment.mimeType }), attachment.name);
        await this.callMultipart(media.method, form, AbortSignal.timeout(30_000));
      }),
    ]);
  }

  private async call<T>(method: string, body: unknown, signal: AbortSignal): Promise<T> {
    const response = await this.fetchFn(`${this.apiBaseUrl}/bot${this.config.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    return this.readResponse<T>(method, response);
  }

  private async callMultipart<T>(method: string, body: FormData, signal: AbortSignal): Promise<T> {
    const response = await this.fetchFn(`${this.apiBaseUrl}/bot${this.config.botToken}/${method}`, {
      method: "POST",
      body,
      signal,
    });
    return this.readResponse<T>(method, response);
  }

  private async readResponse<T>(method: string, response: Response): Promise<T> {
    let result: TelegramResponse<T>;
    try {
      result = (await response.json()) as TelegramResponse<T>;
    } catch {
      throw new Error(`Telegram ${method} 返回无效 JSON（HTTP ${response.status}）`);
    }
    if (!response.ok || !result.ok) {
      throw new Error(result.description ?? `Telegram ${method} 失败（HTTP ${response.status}）`);
    }
    return result.result as T;
  }

  private async downloadFile(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const file = await this.call<TelegramFileResult>(
      "getFile",
      { file_id: fileId },
      signal ?? AbortSignal.timeout(30_000),
    );
    if (!file.file_path) throw new Error("Telegram getFile 未返回文件路径");
    const response = await this.fetchFn(
      `${this.apiBaseUrl}/file/bot${this.config.botToken}/${file.file_path}`,
      { signal: signal ?? AbortSignal.timeout(30_000) },
    );
    if (!response.ok) throw new Error(`Telegram 文件下载失败（HTTP ${response.status}）`);
    return readBoundedResponse(response, 10 * 1024 * 1024);
  }

  private redact(message: string): string {
    return message.split(this.config.botToken).join("[REDACTED]");
  }
}

function telegramOutboundMethod(kind: string, mimeType: string): { method: string; field: string } {
  if (kind === "audio") return { method: "sendAudio", field: "audio" };
  if (kind === "video") return { method: "sendVideo", field: "video" };
  if (kind === "file" || mimeType === "image/webp") {
    return { method: "sendDocument", field: "document" };
  }
  return mimeType === "image/gif"
    ? { method: "sendAnimation", field: "animation" }
    : { method: "sendPhoto", field: "photo" };
}

function isStale(update: TelegramUpdate, now: number, maxAgeMs: number): boolean {
  const sentAtSeconds = update.message?.date;
  return typeof sentAtSeconds === "number" && now - sentAtSeconds * 1_000 > maxAgeMs;
}

function toChannelMessage(
  update: TelegramUpdate,
  download: (fileId: string, signal?: AbortSignal) => Promise<Uint8Array>,
): ChannelMessage | undefined {
  const message = update.message;
  if (!message) return undefined;
  const sender = message.from?.id ?? message.sender_chat?.id;
  if (sender === undefined) return undefined;
  const attachments = telegramAttachments(message, download);
  const text = message.text ?? message.caption ?? "";
  if (!text && attachments.length === 0) return undefined;
  return {
    channel: "telegram",
    target: String(message.chat.id),
    senderId: String(sender),
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(message.message_id === undefined ? {} : { messageId: String(message.message_id) }),
  };
}

function telegramAttachments(
  message: NonNullable<TelegramUpdate["message"]>,
  download: (fileId: string, signal?: AbortSignal) => Promise<Uint8Array>,
): ChatAttachment[] {
  const specs: Array<{ media: TelegramMedia; kind: ChatAttachment["kind"]; fallback: string }> = [];
  const photo = [...(message.photo ?? [])].sort(
    (a, b) =>
      (b.file_size ?? (b.width ?? 0) * (b.height ?? 0)) -
      (a.file_size ?? (a.width ?? 0) * (a.height ?? 0)),
  )[0];
  if (photo) specs.push({ media: photo, kind: "image", fallback: "telegram-photo.jpg" });
  if (message.document)
    specs.push({ media: message.document, kind: "file", fallback: "telegram-file" });
  if (message.audio)
    specs.push({ media: message.audio, kind: "audio", fallback: "telegram-audio" });
  if (message.voice)
    specs.push({ media: message.voice, kind: "audio", fallback: "telegram-voice.ogg" });
  if (message.video)
    specs.push({ media: message.video, kind: "video", fallback: "telegram-video.mp4" });
  return specs.map(({ media, kind, fallback }) => ({
    id: media.file_unique_id ?? media.file_id,
    kind,
    name: media.file_name ?? fallback,
    ...(media.mime_type
      ? { mimeType: media.mime_type }
      : kind === "image"
        ? { mimeType: "image/jpeg" }
        : {}),
    ...(media.file_size === undefined ? {} : { size: media.file_size }),
    load: (signal) => download(media.file_id, signal),
  }));
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error("Telegram 附件超过大小限制");
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Telegram 附件超过大小限制");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Telegram 附件超过大小限制");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

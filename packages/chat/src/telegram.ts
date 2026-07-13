import type {
  ChannelAdapter,
  ChatAttachment,
  ChannelMessage,
  ChannelMessageHandler,
  OutgoingMessage,
} from "./channel.js";

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
          offset = Math.max(offset ?? 0, update.update_id + 1);
          if (isStale(update, this.now(), this.maxMessageAgeMs)) continue;
          const message = toChannelMessage(update, (fileId, signal) =>
            this.downloadFile(fileId, signal),
          );
          if (!message) continue;
          try {
            await handler(message);
          } catch (error) {
            this.log(
              `Telegram update ${update.update_id} 处理失败：${this.redact(formatError(error))}`,
            );
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
    await this.call(
      "sendMessage",
      {
        chat_id: target,
        text: message.text,
        ...(message.button
          ? {
              reply_markup: {
                inline_keyboard: [[{ text: message.button.text, url: message.button.url }]],
              },
            }
          : {}),
      },
      AbortSignal.timeout(15_000),
    );
  }

  private async call<T>(method: string, body: unknown, signal: AbortSignal): Promise<T> {
    const response = await this.fetchFn(`${this.apiBaseUrl}/bot${this.config.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
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

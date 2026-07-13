import { createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type {
  ChatAttachment,
  ChannelAdapter,
  ChannelMessage,
  ChannelMessageHandler,
  OutgoingMessage,
} from "./channel.js";
import type { WechatAdapterState, WechatCredentials, WechatStateStore } from "./wechat-storage.js";
export * from "./wechat-storage.js";

export const WECHAT_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const WECHAT_PROTOCOL_VERSION = "2.4.6";
export const WECHAT_DEFAULT_BOT_AGENT = "CodeShellChat/0.7.1";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_MESSAGE_AGE_MS = 5 * 60_000;
const DEFAULT_BOT_TYPE = "3";
const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_GENERATING = 1;
const MESSAGE_STATE_FINISH = 2;
const ITEM_TYPE_TEXT = 1;
const ITEM_TYPE_IMAGE = 2;
const ITEM_TYPE_VOICE = 3;
const ITEM_TYPE_FILE = 4;
const ITEM_TYPE_VIDEO = 5;
const WECHAT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

interface WechatCdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  full_url?: string;
}

interface WechatImageItem {
  media?: WechatCdnMedia;
  aeskey?: string;
  url?: string;
}

interface WechatVoiceItem {
  media?: WechatCdnMedia;
  text?: string;
  encode_type?: number;
}

interface WechatFileItem {
  media?: WechatCdnMedia;
  file_name?: string;
  len?: string;
}

interface WechatVideoItem {
  media?: WechatCdnMedia;
}

interface WechatMessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: WechatImageItem;
  voice_item?: WechatVoiceItem;
  file_item?: WechatFileItem;
  video_item?: WechatVideoItem;
}

interface WechatWireMessage {
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WechatMessageItem[];
  context_token?: string;
}

interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WechatWireMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface BasicResponse {
  ret?: number;
  errmsg?: string;
}

export interface WechatAdapterConfig {
  accountId: string;
  token: string;
  baseUrl?: string;
  botAgent?: string;
  protocolVersion?: string;
  /** Only enable for an explicitly trusted self-hosted compatible backend. */
  allowUnsafeBaseUrl?: boolean;
}

export interface WechatAdapterOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
  stateStore?: WechatStateStore;
  now?: () => number;
  maxMessageAgeMs?: number;
}

/** Personal WeChat ClawBot adapter using Tencent's documented iLink Bot HTTP protocol. */
export class WechatAdapter implements ChannelAdapter {
  readonly channel = "wechat";
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: NonNullable<WechatAdapterOptions["sleep"]>;
  private readonly log: NonNullable<WechatAdapterOptions["log"]>;
  private readonly stateStore?: WechatStateStore;
  private readonly now: () => number;
  private readonly maxMessageAgeMs: number;
  private readonly baseUrl: string;
  private readonly protocolVersion: string;
  private readonly botAgent: string;
  private state: WechatAdapterState = { contextTokens: {} };
  private stateReady?: Promise<void>;
  private readonly seenMessageIds = new Set<string>();

  constructor(
    private readonly config: WechatAdapterConfig,
    options: WechatAdapterOptions = {},
  ) {
    if (!config.accountId.trim()) throw new Error("微信 accountId 不能为空");
    if (!config.token.trim()) throw new Error("微信 bot token 不能为空");
    this.baseUrl = validateWechatBaseUrl(
      config.baseUrl ?? WECHAT_DEFAULT_BASE_URL,
      config.allowUnsafeBaseUrl ?? false,
    );
    this.protocolVersion = config.protocolVersion ?? WECHAT_PROTOCOL_VERSION;
    this.botAgent = sanitizeBotAgent(config.botAgent ?? WECHAT_DEFAULT_BOT_AGENT);
    this.fetchFn = options.fetch ?? fetch;
    this.sleepFn = options.sleep ?? abortableDelay;
    this.log = options.log ?? (() => undefined);
    this.stateStore = options.stateStore;
    this.now = options.now ?? Date.now;
    this.maxMessageAgeMs = options.maxMessageAgeMs ?? DEFAULT_MESSAGE_AGE_MS;
  }

  async run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    await this.ensureState();
    await this.notifyLifecycle("notifystart");
    let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    let retryMs = 1_000;
    try {
      while (!signal.aborted) {
        try {
          const response = await this.post<GetUpdatesResponse>(
            "ilink/bot/getupdates",
            {
              get_updates_buf: this.state.cursor ?? "",
              base_info: this.baseInfo(),
            },
            nextTimeoutMs,
            signal,
          );
          retryMs = 1_000;
          if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
            nextTimeoutMs = response.longpolling_timeout_ms;
          }
          const errorCode = response.errcode || response.ret;
          if (errorCode && errorCode !== 0) {
            if (errorCode === -14) {
              throw new Error("微信登录已失效，请重新执行 code-shell-chat wechat login");
            }
            throw new Error(`微信 getUpdates 失败：${response.errmsg ?? `ret=${errorCode}`}`);
          }
          if (response.get_updates_buf) {
            this.state.cursor = response.get_updates_buf;
            await this.persistState();
          }
          for (const raw of response.msgs ?? []) {
            const message = this.normalizeInbound(raw);
            if (!message || this.isDuplicate(message.messageId)) continue;
            if (raw.context_token) {
              this.state.contextTokens ??= {};
              this.state.contextTokens[message.target] = raw.context_token;
              await this.persistState();
            }
            try {
              await handler(message);
            } catch (error) {
              this.log(
                `微信消息处理失败：${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof WechatRequestTimeoutError) continue;
          this.log(
            `微信长轮询失败，${retryMs}ms 后重试：${error instanceof Error ? error.message : String(error)}`,
          );
          await this.sleepFn(retryMs, signal);
          retryMs = Math.min(retryMs * 2, 30_000);
        }
      }
    } finally {
      await this.notifyLifecycle("notifystop");
    }
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    await this.ensureState();
    const text = message.button
      ? `${message.text}\n\n${message.button.text}: ${message.button.url}`
      : message.text;
    const response = await this.post<BasicResponse>(
      "ilink/bot/sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: target,
          client_id: `code-shell-chat-${randomUUID()}`,
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text } }],
          context_token: this.state.contextTokens?.[target],
        },
        base_info: this.baseInfo(),
      },
      15_000,
    );
    if (response.ret && response.ret !== 0) {
      throw new Error(`微信发送失败：${response.errmsg ?? `ret=${response.ret}`}`);
    }
  }

  private normalizeInbound(raw: WechatWireMessage): ChannelMessage | undefined {
    if (raw.message_type !== undefined && raw.message_type !== MESSAGE_TYPE_USER) return undefined;
    if (raw.message_state === MESSAGE_STATE_GENERATING) return undefined;
    const senderId = raw.from_user_id?.trim();
    if (!senderId) return undefined;
    if (
      raw.create_time_ms !== undefined &&
      this.maxMessageAgeMs >= 0 &&
      this.now() - raw.create_time_ms > this.maxMessageAgeMs
    ) {
      return undefined;
    }
    const items = raw.item_list ?? [];
    const text = items
      .flatMap((item) => {
        if (item.type === ITEM_TYPE_TEXT && item.text_item?.text) return [item.text_item.text];
        if (item.type === ITEM_TYPE_VOICE && item.voice_item?.text) return [item.voice_item.text];
        return [];
      })
      .join("\n")
      .trim();
    const attachments = items.flatMap((item, index) => {
      const attachment = this.toAttachment(raw, item, index);
      return attachment ? [attachment] : [];
    });
    if (!text && attachments.length === 0) return undefined;
    return {
      channel: this.channel,
      target: senderId,
      senderId,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      messageId: raw.message_id === undefined ? undefined : String(raw.message_id),
      metadata: compactRecord({
        accountId: this.config.accountId,
        toUserId: raw.to_user_id,
        sessionId: raw.session_id,
        groupId: raw.group_id,
        createTimeMs: raw.create_time_ms,
      }),
    };
  }

  private toAttachment(
    message: WechatWireMessage,
    item: WechatMessageItem,
    index: number,
  ): ChatAttachment | undefined {
    const id = item.msg_id ?? `${message.message_id ?? "wechat"}-${index}`;
    if (item.type === ITEM_TYPE_IMAGE && item.image_item?.media) {
      return {
        id,
        kind: "image",
        name: "wechat-image.jpg",
        mimeType: "image/jpeg",
        load: (signal) =>
          this.downloadMedia(item.image_item!.media!, item.image_item?.aeskey, signal),
      };
    }
    if (item.type === ITEM_TYPE_VOICE && item.voice_item?.media) {
      return {
        id,
        kind: "audio",
        name: item.voice_item.encode_type === 7 ? "wechat-voice.mp3" : "wechat-voice.silk",
        mimeType: item.voice_item.encode_type === 7 ? "audio/mpeg" : "audio/silk",
        load: (signal) => this.downloadMedia(item.voice_item!.media!, undefined, signal),
      };
    }
    if (item.type === ITEM_TYPE_FILE && item.file_item?.media) {
      const declaredSize = Number(item.file_item.len);
      return {
        id,
        kind: "file",
        name: item.file_item.file_name ?? "wechat-file",
        mimeType: "application/octet-stream",
        ...(Number.isSafeInteger(declaredSize) && declaredSize >= 0 ? { size: declaredSize } : {}),
        load: (signal) => this.downloadMedia(item.file_item!.media!, undefined, signal),
      };
    }
    if (item.type === ITEM_TYPE_VIDEO && item.video_item?.media) {
      return {
        id,
        kind: "video",
        name: "wechat-video.mp4",
        mimeType: "video/mp4",
        load: (signal) => this.downloadMedia(item.video_item!.media!, undefined, signal),
      };
    }
    return undefined;
  }

  private async downloadMedia(
    media: WechatCdnMedia,
    preferredHexKey?: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const url = resolveWechatCdnUrl(media);
    const response = await this.fetchFn(url, {
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`微信附件下载失败（HTTP ${response.status}）`);
    const encrypted = await readBoundedWechatResponse(response, 10 * 1024 * 1024 + 16);
    const key = decodeWechatAesKey(preferredHexKey, media.aes_key);
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  private isDuplicate(messageId: string | undefined): boolean {
    if (!messageId) return false;
    if (this.seenMessageIds.has(messageId)) return true;
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > 1_000) {
      const oldest = this.seenMessageIds.values().next().value;
      if (oldest) this.seenMessageIds.delete(oldest);
    }
    return false;
  }

  private ensureState(): Promise<void> {
    this.stateReady ??= (async () => {
      const stored = await this.stateStore?.load();
      this.state = {
        cursor: stored?.cursor,
        contextTokens: { ...(stored?.contextTokens ?? {}) },
      };
    })();
    return this.stateReady;
  }

  private async persistState(): Promise<void> {
    await this.stateStore?.save({
      cursor: this.state.cursor,
      contextTokens: { ...(this.state.contextTokens ?? {}) },
    });
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return { channel_version: this.protocolVersion, bot_agent: this.botAgent };
  }

  private post<T>(
    endpoint: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return requestWechatJson<T>({
      fetchFn: this.fetchFn,
      baseUrl: this.baseUrl,
      endpoint,
      method: "POST",
      body,
      token: this.config.token,
      timeoutMs,
      signal,
      protocolVersion: this.protocolVersion,
    });
  }

  private async notifyLifecycle(action: "notifystart" | "notifystop"): Promise<void> {
    try {
      const response = await this.post<BasicResponse>(
        `ilink/bot/msg/${action}`,
        { base_info: this.baseInfo() },
        10_000,
      );
      if (response.ret && response.ret !== 0) {
        this.log(`微信 ${action} 返回 ret=${response.ret}：${response.errmsg ?? ""}`);
      }
    } catch (error) {
      this.log(
        `微信 ${action} 失败（已忽略）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function resolveWechatCdnUrl(media: WechatCdnMedia): string {
  const raw = media.full_url?.trim()
    ? media.full_url
    : media.encrypt_query_param
      ? `${WECHAT_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
      : "";
  if (!raw) throw new Error("微信附件缺少 CDN 下载参数");
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("微信附件 CDN 地址必须使用 HTTPS");
  return url.toString();
}

function decodeWechatAesKey(
  preferredHexKey: string | undefined,
  encoded: string | undefined,
): Buffer {
  if (preferredHexKey && /^[a-f0-9]{32}$/i.test(preferredHexKey)) {
    return Buffer.from(preferredHexKey, "hex");
  }
  if (!encoded) throw new Error("微信附件缺少 AES 密钥");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength === 16) return decoded;
  const asText = decoded.toString("utf-8");
  if (/^[a-f0-9]{32}$/i.test(asText)) return Buffer.from(asText, "hex");
  throw new Error("微信附件 AES 密钥格式无效");
}

async function readBoundedWechatResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("微信附件超过大小限制");
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("微信附件超过大小限制");
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
      throw new Error("微信附件超过大小限制");
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QrStatusResponse {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface WechatQrLoginOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  apiBaseUrl?: string;
  botType?: string;
  protocolVersion?: string;
  localTokens?: string[];
  allowUnsafeBaseUrl?: boolean;
  onQrCode?: (url: string) => void | Promise<void>;
  onStatus?: (status: QrStatus) => void;
  requestVerificationCode?: () => Promise<string>;
}

export interface WechatQrLoginResult {
  connected: boolean;
  alreadyConnected?: boolean;
  credentials?: WechatCredentials;
}

/** QR login flow compatible with Tencent's official ClawBot plugin protocol. */
export async function loginWechatWithQr(
  options: WechatQrLoginOptions = {},
): Promise<WechatQrLoginResult> {
  const fetchFn = options.fetch ?? fetch;
  const sleepFn = options.sleep ?? abortableDelay;
  const signal = options.signal ?? new AbortController().signal;
  const timeoutMs = Math.max(options.timeoutMs ?? 8 * 60_000, 1_000);
  const deadline = Date.now() + timeoutMs;
  const protocolVersion = options.protocolVersion ?? WECHAT_PROTOCOL_VERSION;
  const initialBaseUrl = validateWechatBaseUrl(
    options.apiBaseUrl ?? WECHAT_DEFAULT_BASE_URL,
    options.allowUnsafeBaseUrl ?? false,
  );
  let pollingBaseUrl = initialBaseUrl;
  let refreshCount = 0;
  let pendingVerificationCode: string | undefined;

  const fetchQrCode = async (): Promise<QrCodeResponse> => {
    const response = await requestWechatJson<QrCodeResponse>({
      fetchFn,
      baseUrl: initialBaseUrl,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(options.botType ?? DEFAULT_BOT_TYPE)}`,
      method: "POST",
      body: { local_token_list: options.localTokens ?? [] },
      timeoutMs: 15_000,
      signal,
      protocolVersion,
    });
    if (!response.qrcode || !response.qrcode_img_content) {
      throw new Error("微信服务未返回有效二维码");
    }
    await options.onQrCode?.(response.qrcode_img_content);
    return response;
  };

  let qr = await fetchQrCode();
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("微信登录已取消");
    try {
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`;
      if (pendingVerificationCode) {
        endpoint += `&verify_code=${encodeURIComponent(pendingVerificationCode)}`;
      }
      const response = await requestWechatJson<QrStatusResponse>({
        fetchFn,
        baseUrl: pollingBaseUrl,
        endpoint,
        method: "GET",
        timeoutMs: Math.min(DEFAULT_LONG_POLL_TIMEOUT_MS, Math.max(deadline - Date.now(), 1_000)),
        signal,
        protocolVersion,
        commonHeadersOnly: true,
      });
      options.onStatus?.(response.status);
      if (response.status === "confirmed") {
        if (!response.bot_token || !response.ilink_bot_id) {
          throw new Error("微信登录成功响应缺少 bot token 或 accountId");
        }
        const baseUrl = validateWechatBaseUrl(
          response.baseurl || pollingBaseUrl,
          options.allowUnsafeBaseUrl ?? false,
        );
        return {
          connected: true,
          credentials: {
            accountId: response.ilink_bot_id,
            token: response.bot_token,
            baseUrl,
            userId: response.ilink_user_id,
          },
        };
      }
      if (response.status === "binded_redirect") {
        return { connected: false, alreadyConnected: true };
      }
      if (response.status === "scaned_but_redirect" && response.redirect_host) {
        pollingBaseUrl = validateWechatBaseUrl(
          `https://${response.redirect_host}`,
          options.allowUnsafeBaseUrl ?? false,
        );
      } else if (response.status === "need_verifycode") {
        if (!options.requestVerificationCode) {
          throw new Error("手机微信要求输入验证数字，但未提供 requestVerificationCode");
        }
        pendingVerificationCode = (await options.requestVerificationCode()).trim();
        if (!pendingVerificationCode) throw new Error("微信验证数字不能为空");
        continue;
      } else if (response.status === "scaned") {
        pendingVerificationCode = undefined;
      } else if (response.status === "expired" || response.status === "verify_code_blocked") {
        refreshCount += 1;
        if (refreshCount >= 3) throw new Error("微信二维码或验证码多次失效");
        pendingVerificationCode = undefined;
        pollingBaseUrl = initialBaseUrl;
        qr = await fetchQrCode();
      }
    } catch (error) {
      if (signal.aborted) throw new Error("微信登录已取消", { cause: error });
      if (!(error instanceof WechatRequestTimeoutError)) throw error;
    }
    await sleepFn(1_000, signal);
  }
  throw new Error("微信登录超时，请重试");
}

interface WechatRequestOptions {
  fetchFn: typeof fetch;
  baseUrl: string;
  endpoint: string;
  method: "GET" | "POST";
  body?: unknown;
  token?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  protocolVersion: string;
  commonHeadersOnly?: boolean;
}

class WechatRequestTimeoutError extends Error {}

async function requestWechatJson<T>(options: WechatRequestOptions): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await options.fetchFn(
      new URL(options.endpoint, `${options.baseUrl.replace(/\/$/, "")}/`),
      {
        method: options.method,
        headers: buildWechatHeaders({
          token: options.token,
          protocolVersion: options.protocolVersion,
          commonOnly: options.commonHeadersOnly,
        }),
        ...(options.method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`微信 API 返回 HTTP ${response.status}`);
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new Error("微信 API 返回了无效 JSON", { cause: error });
    }
  } catch (error) {
    if (timedOut) throw new WechatRequestTimeoutError("微信 API 请求超时", { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function buildWechatHeaders(options: {
  token?: string;
  protocolVersion: string;
  commonOnly?: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(encodeClientVersion(options.protocolVersion)),
  };
  if (options.commonOnly) return headers;
  headers["Content-Type"] = "application/json";
  headers.AuthorizationType = "ilink_bot_token";
  headers["X-WECHAT-UIN"] = Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString(
    "base64",
  );
  if (options.token?.trim()) headers.Authorization = `Bearer ${options.token.trim()}`;
  return headers;
}

function encodeClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function sanitizeBotAgent(value: string): string {
  const ascii = value.replace(/[^\x20-\x7e]/g, "").trim();
  return ascii && Buffer.byteLength(ascii, "utf8") <= 256 ? ascii : WECHAT_DEFAULT_BOT_AGENT;
}

function validateWechatBaseUrl(value: string, allowUnsafe: boolean): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !allowUnsafe) {
    throw new Error("微信 API baseUrl 必须使用 HTTPS");
  }
  const official = url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com");
  if (!official && !allowUnsafe) {
    throw new Error(`拒绝将微信 bot token 发送到非官方域名：${url.hostname}`);
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function compactRecord(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
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

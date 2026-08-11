import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ChatAttachment,
  ChannelAdapter,
  ChannelMessage,
  ChannelMessageHandler,
  OutgoingMessage,
} from "./channel.js";
import { BUILTIN_CHANNEL_CAPABILITIES } from "./channel.js";
import { OutgoingDeliveryTracker, outgoingAttachments } from "./media.js";
import {
  normalizeWechatAccountId,
  WechatStateOwnershipError,
  type WechatAdapterState,
  type WechatCredentials,
  type WechatStateStore,
} from "./wechat-storage.js";
export * from "./wechat-storage.js";

export const WECHAT_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const WECHAT_PROTOCOL_VERSION = "2.4.6";
export const WECHAT_DEFAULT_BOT_AGENT = "CodeShellChat/0.7.1";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_MESSAGE_AGE_MS = 5 * 60_000;
const DEFAULT_RATE_LIMIT_RETRIES = 2;
const DEFAULT_RATE_LIMIT_RETRY_BASE_MS = 500;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;
const WECHAT_CDN_UPLOAD_ATTEMPTS = 3;
const WECHAT_CDN_UPLOAD_RETRY_BASE_MS = 250;
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
const WECHAT_CDN_DOWNLOAD_HOSTS = new Set([
  "novac2c.cdn.weixin.qq.com",
  "ilinkai.weixin.qq.com",
  "wx.qlogo.cn",
  "thirdwx.qlogo.cn",
  "res.wx.qq.com",
  "mmbiz.qpic.cn",
  "mmbiz.qlogo.cn",
]);
const WECHAT_CDN_MAX_REDIRECTS = 5;

interface WechatCdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

interface WechatImageItem {
  media?: WechatCdnMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
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
  video_size?: number;
  play_length?: number;
  video_md5?: string;
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
  errcode?: number;
  errmsg?: string;
}

interface GetUploadUrlResponse extends BasicResponse {
  upload_full_url?: string;
  upload_param?: string;
}

interface UploadedWechatMedia {
  plaintextSize: number;
  ciphertextSize: number;
  keyHex: string;
  encryptedQueryParam: string;
}

export interface WechatAdapterConfig {
  accountId: string;
  token: string;
  baseUrl?: string;
  botAgent?: string;
  protocolVersion?: string;
  /** Only enable for an explicitly trusted self-hosted compatible backend. */
  allowUnsafeBaseUrl?: boolean;
  /**
   * Exact extra hostnames trusted for inbound media downloads, extending the
   * built-in WeChat CDN allowlist (e.g. a regional CDN variant). Downloads
   * stay HTTPS-only; this never affects the API baseUrl trust decision.
   */
  extraCdnDownloadHosts?: readonly string[];
}

export interface WechatAdapterOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
  stateStore?: WechatStateStore;
  now?: () => number;
  maxMessageAgeMs?: number;
  /** Retries only explicit platform rate-limit responses, reusing client_id. */
  rateLimitRetries?: number;
  rateLimitRetryBaseMs?: number;
  /** Account-wide cooldown after explicit rate-limit retries are exhausted. */
  rateLimitCooldownMs?: number;
}

export interface WechatDirectSendResult {
  channel: "wechat";
  target: string;
  status: "accepted";
  /** iLink acknowledges API acceptance, not display on the recipient device. */
  terminalDeliveryConfirmed: false;
  /** True when the helper reused the adapter already long-polling this account. */
  viaLiveAdapter: boolean;
}

const accountSendTails = new Map<string, Promise<void>>();
const rateLimitCooldownUntil = new Map<string, number>();
const liveWechatAdapters = new Map<string, { credentialKey: string; adapter: WechatAdapter }>();

/** Personal WeChat ClawBot adapter using Tencent's documented iLink Bot HTTP protocol. */
export class WechatAdapter implements ChannelAdapter {
  readonly channel = "wechat";
  readonly capabilities = BUILTIN_CHANNEL_CAPABILITIES.wechat;
  readonly supportsOutgoingAttachments = true;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: NonNullable<WechatAdapterOptions["sleep"]>;
  private readonly log: NonNullable<WechatAdapterOptions["log"]>;
  private readonly stateStore?: WechatStateStore;
  private readonly now: () => number;
  private readonly maxMessageAgeMs: number;
  private readonly rateLimitRetries: number;
  private readonly rateLimitRetryBaseMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly accountKey: string;
  private readonly credentialKey: string;
  private readonly extraCdnDownloadHosts: ReadonlySet<string>;
  private readonly baseUrl: string;
  private readonly protocolVersion: string;
  private readonly botAgent: string;
  private state: WechatAdapterState = { contextTokens: {} };
  private stateReady?: Promise<void>;
  private stateWrite: Promise<void> = Promise.resolve();
  /** Set once the state file is owned by a newer QR binding; never cleared. */
  private staleCredential = false;
  /** Preserve visible ordering and keep context/media state mutations single-writer. */
  private outboundQueue: Promise<void> = Promise.resolve();
  private readonly seenMessageIds = new Set<string>();
  /** Cursor whose batch was rejected by the handler and therefore must retry even after max age. */
  private heldCursor?: string;
  private readonly delivery = new OutgoingDeliveryTracker();

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
    this.accountKey = wechatAccountKey(this.baseUrl, config.accountId);
    this.credentialKey = wechatCredentialKey(this.baseUrl, config.accountId, config.token);
    this.extraCdnDownloadHosts = validateExtraWechatCdnDownloadHosts(config.extraCdnDownloadHosts);
    this.protocolVersion = config.protocolVersion ?? WECHAT_PROTOCOL_VERSION;
    this.botAgent = sanitizeBotAgent(config.botAgent ?? WECHAT_DEFAULT_BOT_AGENT);
    this.fetchFn = options.fetch ?? fetch;
    this.sleepFn = options.sleep ?? abortableDelay;
    this.log = options.log ?? (() => undefined);
    this.stateStore = options.stateStore;
    this.now = options.now ?? Date.now;
    this.maxMessageAgeMs = options.maxMessageAgeMs ?? DEFAULT_MESSAGE_AGE_MS;
    this.rateLimitRetries = boundedInteger(
      options.rateLimitRetries,
      DEFAULT_RATE_LIMIT_RETRIES,
      0,
      5,
      "微信限流重试次数",
    );
    this.rateLimitRetryBaseMs = boundedInteger(
      options.rateLimitRetryBaseMs,
      DEFAULT_RATE_LIMIT_RETRY_BASE_MS,
      1,
      30_000,
      "微信限流退避时间",
    );
    this.rateLimitCooldownMs = boundedInteger(
      options.rateLimitCooldownMs,
      DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      0,
      5 * 60_000,
      "微信限流冷却时间",
    );
  }

  async run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    await this.ensureState();
    if (liveWechatAdapters.has(this.accountKey)) {
      throw new Error("同一微信账号已有一个长轮询 adapter 在运行");
    }
    liveWechatAdapters.set(this.accountKey, { credentialKey: this.credentialKey, adapter: this });
    let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    let retryMs = 1_000;
    try {
      await withWechatAccountSendLock(this.accountKey, () => this.notifyLifecycle("notifystart"));
      while (!signal.aborted) {
        if (this.staleCredential) {
          // Continuing to poll would consume messages the fresh binding owns
          // and re-offer state this process can no longer persist.
          throw new Error(
            "微信状态文件已被新的扫码绑定接管，长轮询停止；请重启 Gateway 使用新凭据",
          );
        }
        try {
          const requestedCursor = this.state.cursor ?? "";
          const retryingHeldBatch = this.heldCursor === requestedCursor;
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
          let batchAccepted = true;
          for (const raw of response.msgs ?? []) {
            const message = this.normalizeInbound(raw, retryingHeldBatch);
            if (!message || this.isDuplicate(message.messageId)) continue;
            try {
              if (raw.context_token) {
                this.state.contextTokens ??= {};
                this.state.contextTokens[message.target] = raw.context_token;
                await this.persistState();
              }
              await handler(message);
            } catch (error) {
              batchAccepted = false;
              this.forgetDuplicate(message.messageId);
              this.log(
                `微信消息处理失败：${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          if (!batchAccepted) {
            this.heldCursor = requestedCursor;
            throw new Error("微信消息未被上层接收，保留游标等待重投");
          }
          if (response.get_updates_buf) {
            await this.commitCursor(response.get_updates_buf);
          }
          if (this.heldCursor === requestedCursor) this.heldCursor = undefined;
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
      // Stop advertising this adapter before yielding, so new direct sends use
      // the one-shot route. A caller that already observed the live entry has
      // synchronously enqueued its send; drain that queue before notifystop so
      // accepted work cannot race behind the session shutdown.
      if (liveWechatAdapters.get(this.accountKey)?.adapter === this) {
        liveWechatAdapters.delete(this.accountKey);
      }
      await this.outboundQueue.catch(() => undefined);
      await withWechatAccountSendLock(this.accountKey, () => this.notifyLifecycle("notifystop"));
    }
  }

  send(target: string, message: OutgoingMessage): Promise<void> {
    const operation = this.outboundQueue.then(() =>
      withWechatAccountSendLock(this.accountKey, () => this.sendInOrder(target, message)),
    );
    this.outboundQueue = operation.catch(() => undefined);
    return operation;
  }

  private async sendInOrder(target: string, message: OutgoingMessage): Promise<void> {
    await this.ensureState();
    const text = message.button
      ? `${message.text}\n\n${message.button.text}: ${message.button.url}`
      : message.text;
    const attachments = outgoingAttachments(message, this.capabilities.outbound.attachments);
    const textChunks = splitWechatText(text, this.capabilities.outbound.maxTextLength ?? 8_000);
    if (textChunks.length === 0 && attachments.length === 0) {
      throw new Error("微信待发送消息不能为空");
    }
    // iLink accepts exactly one MessageItem per sendmessage call. In
    // particular, a text caption and a media item must be sent separately;
    // combining them is rejected by the service as "invalid arguments".
    await this.delivery.run(message, () => [
      ...textChunks.map((chunk) => {
        // Keep the platform id stable across DeliveryQueue retries. A request
        // can reach WeChat successfully while its HTTP acknowledgement is
        // lost; retrying with a fresh id visibly duplicates the reply.
        const clientId = `code-shell-chat-${randomUUID()}`;
        return () =>
          this.sendItem(target, { type: ITEM_TYPE_TEXT, text_item: { text: chunk } }, clientId);
      }),
      ...attachments.map((attachment) => {
        const clientId = `code-shell-chat-${randomUUID()}`;
        return async () => {
          const item =
            attachment.kind === "image"
              ? await this.uploadImage(target, attachment)
              : attachment.kind === "video"
                ? await this.uploadVideo(target, attachment)
                : // Arbitrary audio lacks the SILK metadata required by native
                  // voice bubbles, so deliver it as a playable file attachment.
                  await this.uploadFile(target, attachment);
          await this.sendItem(target, item, clientId);
        };
      }),
    ]);
  }

  private async sendItem(target: string, item: WechatMessageItem, clientId: string): Promise<void> {
    const contextToken = this.state.contextTokens?.[target];
    const first = await this.postWechatMessageWithRateLimitRetry(
      target,
      item,
      clientId,
      contextToken,
    );
    if (!wechatResponseFailed(first)) return;

    // Tencent's client attempts sends without context_token, although the
    // documented contract remains context-bound and some accounts reject it.
    // Clear only the exact stale token and try the compatible-backend fallback
    // once. Reusing client_id lets the platform deduplicate if the first
    // request reached deeper than its error suggests.
    if (contextToken && isStaleWechatContextResponse(first)) {
      try {
        await this.clearContextToken(target, contextToken);
      } catch (error) {
        // Persistence is a cache concern, not a delivery prerequisite. Keep the
        // in-memory token cleared and perform the safe tokenless retry.
        this.log(
          `微信失效上下文未能写回状态文件：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.log(`微信会话上下文已失效，已清除并尝试无上下文直发：${wechatResponseDetail(first)}`);
      const fallback = await this.postWechatMessageWithRateLimitRetry(target, item, clientId);
      if (!wechatResponseFailed(fallback)) return;
      throw new Error(wechatSendFailure(fallback, true));
    }

    throw new Error(wechatSendFailure(first, contextToken === undefined));
  }

  private async postWechatMessage(
    target: string,
    item: WechatMessageItem,
    clientId: string,
    contextToken?: string,
  ): Promise<BasicResponse> {
    try {
      return await this.post<BasicResponse>(
        "ilink/bot/sendmessage",
        {
          msg: {
            from_user_id: "",
            to_user_id: target,
            client_id: clientId,
            message_type: MESSAGE_TYPE_BOT,
            message_state: MESSAGE_STATE_FINISH,
            item_list: [item],
            ...(contextToken ? { context_token: contextToken } : {}),
          },
          base_info: this.baseInfo(),
        },
        15_000,
      );
    } catch (error) {
      // HTTP 429 is an explicit rejection, unlike a socket/timeout failure
      // whose acceptance outcome is unknown. Normalize only that status into
      // the same safe retry path as iLink ret=-2.
      if (error instanceof WechatHttpError && error.status === 429) {
        return { ret: 429, errmsg: error.message };
      }
      throw error;
    }
  }

  private async postWechatMessageWithRateLimitRetry(
    target: string,
    item: WechatMessageItem,
    clientId: string,
    contextToken?: string,
  ): Promise<BasicResponse> {
    this.assertRateLimitCircuitClosed();
    let response = await this.postWechatMessage(target, item, clientId, contextToken);
    for (let attempt = 0; attempt < this.rateLimitRetries; attempt += 1) {
      if (!isExplicitWechatRateLimitResponse(response)) break;
      const delayMs = Math.min(this.rateLimitRetryBaseMs * 2 ** attempt, 30_000);
      this.log(`微信发送被限流，${delayMs}ms 后重试（${attempt + 1}/${this.rateLimitRetries}）`);
      await this.sleepFn(delayMs, new AbortController().signal);
      response = await this.postWechatMessage(target, item, clientId, contextToken);
    }
    if (isExplicitWechatRateLimitResponse(response)) {
      if (this.rateLimitCooldownMs > 0) {
        rateLimitCooldownUntil.set(this.accountKey, this.now() + this.rateLimitCooldownMs);
      }
    } else if (!wechatResponseFailed(response)) {
      rateLimitCooldownUntil.delete(this.accountKey);
    }
    return response;
  }

  private assertRateLimitCircuitClosed(): void {
    const until = rateLimitCooldownUntil.get(this.accountKey);
    if (until === undefined) return;
    const remaining = until - this.now();
    if (remaining <= 0) {
      rateLimitCooldownUntil.delete(this.accountKey);
      return;
    }
    throw new Error(`微信发送暂时限流，冷却还剩 ${remaining}ms`);
  }

  private async clearContextToken(target: string, failedToken: string): Promise<void> {
    // Do not erase a fresher token learned by the long poll while this send was
    // in flight. Only the token proven stale by this response may be removed.
    if (this.state.contextTokens?.[target] !== failedToken) return;
    delete this.state.contextTokens[target];
    await this.persistState();
  }

  private async uploadImage(
    target: string,
    attachment: NonNullable<OutgoingMessage["attachments"]>[number],
  ): Promise<WechatMessageItem> {
    if (
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(attachment.mimeType) ||
      attachment.data.byteLength < 1 ||
      attachment.data.byteLength > 10 * 1024 * 1024
    ) {
      throw new Error("微信待发送图片的类型或大小不受支持");
    }
    const uploaded = await this.uploadMedia(target, attachment, 1);
    return {
      type: ITEM_TYPE_IMAGE,
      image_item: {
        media: {
          encrypt_query_param: uploaded.encryptedQueryParam,
          aes_key: Buffer.from(uploaded.keyHex).toString("base64"),
          encrypt_type: 1,
        },
        mid_size: uploaded.ciphertextSize,
      },
    };
  }

  private async uploadFile(
    target: string,
    attachment: NonNullable<OutgoingMessage["attachments"]>[number],
  ): Promise<WechatMessageItem> {
    if (attachment.data.byteLength < 1 || attachment.data.byteLength > 10 * 1024 * 1024) {
      throw new Error("微信待发送文件的大小不受支持");
    }
    const uploaded = await this.uploadMedia(target, attachment, 3);
    return {
      type: ITEM_TYPE_FILE,
      file_item: {
        media: {
          encrypt_query_param: uploaded.encryptedQueryParam,
          aes_key: Buffer.from(uploaded.keyHex).toString("base64"),
          encrypt_type: 1,
        },
        file_name: safeWechatFileName(attachment.name),
        len: String(uploaded.plaintextSize),
      },
    };
  }

  private async uploadVideo(
    target: string,
    attachment: NonNullable<OutgoingMessage["attachments"]>[number],
  ): Promise<WechatMessageItem> {
    if (!attachment.mimeType.startsWith("video/")) {
      throw new Error("微信待发送视频的 MIME 类型无效");
    }
    const uploaded = await this.uploadMedia(target, attachment, 2);
    return {
      type: ITEM_TYPE_VIDEO,
      video_item: {
        media: {
          encrypt_query_param: uploaded.encryptedQueryParam,
          aes_key: Buffer.from(uploaded.keyHex).toString("base64"),
          encrypt_type: 1,
        },
        video_size: uploaded.ciphertextSize,
        play_length: 0,
        video_md5: createHash("md5").update(attachment.data).digest("hex"),
      },
    };
  }

  private async uploadMedia(
    target: string,
    attachment: NonNullable<OutgoingMessage["attachments"]>[number],
    mediaType: 1 | 2 | 3,
  ): Promise<UploadedWechatMedia> {
    const plaintext = Buffer.from(attachment.data);
    const filekey = randomBytes(16).toString("hex");
    const key = randomBytes(16);
    const keyHex = key.toString("hex");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    cipher.setAutoPadding(true);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const upload = await this.post<GetUploadUrlResponse>(
      "ilink/bot/getuploadurl",
      {
        filekey,
        media_type: mediaType,
        to_user_id: target,
        rawsize: plaintext.byteLength,
        rawfilemd5: createHash("md5").update(plaintext).digest("hex"),
        filesize: ciphertext.byteLength,
        no_need_thumb: true,
        aeskey: keyHex,
        base_info: this.baseInfo(),
      },
      15_000,
    );
    if (wechatResponseFailed(upload)) {
      throw new Error(`微信获取附件上传地址失败：${wechatResponseDetail(upload)}`);
    }
    const uploadUrl = resolveWechatCdnUploadUrl(upload, filekey);
    const encryptedQueryParam = await this.uploadCiphertext(uploadUrl, ciphertext);
    return {
      plaintextSize: plaintext.byteLength,
      ciphertextSize: ciphertext.byteLength,
      keyHex,
      encryptedQueryParam,
    };
  }

  private async uploadCiphertext(uploadUrl: string, ciphertext: Buffer): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= WECHAT_CDN_UPLOAD_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetchFn(uploadUrl, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array(ciphertext),
          signal: AbortSignal.timeout(30_000),
          // Never let a CDN response turn this trusted upload into an arbitrary
          // follow-up request. Unlike downloads, an upload has no legitimate
          // cross-host redirect flow to preserve.
          redirect: "manual",
        });
        if (
          (response.status >= 300 && response.status < 400) ||
          (response.status >= 400 && response.status < 500)
        ) {
          throw new WechatCdnUploadClientError(response.status);
        }
        if (!response.ok) throw new Error(`微信附件上传失败（HTTP ${response.status}）`);
        const encryptedQueryParam = response.headers.get("x-encrypted-param")?.trim();
        if (!encryptedQueryParam) throw new Error("微信附件上传响应缺少下载参数");
        return encryptedQueryParam;
      } catch (error) {
        if (error instanceof WechatCdnUploadClientError) throw error;
        lastError = error;
        if (attempt >= WECHAT_CDN_UPLOAD_ATTEMPTS) break;
        const delayMs = WECHAT_CDN_UPLOAD_RETRY_BASE_MS * attempt;
        this.log(
          `微信附件上传失败，${delayMs}ms 后重试（${attempt}/${WECHAT_CDN_UPLOAD_ATTEMPTS - 1}）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.sleepFn(delayMs, new AbortController().signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("微信附件上传失败");
  }

  private normalizeInbound(
    raw: WechatWireMessage,
    allowExpiredRetry = false,
  ): ChannelMessage | undefined {
    if (raw.message_type !== undefined && raw.message_type !== MESSAGE_TYPE_USER) return undefined;
    if (raw.message_state === MESSAGE_STATE_GENERATING) return undefined;
    const senderId = raw.from_user_id?.trim();
    if (!senderId) return undefined;
    if (
      raw.create_time_ms !== undefined &&
      !allowExpiredRetry &&
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
    const url = resolveWechatCdnUrl(
      media,
      this.config.allowUnsafeBaseUrl ?? false,
      this.extraCdnDownloadHosts,
    );
    const response = await this.fetchWechatCdn(url, signal ?? AbortSignal.timeout(30_000));
    if (!response.ok) throw new Error(`微信附件下载失败（HTTP ${response.status}）`);
    const encrypted = await readBoundedWechatResponse(response, 10 * 1024 * 1024 + 16);
    const key = decodeWechatAesKey(preferredHexKey, media.aes_key);
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  private async fetchWechatCdn(initialUrl: string, signal: AbortSignal): Promise<Response> {
    let currentUrl = initialUrl;
    for (let redirects = 0; redirects <= WECHAT_CDN_MAX_REDIRECTS; redirects += 1) {
      const response = await this.fetchFn(currentUrl, { signal, redirect: "manual" });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error("微信附件 CDN 重定向缺少地址");
      if (redirects >= WECHAT_CDN_MAX_REDIRECTS) {
        throw new Error("微信附件 CDN 重定向过多");
      }
      currentUrl = validateWechatCdnDownloadUrl(
        new URL(location, currentUrl).toString(),
        this.config.allowUnsafeBaseUrl ?? false,
        this.extraCdnDownloadHosts,
      );
    }
    throw new Error("微信附件 CDN 重定向过多");
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

  private forgetDuplicate(messageId: string | undefined): void {
    if (messageId) this.seenMessageIds.delete(messageId);
  }

  private async commitCursor(cursor: string): Promise<void> {
    const previous = this.state.cursor;
    this.state.cursor = cursor;
    try {
      await this.persistState();
    } catch (error) {
      this.state.cursor = previous;
      throw error;
    }
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
    const snapshot: WechatAdapterState = {
      cursor: this.state.cursor,
      contextTokens: { ...(this.state.contextTokens ?? {}) },
    };
    const write = this.stateWrite
      .catch(() => undefined)
      .then(async () => {
        if (this.staleCredential) {
          throw new Error("微信状态文件已被新的扫码绑定接管，本进程已停止持久化");
        }
        try {
          await this.stateStore?.save(snapshot);
        } catch (error) {
          if (error instanceof WechatStateOwnershipError && !this.staleCredential) {
            this.staleCredential = true;
            this.log(
              `微信状态文件已被新的扫码绑定接管，本进程停止持久化并停止长轮询：${error.message}`,
            );
          }
          throw error;
        }
      });
    this.stateWrite = write;
    await write;
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
      if (wechatResponseFailed(response)) {
        this.log(`微信 ${action} 失败：${wechatResponseDetail(response)}`);
      }
    } catch (error) {
      this.log(
        `微信 ${action} 失败（已忽略）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Direct WeChat delivery for schedulers and notification workers. It reuses a
 * live long-poll adapter when available and otherwise creates a one-shot
 * adapter. Both routes share persisted context lookup, stale-context eviction,
 * best-effort tokenless fallback, media upload, and response validation.
 */
export async function sendWechatDirect(
  config: WechatAdapterConfig,
  target: string,
  message: OutgoingMessage,
  options: WechatAdapterOptions = {},
): Promise<WechatDirectSendResult> {
  const lockBaseUrl = validateWechatBaseUrl(
    config.baseUrl ?? WECHAT_DEFAULT_BASE_URL,
    config.allowUnsafeBaseUrl ?? false,
  );
  const accountKey = wechatAccountKey(lockBaseUrl, config.accountId);
  const credentialKey = wechatCredentialKey(lockBaseUrl, config.accountId, config.token);
  // iLink can acknowledge a competing short-lived session without showing
  // the message on the recipient device. Reuse the authoritative long-poll
  // adapter whenever this process has one, matching Hermes' live-adapter
  // routing; only fall back to a one-shot adapter while the Gateway is down.
  const live = liveWechatAdapters.get(accountKey);
  if (live && live.credentialKey !== credentialKey) {
    throw new Error("微信凭据已更新，请重启 Gateway 后再发送");
  }
  const adapter = live?.adapter ?? new WechatAdapter(config, options);
  await adapter.send(target, message);
  return {
    channel: "wechat",
    target,
    status: "accepted",
    terminalDeliveryConfirmed: false,
    viaLiveAdapter: live !== undefined,
  };
}

async function withWechatAccountSendLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = accountSendTails.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(
    () => gate,
    () => gate,
  );
  accountSendTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (accountSendTails.get(key) === tail) accountSendTails.delete(key);
  }
}

function wechatAccountKey(baseUrl: string, accountId: string): string {
  return `${baseUrl}\0${normalizeWechatAccountId(accountId)}`;
}

function wechatCredentialKey(baseUrl: string, accountId: string, token: string): string {
  const tokenFingerprint = createHash("sha256").update(token).digest("base64url").slice(0, 24);
  return `${wechatAccountKey(baseUrl, accountId)}\0${tokenFingerprint}`;
}

function wechatResponseFailed(response: BasicResponse): boolean {
  return [response.ret, response.errcode].some((code) => typeof code === "number" && code !== 0);
}

function isStaleWechatContextResponse(response: BasicResponse): boolean {
  const message = response.errmsg?.trim() ?? "";
  if (/prepare failed/iu.test(message)) return true;
  if (response.ret === -14 || response.errcode === -14) return true;
  return (
    (response.ret === -2 || response.errcode === -2) && /unknown(?:\s+|_)error/iu.test(message)
  );
}

/**
 * Retry only an explicit application-level throttle response. Transport
 * failures are intentionally excluded because their delivery outcome is
 * ambiguous, and stale-context responses must take the tokenless fallback path.
 */
function isExplicitWechatRateLimitResponse(response: BasicResponse): boolean {
  if (!wechatResponseFailed(response) || isStaleWechatContextResponse(response)) return false;
  return [response.ret, response.errcode].some((code) => code === -2 || code === 429);
}

function wechatResponseDetail(response: BasicResponse): string {
  const message = response.errmsg?.trim();
  if (message) return message;
  const codes = [
    ...(typeof response.ret === "number" ? [`ret=${response.ret}`] : []),
    ...(typeof response.errcode === "number" ? [`errcode=${response.errcode}`] : []),
  ];
  return codes.join(", ") || "微信服务返回了未知错误";
}

function wechatSendFailure(response: BasicResponse, direct: boolean): string {
  if (response.ret === -14 || response.errcode === -14) {
    return `微信登录或发送授权已失效：${wechatResponseDetail(response)}。请重新扫码连接个人微信。`;
  }
  if (direct && isStaleWechatContextResponse(response)) {
    return `微信直接发送失败：${wechatResponseDetail(response)}。当前微信会话没有可用的 context_token；请先让管理员向 Mimi 发一条消息刷新会话上下文。`;
  }
  return `微信${direct ? "直接" : ""}发送失败：${wechatResponseDetail(response)}`;
}

function splitWechatText(text: string, maximum: number): string[] {
  if (!text) return [];
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += maximum) {
    chunks.push(characters.slice(offset, offset + maximum).join(""));
  }
  return chunks;
}

function resolveWechatCdnUrl(
  media: WechatCdnMedia,
  allowUnsafe: boolean,
  extraHosts: ReadonlySet<string>,
): string {
  const raw = media.full_url?.trim()
    ? media.full_url
    : media.encrypt_query_param
      ? `${WECHAT_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
      : "";
  if (!raw) throw new Error("微信附件缺少 CDN 下载参数");
  return validateWechatCdnDownloadUrl(raw, allowUnsafe, extraHosts);
}

function validateWechatCdnDownloadUrl(
  raw: string,
  allowUnsafe: boolean,
  extraHosts: ReadonlySet<string>,
): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("微信附件 CDN 地址必须使用 HTTPS");
  if (url.username || url.password) throw new Error("微信附件 CDN 地址不能包含登录信息");
  if (
    !allowUnsafe &&
    !WECHAT_CDN_DOWNLOAD_HOSTS.has(url.hostname) &&
    !extraHosts.has(url.hostname)
  ) {
    throw new Error("微信附件 CDN 地址不在受信任主机列表中");
  }
  return url.toString();
}

/**
 * Extra hosts widen only the download allowlist, so they must be exact
 * hostnames — no scheme, path, port, or credentials. HTTPS enforcement stays
 * unconditional in validateWechatCdnDownloadUrl.
 */
function validateExtraWechatCdnDownloadHosts(
  hosts: readonly string[] | undefined,
): ReadonlySet<string> {
  const validated = new Set<string>();
  for (const raw of hosts ?? []) {
    const host = raw.trim().toLowerCase();
    let hostname: string | undefined;
    try {
      const parsed = new URL(`https://${host}/`);
      if (!parsed.port && !parsed.username && !parsed.password) hostname = parsed.hostname;
    } catch {
      // Rejected below with the original value for a clear config error.
    }
    if (!host || hostname !== host) {
      throw new Error(`微信附件 CDN 额外主机必须是纯主机名：${JSON.stringify(raw)}`);
    }
    validated.add(host);
  }
  return validated;
}

function resolveWechatCdnUploadUrl(upload: GetUploadUrlResponse, filekey: string): string {
  const raw = upload.upload_full_url?.trim()
    ? upload.upload_full_url
    : upload.upload_param
      ? `${WECHAT_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}`
      : "";
  if (!raw) throw new Error("微信服务未返回附件上传地址");
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "novac2c.cdn.weixin.qq.com" ||
    url.username ||
    url.password
  ) {
    throw new Error("微信附件上传地址不是受信任的 CDN HTTPS 地址");
  }
  return url.toString();
}

function safeWechatFileName(value: string): string {
  const normalized = value
    .replace(/[\\/\u0000-\u001f\u007f]+/gu, "_")
    .trim()
    .slice(0, 255);
  return normalized || "attachment";
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

class WechatHttpError extends Error {
  constructor(readonly status: number) {
    super(`微信 API 返回 HTTP ${status}`);
  }
}

class WechatCdnUploadClientError extends Error {
  constructor(readonly status: number) {
    super(`微信附件上传失败（HTTP ${status}）`);
  }
}

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
        // An automatic redirect could forward the bearer token away from the
        // already-validated API origin. iLink expresses regional redirects in
        // its JSON protocol, so HTTP redirects are never required here.
        redirect: "manual",
      },
    );
    if (!response.ok) throw new WechatHttpError(response.status);
    try {
      const parsed: unknown = await response.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("微信 API 返回的 JSON 不是对象");
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof Error && error.message === "微信 API 返回的 JSON 不是对象") {
        throw error;
      }
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

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return resolved;
}

function validateWechatBaseUrl(value: string, allowUnsafe: boolean): string {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("微信 API baseUrl 不能包含登录信息");
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

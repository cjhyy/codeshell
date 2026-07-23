import type {
  ChatAttachment,
  ChatAttachmentKind,
  OutgoingAttachment,
  OutgoingMessage,
} from "./channel.js";
import { isIP } from "node:net";

export const MAX_CHANNEL_ATTACHMENTS = 4;
export const MAX_CHANNEL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface RemoteAttachmentOptions {
  id: string;
  kind?: ChatAttachmentKind;
  name?: string;
  mimeType?: string;
  size?: number;
  url: string;
  headers?: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
  /** Only for an operator-configured self-hosted platform origin. */
  allowPrivateNetwork?: boolean;
}

/** Infer the Pet/Gateway media kind from a trusted platform MIME or filename. */
export function mediaKind(mimeType?: string, name?: string): ChatAttachmentKind {
  const normalized = mimeType?.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  const extension = name?.toLowerCase().match(/\.([a-z0-9]{1,10})$/)?.[1];
  if (
    extension &&
    ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"].includes(extension)
  ) {
    return "image";
  }
  if (
    extension &&
    ["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac", "amr", "silk"].includes(extension)
  ) {
    return "audio";
  }
  if (extension && ["mp4", "mov", "webm", "mkv", "avi", "3gp"].includes(extension)) {
    return "video";
  }
  return "file";
}

/** Create a lazy platform attachment; no network request occurs before load(). */
export function remoteAttachment(options: RemoteAttachmentOptions): ChatAttachment {
  const name = safeAttachmentName(options.name, options.id);
  return {
    id: options.id,
    kind: options.kind ?? mediaKind(options.mimeType, name),
    name,
    ...(options.mimeType?.trim() ? { mimeType: options.mimeType.trim() } : {}),
    ...(options.size !== undefined ? { size: options.size } : {}),
    load: (signal) =>
      downloadRemoteAttachment(options.fetch ?? fetch, options.url, {
        ...(options.headers ? { headers: options.headers } : {}),
        ...(signal ? { signal } : {}),
        ...(options.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
      }),
  };
}

interface DownloadRemoteAttachmentOptions extends Pick<RequestInit, "headers" | "signal"> {
  allowPrivateNetwork?: boolean;
}

/** Bounded streaming download shared by authenticated platform media URLs. */
export async function downloadRemoteAttachment(
  fetchFn: typeof fetch,
  url: string,
  init: DownloadRemoteAttachmentOptions = {},
  maximum = MAX_CHANNEL_ATTACHMENT_BYTES,
): Promise<Uint8Array> {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  let currentUrl = url;
  let currentHeaders = new Headers(init.headers);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    assertSafeMediaUrl(currentUrl, init.allowPrivateNetwork ?? false);
    response = await fetchFn(currentUrl, {
      method: "GET",
      headers: currentHeaders,
      signal,
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirects === 5) throw new Error("附件下载重定向无效");
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.origin !== new URL(currentUrl).origin) {
      currentHeaders = new Headers(currentHeaders);
      currentHeaders.delete("authorization");
      currentHeaders.delete("cookie");
      currentHeaders.delete("proxy-authorization");
    }
    currentUrl = nextUrl.toString();
  }
  if (!response) throw new Error("附件下载失败");
  if (!response.ok) throw new Error(`附件下载失败（HTTP ${response.status}）`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("附件超过大小限制");

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximum) throw new Error("附件超过大小限制");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("附件超过大小限制");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function assertSafeMediaUrl(value: string, allowPrivateNetwork: boolean): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("附件下载地址无效");
  }
  if (url.protocol !== "https:" && !(allowPrivateNetwork && url.protocol === "http:")) {
    throw new Error("附件下载地址必须使用 HTTPS");
  }
  if (allowPrivateNetwork) return;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isPrivateIpLiteral(host)
  ) {
    throw new Error("附件下载地址不能指向本机或私有网络");
  }
}

function isPrivateIpLiteral(host: string): boolean {
  const family = isIP(host);
  if (family === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = host.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  return false;
}

/** Validate adapter-facing media before any platform request is made. */
export function outgoingAttachments(
  message: OutgoingMessage,
  supported: readonly ChatAttachmentKind[],
): readonly OutgoingAttachment[] {
  const attachments = message.attachments ?? [];
  if (attachments.length > MAX_CHANNEL_ATTACHMENTS) {
    throw new Error(`单条消息最多发送 ${MAX_CHANNEL_ATTACHMENTS} 个附件`);
  }
  for (const attachment of attachments) {
    if (!supported.includes(attachment.kind)) {
      throw new Error(`当前渠道不支持发送 ${attachment.kind} 附件`);
    }
    if (
      !(attachment.data instanceof Uint8Array) ||
      attachment.data.byteLength < 1 ||
      attachment.data.byteLength > MAX_CHANNEL_ATTACHMENT_BYTES
    ) {
      throw new Error(`附件 ${attachment.name || "attachment"} 的大小不受支持`);
    }
    if (!attachment.mimeType.trim()) throw new Error("附件 MIME 类型不能为空");
    if (attachment.kind === "image" && !attachment.mimeType.startsWith("image/")) {
      throw new Error(`图片 ${attachment.name} 的 MIME 类型无效`);
    }
  }
  return attachments;
}

export function safeAttachmentName(value: string | undefined, fallback = "attachment"): string {
  const normalized = (value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, 255);
  return (
    normalized || fallback.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 255) || "attachment"
  );
}

interface OutgoingDeliveryPlan {
  steps: Promise<readonly (() => Promise<void>)[]>;
  next: number;
}

/**
 * Resume a multi-request adapter send at the first unfinished visible step.
 * DeliveryQueue retries the same cached OutgoingMessage object for Mimi turns,
 * so this prevents a failed second attachment from duplicating earlier text.
 * A failure while awaiting one platform call remains honestly at-least-once:
 * the remote service may have accepted it without returning an acknowledgement.
 */
export class OutgoingDeliveryTracker {
  private readonly plans = new WeakMap<OutgoingMessage, OutgoingDeliveryPlan>();

  async run(
    message: OutgoingMessage,
    createSteps: () => readonly (() => Promise<void>)[] | Promise<readonly (() => Promise<void>)[]>,
  ): Promise<void> {
    let plan = this.plans.get(message);
    if (!plan) {
      plan = { steps: Promise.resolve().then(createSteps), next: 0 };
      this.plans.set(message, plan);
      plan.steps.catch(() => {
        if (this.plans.get(message) === plan) this.plans.delete(message);
      });
    }
    const steps = await plan.steps;
    while (plan.next < steps.length) {
      await steps[plan.next]!();
      plan.next += 1;
    }
    if (this.plans.get(message) === plan) this.plans.delete(message);
  }
}

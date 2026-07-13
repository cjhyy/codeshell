import type { ChatAttachment } from "./channel.js";
import type { PetChatInputAttachment } from "./protocol.js";

export const DEFAULT_MAX_CHAT_ATTACHMENTS = 4;
export const DEFAULT_MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_CHAT_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;

export interface MaterializeChatAttachmentsOptions {
  maxAttachments?: number;
  maxAttachmentBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
}

/** Fetch lazy channel media under bounded count, per-file, total, and time limits. */
export async function materializeChatAttachments(
  attachments: readonly ChatAttachment[] | undefined,
  options: MaterializeChatAttachmentsOptions = {},
): Promise<PetChatInputAttachment[]> {
  const input = attachments ?? [];
  const maxAttachments = options.maxAttachments ?? DEFAULT_MAX_CHAT_ATTACHMENTS;
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_CHAT_ATTACHMENT_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_CHAT_ATTACHMENTS_TOTAL_BYTES;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (input.length > maxAttachments) {
    throw new Error(`单条消息最多接收 ${maxAttachments} 个附件`);
  }

  const seen = new Set<string>();
  const output: PetChatInputAttachment[] = [];
  let total = 0;
  for (const attachment of input) {
    if (!attachment.id?.trim() || seen.has(attachment.id)) {
      throw new Error("附件 ID 为空或重复");
    }
    seen.add(attachment.id);
    if (
      attachment.size !== undefined &&
      (!Number.isSafeInteger(attachment.size) ||
        attachment.size < 0 ||
        attachment.size > maxAttachmentBytes)
    ) {
      throw new Error(`附件 ${attachment.name ?? attachment.id} 超过大小限制`);
    }
    const bytes = new Uint8Array(await attachment.load(AbortSignal.timeout(timeoutMs)));
    if (bytes.byteLength > maxAttachmentBytes) {
      throw new Error(`附件 ${attachment.name ?? attachment.id} 超过大小限制`);
    }
    if (attachment.size !== undefined && attachment.size !== bytes.byteLength) {
      throw new Error(`附件 ${attachment.name ?? attachment.id} 实际大小与声明不一致`);
    }
    total += bytes.byteLength;
    if (total > maxTotalBytes) throw new Error("附件总大小超过限制");
    const mimeType =
      attachment.kind === "image"
        ? (detectImageMime(bytes) ?? attachment.mimeType)
        : attachment.mimeType;
    output.push({
      id: attachment.id,
      kind: attachment.kind,
      ...(attachment.name ? { name: attachment.name } : {}),
      ...(mimeType ? { mimeType } : {}),
      size: bytes.byteLength,
      dataBase64: Buffer.from(bytes).toString("base64"),
    });
  }
  return output;
}

function detectImageMime(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

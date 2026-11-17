/**
 * The single stdin line a `claude -p --input-format stream-json` turn reads.
 *
 * Image attachments the API can take also travel as native `image` content
 * blocks, so the model sees them without spending a Read tool call. Every
 * attachment — inlined images included — keeps its path reference in the text,
 * exactly as `textWithAttachmentReferences` renders it, so the model still knows
 * where the file lives if it needs to edit or copy it.
 */
import { open, stat } from "node:fs/promises";
import {
  textWithAttachmentReferences,
  type ExternalRuntimeAttachment,
  type ExternalRuntimeTurnInput,
} from "../turn-input.js";

/**
 * Anthropic rejects an image whose base64 payload exceeds 5 MB. Base64 grows
 * bytes by 4/3, so the raw file must stay at or below 3/4 of that.
 */
export const CLAUDE_MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
export const CLAUDE_MAX_IMAGE_FILE_BYTES = Math.floor((CLAUDE_MAX_IMAGE_BASE64_BYTES * 3) / 4);

export type ClaudeImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type ClaudeUserContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: ClaudeImageMediaType; data: string };
    };

export interface ClaudeUserMessage {
  line: string;
  /** Image attachments delivered inline. */
  inlineImages: number;
  /** Image attachments sent as a path reference only, with the reason. */
  imageFallbacks: Array<{ reason: ImageFallbackReason }>;
}

type ImageFallbackReason = "unreadable" | "too_large" | "unsupported_type";

function isImageAttachment(attachment: ExternalRuntimeAttachment): boolean {
  return attachment.kind === "image" || !!attachment.mime?.toLowerCase().startsWith("image/");
}

/**
 * Media type from the file's magic bytes. The API checks the declared type
 * against the data, so a mislabelled attachment (a JPEG saved as `.png`) would
 * fail the whole turn if we trusted the name or the reported mime.
 */
export function sniffClaudeImageMediaType(bytes: Uint8Array): ClaudeImageMediaType | undefined {
  const starts = (...signature: number[]): boolean =>
    signature.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

async function readInlineImage(
  path: string,
): Promise<ClaudeUserContentBlock | { fallback: ImageFallbackReason }> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { fallback: "unreadable" };
    size = info.size;
  } catch {
    return { fallback: "unreadable" };
  }
  if (size > CLAUDE_MAX_IMAGE_FILE_BYTES) return { fallback: "too_large" };
  let bytes: Buffer;
  try {
    const handle = await open(path, "r");
    try {
      // Bounded read: the file may have grown since stat().
      const buffer = Buffer.alloc(CLAUDE_MAX_IMAGE_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      bytes = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return { fallback: "unreadable" };
  }
  if (bytes.length > CLAUDE_MAX_IMAGE_FILE_BYTES) return { fallback: "too_large" };
  const mediaType = sniffClaudeImageMediaType(bytes);
  if (!mediaType) return { fallback: "unsupported_type" };
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
  };
}

/**
 * Build the stream-json user line. `wrapText` lets the runtime decorate the
 * prompt text (first-turn context replay) after attachment references are in.
 */
export async function buildClaudeUserMessage(
  input: ExternalRuntimeTurnInput,
  wrapText: (text: string) => string = (text) => text,
): Promise<ClaudeUserMessage> {
  const images: ClaudeUserContentBlock[] = [];
  const imageFallbacks: ClaudeUserMessage["imageFallbacks"] = [];
  for (const attachment of input.attachments ?? []) {
    if (!attachment.path.trim() || !isImageAttachment(attachment)) continue;
    const block = await readInlineImage(attachment.path);
    if ("fallback" in block) imageFallbacks.push({ reason: block.fallback });
    else images.push(block);
  }
  const text = wrapText(textWithAttachmentReferences(input));
  // Images before text: Anthropic's guidance for best results with vision.
  const content: ClaudeUserContentBlock[] = [...images, { type: "text", text }];
  const line = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
  return { line, inlineImages: images.length, imageFallbacks };
}

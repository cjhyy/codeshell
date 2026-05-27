/**
 * Image attachment state used by the chat composer.
 *
 * Renderer-only: nothing here touches disk. Images live in-memory as
 * data URLs until the user sends, at which point the send wire-format
 * embeds them inline (engine-side support gated by model.supportsVision).
 */

export interface ImageAttachment {
  /** Local id for keying/removing in the UI. */
  id: string;
  /** Original file name when available. Used for the chip tooltip. */
  name: string;
  /** MIME type as reported by the browser. */
  mime: string;
  /** Base64 data URL — what the model wire format wants. */
  dataUrl: string;
  /** Size in bytes (best-effort; useful for the "太大" warning). */
  size: number;
}

export const ATTACHMENT_LIMITS = {
  /** Single-file ceiling. Most providers cap at 20 MB; stay conservative. */
  maxBytesPerImage: 10 * 1024 * 1024,
  maxImagesPerMessage: 6,
  /** Anything outside this set is rejected before reading. */
  allowedMimes: new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
  ]),
} as const;

export interface AttachmentError {
  kind: "too-large" | "wrong-type" | "too-many" | "read-failed";
  message: string;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `img-${Date.now().toString(36)}-${idCounter}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * Validate + read a batch of files into ImageAttachment. Returns the
 * accepted attachments and any per-file errors. Callers surface errors
 * in a banner — they never throw, so a paste of mixed content (one
 * image + some text) doesn't kill the whole drop.
 */
export async function buildAttachments(
  files: File[],
  existing: ImageAttachment[],
): Promise<{ accepted: ImageAttachment[]; errors: AttachmentError[] }> {
  const errors: AttachmentError[] = [];
  const accepted: ImageAttachment[] = [];

  for (const file of files) {
    if (accepted.length + existing.length >= ATTACHMENT_LIMITS.maxImagesPerMessage) {
      errors.push({
        kind: "too-many",
        message: `最多 ${ATTACHMENT_LIMITS.maxImagesPerMessage} 张图片，已忽略「${file.name || "未命名"}」`,
      });
      continue;
    }
    if (!ATTACHMENT_LIMITS.allowedMimes.has(file.type)) {
      errors.push({
        kind: "wrong-type",
        message: `不支持的文件类型：${file.type || "未知"}（${file.name || "未命名"}）`,
      });
      continue;
    }
    if (file.size > ATTACHMENT_LIMITS.maxBytesPerImage) {
      errors.push({
        kind: "too-large",
        message: `「${file.name || "未命名"}」超过 ${ATTACHMENT_LIMITS.maxBytesPerImage / 1024 / 1024} MB`,
      });
      continue;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      accepted.push({
        id: nextId(),
        name: file.name || "image",
        mime: file.type,
        dataUrl,
        size: file.size,
      });
    } catch (e) {
      errors.push({
        kind: "read-failed",
        message: `读取失败：${file.name || "未命名"} (${(e as Error).message})`,
      });
    }
  }

  return { accepted, errors };
}

/**
 * Wire format for embedding images in a single-string `task` send.
 *
 * Until the agent protocol gains a structured `content[]` array, we
 * prefix images as fenced base64 blocks the engine can detect. This
 * keeps the boundary trivial — no protocol break — but the marker is
 * specific enough that nothing else would accidentally produce it.
 */
export function encodeAttachmentsForWire(
  text: string,
  images: ImageAttachment[],
): string {
  if (images.length === 0) return text;
  const blocks = images
    .map(
      (img) =>
        `<codeshell-image mime="${img.mime}" name="${escapeAttr(img.name)}">\n${img.dataUrl}\n</codeshell-image>`,
    )
    .join("\n");
  return text ? `${text}\n\n${blocks}` : blocks;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export interface DecodedWire {
  /** Prose with image blocks removed and surrounding whitespace trimmed. */
  text: string;
  /** Images recovered from `<codeshell-image>` blocks, in source order. */
  images: { name: string; mime: string; dataUrl: string }[];
}

const WIRE_IMAGE_RE =
  /<codeshell-image\b([^>]*)>([\s\S]*?)<\/codeshell-image>/g;

/**
 * Derive a sidebar session title from a wire string. Image base64 must
 * never leak into the title — an image-only turn gets a `[图片]` placeholder
 * instead of 60 chars of `data:image/png;base64,…`.
 */
export function titleFromWire(wire: string): string {
  const { text, images } = decodeWireForDisplay(wire);
  if (text) return text;
  if (images.length > 1) return `[图片 ×${images.length}]`;
  if (images.length === 1) return "[图片]";
  return text;
}

/**
 * Inverse of {@link encodeAttachmentsForWire}, used by the chat stream to
 * render a sent user turn: the wire string embeds base64 image blocks that
 * must show as thumbnails, not as a wall of base64 text.
 */
export function decodeWireForDisplay(wire: string): DecodedWire {
  if (typeof wire !== "string" || wire.indexOf("<codeshell-image") === -1) {
    return { text: wire ?? "", images: [] };
  }
  const images: DecodedWire["images"] = [];
  WIRE_IMAGE_RE.lastIndex = 0;
  const text = wire
    .replace(WIRE_IMAGE_RE, (_m, attrsRaw: string, body: string) => {
      const mime = /mime="([^"]*)"/.exec(attrsRaw)?.[1] ?? "image/png";
      const nameRaw = /name="([^"]*)"/.exec(attrsRaw)?.[1] ?? "";
      images.push({
        mime,
        name: unescapeAttr(nameRaw),
        dataUrl: body.trim(),
      });
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, images };
}

/**
 * Extract files from a clipboard paste, ignoring text items. Returns
 * empty if the user only pasted text — callers should fall through to
 * the textarea's default paste behavior.
 */
export function filesFromClipboard(items: DataTransferItemList | null): File[] {
  if (!items) return [];
  const out: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/**
 * Filter dropped items to image files only.
 */
export function imageFilesFromDrop(items: DataTransferItemList | null): File[] {
  if (!items) return [];
  const out: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

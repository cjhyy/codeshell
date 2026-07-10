/**
 * Image attachment state used by the chat composer.
 *
 * Renderer state for composer images. New paste/drop images are staged by
 * Electron main before they enter this state, so the UI keeps both the data URL
 * needed for thumbnails/legacy vision wire and the stable path metadata needed
 * by tools and sub-agents.
 */

import { extractAnnotations } from "./anchors";
import { translate } from "../i18n/translate";
import { loadUILanguage } from "../uiLanguage";

/** Resolve a chat.* key against the active UI language (this module is React-free). */
const tr = (key: string, params?: Record<string, string | number>): string =>
  translate(loadUILanguage(), key, params);

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
  /** Path shown to the model; prefers cwd-relative paths. */
  path?: string;
  /** Absolute path for main/core/tool handoff; not shown unless needed. */
  absPath?: string;
  /** cwd-relative path when the attachment was copied into the workspace. */
  relPath?: string;
  /** Hex sha256 of the staged/sourced bytes, without a `sha256:` prefix. */
  sha256?: string;
  /** Where the user supplied this attachment from. */
  origin?:
    | "paste"
    | "os-drop"
    | "file-panel"
    | "picker"
    | "mention"
    | "generated"
    | "mobile"
    | "tool";
  /** Session directory that owns staged attachments. */
  sessionId?: string;
  /** When this attachment was staged/selected. */
  createdAt?: number;
  /** Original source path when user explicitly selected a file. */
  sourcePath?: string;
}

/**
 * DataTransfer MIME for an internal file-panel → composer image drag (TODO
 * 2.1). The payload is the absolute path. Custom type so the composer can tell
 * an internal drag (a path string) from an OS file drop (a browser File).
 */
export const CODESHELL_PATH_DND_MIME = "application/x-codeshell-path";

export const ATTACHMENT_LIMITS = {
  /** Single-file ceiling. Most providers cap at 20 MB; stay conservative. */
  maxBytesPerImage: 10 * 1024 * 1024,
  maxImagesPerMessage: 6,
  /** Anything outside this set is rejected before reading. */
  allowedMimes: new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]),
} as const;

export interface AttachmentError {
  kind: "too-large" | "wrong-type" | "too-many" | "read-failed" | "staging-failed";
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
        message: tr("chat.attachment.tooMany", {
          max: ATTACHMENT_LIMITS.maxImagesPerMessage,
          name: file.name || tr("chat.attachment.unnamed"),
        }),
      });
      continue;
    }
    if (!ATTACHMENT_LIMITS.allowedMimes.has(file.type)) {
      errors.push({
        kind: "wrong-type",
        message: tr("chat.attachment.wrongType", {
          type: file.type || tr("chat.attachment.unknownType"),
          name: file.name || tr("chat.attachment.unnamed"),
        }),
      });
      continue;
    }
    if (file.size > ATTACHMENT_LIMITS.maxBytesPerImage) {
      errors.push({
        kind: "too-large",
        message: tr("chat.attachment.tooLarge", {
          name: file.name || tr("chat.attachment.unnamed"),
          mb: ATTACHMENT_LIMITS.maxBytesPerImage / 1024 / 1024,
        }),
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
        message: tr("chat.attachment.readFailed", {
          name: file.name || tr("chat.attachment.unnamed"),
          message: (e as Error).message,
        }),
      });
    }
  }

  return { accepted, errors };
}

/** mime + byte size parsed out of a base64 data: URL (size estimated from b64 length). */
function parseDataUrlMeta(dataUrl: string): { mime: string; size: number } | null {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || "image/png";
  const data = m[3] ?? "";
  // base64 → bytes ≈ len*3/4 minus padding; good enough for the size guard.
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const size = m[2] ? Math.max(0, Math.floor((data.length * 3) / 4) - padding) : data.length;
  return { mime, size };
}

/**
 * Stage an attachment from an on-disk image PATH (file-panel drag/add — TODO
 * 2.1). Unlike buildAttachments (browser File → no real path), the path entry
 * keeps the ABSOLUTE path as `name`, so the chip shows it and the wire `name`
 * lets the assistant/tools reference the original file. `dataUrl` is read by
 * the caller via images:readDataUrl. Applies the same count / type / size
 * limits as buildAttachments.
 */
export function buildPathAttachment(
  absPath: string,
  dataUrl: string,
  existing: ImageAttachment[],
  options: Partial<
    Pick<ImageAttachment, "path" | "relPath" | "absPath" | "sha256" | "origin" | "sessionId">
  > = {},
): { attachment?: ImageAttachment; error?: AttachmentError } {
  if (existing.length >= ATTACHMENT_LIMITS.maxImagesPerMessage) {
    return {
      error: {
        kind: "too-many",
        message: tr("chat.attachment.tooManySimple", {
          max: ATTACHMENT_LIMITS.maxImagesPerMessage,
        }),
      },
    };
  }
  const dataMeta = parseDataUrlMeta(dataUrl);
  if (!dataMeta) {
    return {
      error: {
        kind: "read-failed",
        message: tr("chat.attachment.readFailedPath", { path: absPath }),
      },
    };
  }
  if (!ATTACHMENT_LIMITS.allowedMimes.has(dataMeta.mime)) {
    return {
      error: {
        kind: "wrong-type",
        message: tr("chat.attachment.wrongTypeSimple", { mime: dataMeta.mime }),
      },
    };
  }
  if (dataMeta.size > ATTACHMENT_LIMITS.maxBytesPerImage) {
    return {
      error: {
        kind: "too-large",
        message: tr("chat.attachment.tooLargePath", {
          path: absPath,
          mb: ATTACHMENT_LIMITS.maxBytesPerImage / 1024 / 1024,
        }),
      },
    };
  }
  return {
    attachment: {
      id: nextId(),
      name: absPath,
      mime: dataMeta.mime,
      dataUrl,
      size: dataMeta.size,
      path: options.path ?? absPath,
      absPath: options.absPath ?? absPath,
      relPath: options.relPath,
      sha256: options.sha256,
      origin: options.origin ?? "file-panel",
      sessionId: options.sessionId,
      createdAt: Date.now(),
      sourcePath: absPath,
    },
  };
}

/**
 * Wire format for embedding images in a single-string `task` send.
 *
 * Until the agent protocol gains a structured `content[]` array, we
 * prefix images as fenced base64 blocks the engine can detect. This
 * keeps the boundary trivial — no protocol break — but the marker is
 * specific enough that nothing else would accidentally produce it.
 */
export function encodeAttachmentsForWire(text: string, images: ImageAttachment[]): string {
  if (images.length === 0) return text;
  const blocks = images
    .map((img) => `<codeshell-image ${imageAttrs(img)}>\n${img.dataUrl}\n</codeshell-image>`)
    .join("\n");
  return text ? `${text}\n\n${blocks}` : blocks;
}

function imageAttrs(img: ImageAttachment): string {
  const attrs: Array<[string, string | number | undefined]> = [
    ["mime", img.mime],
    ["name", img.name],
    ["path", img.path],
    ["hash", img.sha256 ? `sha256:${img.sha256.replace(/^sha256:/, "")}` : undefined],
    ["size", Number.isFinite(img.size) ? img.size : undefined],
    ["origin", img.origin],
    ["sessionId", img.sessionId],
  ];
  return attrs
    .filter((pair): pair is [string, string | number] => pair[1] !== undefined && pair[1] !== "")
    .map(([key, value]) => `${key}="${escapeAttr(String(value))}"`)
    .join(" ");
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

const WIRE_IMAGE_RE = /<codeshell-image\b([^>]*)>([\s\S]*?)<\/codeshell-image>/g;

/**
 * Derive a sidebar session title from a wire string. Image base64 must
 * never leak into the title — an image-only turn gets a `[图片]` placeholder
 * instead of 60 chars of `data:image/png;base64,…`.
 */
export function titleFromWire(wire: string): string {
  const { text, images } = decodeWireForDisplay(wire);
  // Drop the pinned-comment block so a "comment only" turn doesn't title the
  // sidebar with raw `<codeshell-annotations>` XML.
  const prose = extractAnnotations(text).text;
  if (prose) return prose;
  if (images.length > 1) return tr("chat.attachment.imagesTitle", { count: images.length });
  if (images.length === 1) return tr("chat.attachment.imageTitle");
  return prose;
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
      const dataUrl = body.trim();
      // Skip blocks with an empty body: an ephemeral source (e.g. a macOS
      // screenshot under /var/folders/.../TemporaryItems/ already deleted by
      // encode time) yields an empty data URL. Keeping it would render a blank
      // but still-selectable <img src=""> ("空白可复制内容") and make an
      // image-only turn falsely claim a [图片] title.
      if (dataUrl === "") return "";
      const mime = /mime="([^"]*)"/.exec(attrsRaw)?.[1] ?? "image/png";
      const nameRaw = /name="([^"]*)"/.exec(attrsRaw)?.[1] ?? "";
      images.push({
        mime,
        name: unescapeAttr(nameRaw),
        dataUrl,
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

export async function sha256FromDataUrl(dataUrl: string): Promise<string | undefined> {
  const match = /^data:[^;,]+;base64,([\s\S]*)$/.exec(dataUrl);
  if (!match) return undefined;
  const raw = atob(match[1] ?? "");
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Strip image base64 payloads out of messages before they reach any log or
 * persisted record.
 *
 * Transcripts (`<storage>/sessions/<sid>/transcript.jsonl`) still hold the
 * full base64 — replay needs the bytes intact. Logs (`~/.code-shell/logs/`
 * and `<repo>/log/`) do not. A 10 MB base64 string showing up in a daily
 * log file would (a) bloat disk usage by orders of magnitude, (b) make
 * `tail`/`less` unusable, and (c) leak sensitive image content into a
 * file the user does not expect to be a content store.
 *
 * The sanitizer replaces every `{type:"image", source:{...base64...}}`
 * block with a metadata-only stub of the form
 * `{type:"image", source:{type:"base64", media_type, bytes, omitted:true}}`
 * — preserving enough structure that a developer reading the log can see
 * "yes, an image was here, type X, N bytes" without seeing the bytes
 * themselves. Same idea for the OpenAI-compat `image_url` shape some
 * downstream serializers may produce.
 *
 * Pure / no I/O. Allocates only when an image block actually exists, so
 * pure-text turns pay essentially nothing on the fast path.
 */

import type { ContentBlock, Message } from "../types.js";

/** Marker length below which we don't bother sanitizing — short URLs aren't base64. */
const BASE64_MIN_BYTES = 64;

interface SanitizedImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    bytes: number;
    omitted: true;
  };
}

interface SanitizedImageUrlPart {
  type: "image_url";
  image_url: { url: string; omitted: true; bytes: number };
}

/**
 * Returns true iff this content block carries a real image payload that we
 * should redact. Inline text/tool_use/tool_result blocks pass through.
 */
function isImageBlock(block: unknown): block is ContentBlock & {
  source: { type: "base64"; media_type: string; data: string };
} {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  if (b.type !== "image") return false;
  const src = b.source as Record<string, unknown> | undefined;
  if (!src || src.type !== "base64") return false;
  return typeof src.data === "string" && (src.data as string).length >= BASE64_MIN_BYTES;
}

/**
 * Returns true if this is the OpenAI-compat `image_url` part with a data
 * URL embedded inline.
 */
function isImageUrlPart(
  part: unknown,
): part is { type: "image_url"; image_url: { url: string } } {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  if (p.type !== "image_url") return false;
  const iu = p.image_url as Record<string, unknown> | undefined;
  if (!iu || typeof iu.url !== "string") return false;
  return (iu.url as string).startsWith("data:") && (iu.url as string).length >= BASE64_MIN_BYTES;
}

function sanitizeImageBlock(block: ContentBlock): SanitizedImageBlock {
  const src = block.source!;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: src.media_type,
      bytes: src.data.length,
      omitted: true,
    },
  };
}

function sanitizeImageUrlPart(part: {
  type: "image_url";
  image_url: { url: string };
}): SanitizedImageUrlPart {
  // Best-effort byte count off the data URL. We don't decode — just report
  // payload length so the reader knows the scale.
  const url = part.image_url.url;
  const comma = url.indexOf(",");
  const payloadLen = comma === -1 ? 0 : url.length - comma - 1;
  return {
    type: "image_url",
    image_url: {
      // Keep the data-URL header so reviewers can see the MIME, but strip
      // the payload. "data:image/png;base64,<omitted, 12345 bytes>"
      url:
        comma === -1
          ? url
          : `${url.slice(0, comma + 1)}<omitted, ${payloadLen} bytes>`,
      omitted: true,
      bytes: payloadLen,
    },
  };
}

/**
 * Walk a single message's content and replace image-payload blocks with
 * metadata stubs. Returns a new value — the input is not mutated.
 */
export function sanitizeContent(
  content: Message["content"],
): Message["content"] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;

  let touched = false;
  const out: unknown[] = [];
  for (const block of content) {
    if (isImageBlock(block)) {
      out.push(sanitizeImageBlock(block));
      touched = true;
      continue;
    }
    if (isImageUrlPart(block)) {
      out.push(sanitizeImageUrlPart(block));
      touched = true;
      continue;
    }
    out.push(block);
  }
  return (touched ? out : content) as Message["content"];
}

/**
 * Walk a {@link Message}[] array and sanitize every entry's content.
 * Returns the *same* array reference when no message held an image (fast
 * path for the overwhelmingly common pure-text case).
 */
export function sanitizeMessages(messages: readonly Message[]): Message[] {
  let touched = false;
  const out: Message[] = [];
  for (const m of messages) {
    const sanitized = sanitizeContent(m.content);
    if (sanitized !== m.content) {
      touched = true;
      out.push({ ...m, content: sanitized });
    } else {
      out.push(m);
    }
  }
  return touched ? out : (messages as Message[]);
}

/**
 * Sanitize a free-form task string before logging.
 *
 * The desktop encoder embeds images as `<codeshell-image>` blocks holding
 * `data:…;base64,<payload>` URLs. Strip those URLs but keep the wrapper
 * so a reader can see "an image was attached here".
 */
export function sanitizeTaskString(task: string): string {
  if (typeof task !== "string" || task.indexOf("<codeshell-image") === -1) {
    return task;
  }
  return task.replace(
    /(<codeshell-image\b[^>]*>)([\s\S]*?)(<\/codeshell-image>)/g,
    (_full, open: string, body: string, close: string) => {
      const trimmed = body.trim();
      const comma = trimmed.indexOf(",");
      const bytes = comma === -1 ? trimmed.length : trimmed.length - comma - 1;
      const header = comma === -1 ? "" : trimmed.slice(0, comma + 1);
      return `${open}${header}<omitted, ${bytes} bytes>${close}`;
    },
  );
}

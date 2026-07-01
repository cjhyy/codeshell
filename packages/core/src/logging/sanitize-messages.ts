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

// ─────────────────────────────────────────────────────────────────────
// Secret redaction
// ─────────────────────────────────────────────────────────────────────
//
// Beyond image payloads, log/diagnostics entries can carry API keys,
// authorization headers, provider tokens, and similar secrets via
// `data` blobs (settings dumps, provider configs, error responses, …).
// These walkers redact secrets *in place on a deep clone* so the caller
// can still log "useful shape, scrubbed values".

const SECRET_KEY_RE =
  /(^|[._-])(api[_-]?key|authorization|x[_-]api[_-]key|bearer[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|password|client[_-]?secret|cookie)($|[._-])/i;

// Header containers whose VALUES are all header values — any of them can carry
// a bespoke auth token under a non-secret-looking key name (e.g.
// `x-custom-auth`), which SECRET_KEY_RE alone would miss. Treat the whole
// container as sensitive: every non-empty value inside is redacted.
const HEADERS_CONTAINER_RE = /^(httpHeaders|headers|defaultHeaders|envHeaders)$/;

/** Redact all non-empty string/scalar values of a headers container object. */
function redactHeaderValues(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [hName, hVal] of Object.entries(headers)) {
    // Preserve present-vs-absent for empty/null, redact everything else.
    if (hVal === null || hVal === undefined || hVal === "") out[hName] = hVal;
    else out[hName] = REDACTED;
  }
  return out;
}

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=~]{8,}/g;

// URL query parameters that look like credentials. Conservative — only
// trigger on a small named set so a normal `?id=…&q=…` URL passes through.
const URL_SECRET_QS_RE = /([?&](?:key|api_key|apikey|access_token|token|auth|sig|signature)=)[^&#\s]+/gi;

const REDACTED = "[redacted]";
const MAX_DEPTH = 10;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** Scrub bare `Bearer <token>` and credential-looking URL query params from a string. */
function redactSecretsInString(s: string): string {
  let out = s;
  if (BEARER_RE.test(out)) out = out.replace(BEARER_RE, "Bearer [redacted]");
  if (URL_SECRET_QS_RE.test(out)) out = out.replace(URL_SECRET_QS_RE, "$1[redacted]");
  return out;
}

/**
 * Recursively walk a value and return a *new* value with secret-looking
 * fields replaced by "[redacted]". Used by the logger (so anything ending up
 * in `entry.d` is scrubbed) and by diagnostics / in-memory error capture.
 *
 * Pure / no I/O. Does not mutate the input — important because the same
 * object may also be on its way to a transcript or UI stream where the
 * unredacted form is correct.
 */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return value;

  const t = typeof value;
  if (t === "string") return redactSecretsInString(value as unknown as string) as unknown as T;
  if (t === "number" || t === "boolean" || t === "bigint" || t === "symbol") return value;
  if (t === "function") return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, depth + 1)) as unknown as T;
  }

  // Error objects: preserve name/message/stack shape but redact within.
  if (value instanceof Error) {
    const clone: Record<string, unknown> = {
      name: value.name,
      message: redactSecretsInString(value.message),
      ...(value.stack ? { stack: redactSecretsInString(value.stack) } : {}),
    };
    // Some libraries attach extra properties (`.response`, `.config`, …) —
    // walk them as well.
    for (const key of Object.keys(value)) {
      if (key === "name" || key === "message" || key === "stack") continue;
      const v = (value as unknown as Record<string, unknown>)[key];
      clone[key] = isSecretKey(key) ? REDACTED : redactSecrets(v, depth + 1);
    }
    return clone as unknown as T;
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (isSecretKey(k)) {
        // Preserve presence (null/undefined stay as-is so consumers can
        // still distinguish "key present" vs "key absent"; non-empty values
        // collapse to [redacted]).
        if (v === null || v === undefined || v === "") out[k] = v;
        else out[k] = REDACTED;
      } else if (HEADERS_CONTAINER_RE.test(k) && v && typeof v === "object" && !Array.isArray(v)) {
        // Blanket-redact header values regardless of the inner header name, so a
        // custom `x-custom-auth` doesn't leak in cleartext.
        out[k] = redactHeaderValues(v as Record<string, unknown>);
      } else {
        out[k] = redactSecrets(v, depth + 1);
      }
    }
    return out as unknown as T;
  }

  return value;
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

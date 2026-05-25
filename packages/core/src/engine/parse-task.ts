/**
 * Parse a single-string `task` for inline image attachments.
 *
 * Desktop's composer encodes images as `<codeshell-image>` blocks before
 * sending — see `packages/desktop/src/renderer/chat/attachments.ts` —
 * because the agent-server-stdio RPC schema only carries a `task: string`.
 * The engine recovers the structured form here before handing the message
 * to the LLM client.
 *
 * Wire format (one block per image):
 *
 *   <codeshell-image mime="image/png" name="screenshot.png">
 *   data:image/png;base64,iVBORw0KGgo…
 *   </codeshell-image>
 *
 * Multiple blocks may appear interleaved with regular text — preserved
 * order matters because some prompts reference "the second image".
 *
 * Pure / no I/O. Pure-text tasks (no `<codeshell-image>` substring) hit
 * a single non-matching indexOf check and return immediately, so CLI / TUI
 * callers pay essentially nothing.
 */

export interface ParsedImage {
  /** MIME type as declared in the block opening tag. */
  mime: string;
  /** Original file name (may be empty). HTML-attr-escaped on the wire; unescaped here. */
  name: string;
  /** Full `data:<mime>;base64,<…>` URL — handy for OpenAI-compat clients. */
  dataUrl: string;
  /** Just the base64 payload, with the data-URL prefix stripped. */
  base64: string;
}

export interface ParsedTask {
  /** Remaining plain-text portion (image blocks removed, surrounding whitespace trimmed). */
  text: string;
  /** Images in the order they appeared in the source. */
  images: ParsedImage[];
  /** Convenience flag — true iff `images.length > 0`. */
  hasImages: boolean;
}

export class ImageParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageParseError";
  }
}

const IMAGE_BLOCK_MARKER = "<codeshell-image";

/**
 * Pulled out so the regex compiles once. Captures:
 *   1 = raw attribute string (everything between `<codeshell-image` and the
 *       closing `>` of the opening tag)
 *   2 = body (everything between the opening tag and `</codeshell-image>`)
 *
 * Anchored loosely — we tolerate whitespace inside the opening tag and
 * around the body, which is what the desktop encoder produces.
 */
const IMAGE_BLOCK_RE =
  /<codeshell-image\b([^>]*)>([\s\S]*?)<\/codeshell-image>/g;

const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

/**
 * Reverse of the desktop encoder's `escapeAttr` so file names with `&`
 * or quotes round-trip cleanly.
 */
function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    out[m[1]!.toLowerCase()] = unescapeAttr(m[2]!);
  }
  return out;
}

const DATA_URL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/;

function parseDataUrl(body: string): { mime: string; base64: string } {
  const trimmed = body.trim();
  const m = DATA_URL_RE.exec(trimmed);
  if (!m) {
    throw new ImageParseError(
      "image block body is not a data URL of the form `data:<mime>;base64,<…>`",
    );
  }
  const mime = m[1]!.trim();
  // Strip ALL whitespace from the base64 portion — wire format may contain
  // newlines inserted for readability. The base64 grammar tolerates none.
  const base64 = m[2]!.replace(/\s+/g, "");
  if (base64.length === 0) {
    throw new ImageParseError("image block body has an empty base64 payload");
  }
  return { mime, base64 };
}

/**
 * Parse `<codeshell-image>` blocks out of `task`.
 *
 * Behavior:
 *   - No marker substring → fast return, no allocations beyond the
 *     `ParsedTask` shell.
 *   - One or more well-formed blocks → blocks removed from `text`,
 *     surrounding whitespace collapsed, blocks accumulated in `images`
 *     in source order.
 *   - Malformed block (e.g. unclosed tag, missing data URL) → throws
 *     {@link ImageParseError}. Callers decide whether to drop or fail
 *     the run, but **silent fallback is intentionally not provided** —
 *     dropping image bytes on the floor was the failure mode this whole
 *     pipeline exists to prevent.
 */
export function parseTaskWithImages(task: string): ParsedTask {
  if (typeof task !== "string" || task.indexOf(IMAGE_BLOCK_MARKER) === -1) {
    return { text: task ?? "", images: [], hasImages: false };
  }

  // Defensively reject the orphaned-opening-tag case before delegating to
  // the matcher: a `<codeshell-image …>` with no matching `</codeshell-image>`
  // is exactly the "browser hung up mid-paste" failure mode this parser
  // exists to surface, not swallow.
  const openingMatches = task.match(/<codeshell-image\b/g) ?? [];
  const closingMatches = task.match(/<\/codeshell-image>/g) ?? [];
  if (openingMatches.length !== closingMatches.length) {
    throw new ImageParseError(
      `unbalanced <codeshell-image> tags: ${openingMatches.length} opening vs ${closingMatches.length} closing`,
    );
  }

  const images: ParsedImage[] = [];
  IMAGE_BLOCK_RE.lastIndex = 0;
  const textWithoutImages = task.replace(IMAGE_BLOCK_RE, (_match, attrsRaw: string, body: string) => {
    const attrs = parseAttrs(attrsRaw);
    const { mime, base64 } = parseDataUrl(body);
    const declaredMime = attrs.mime?.trim();
    // Prefer the opening-tag attribute when it disagrees with the data URL's
    // self-declared type — the attribute is what the desktop validator gated
    // on, so it's the "source of truth" the rest of the pipeline expects.
    const finalMime = declaredMime && declaredMime.length > 0 ? declaredMime : mime;
    images.push({
      mime: finalMime,
      name: attrs.name ?? "",
      dataUrl: `data:${finalMime};base64,${base64}`,
      base64,
    });
    return "";
  });

  // Collapse the whitespace the removed blocks leave behind. Two passes:
  //   1. Multiple blank lines (3+ newlines) → exactly two newlines, so the
  //      remaining prose retains paragraph breaks but doesn't look like a
  //      page of empty whitespace.
  //   2. Trim leading/trailing whitespace introduced by a block at either
  //      end of the message.
  const cleanedText = textWithoutImages.replace(/\n{3,}/g, "\n\n").trim();

  return {
    text: cleanedText,
    images,
    hasImages: images.length > 0,
  };
}

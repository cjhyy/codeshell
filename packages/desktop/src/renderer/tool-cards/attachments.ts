/**
 * Recognise tool outputs that produced a file artifact worth
 * surfacing as a clickable attachment card.
 *
 * Two sources:
 *   1. Tool result text — `Generated image saved to /abs/path.png` or
 *      `wrote /abs/path.md`. Conservative match: must mention an
 *      absolute path or a clear write/save verb followed by a path.
 *   2. Tool args — Write / write_file's `file_path` arg, paired with
 *      a "success" result, so we don't have to scrape the result
 *      string for paths the user already typed in.
 *
 * Returns deduped attachments in original order. Callers downstream
 * map each to an AttachmentCard.
 */

import { classifyMediaPath } from "../../shared/media-preview";
import type { SessionUiAuthority } from "../sessionUiAuthority";

export type AttachmentKind = "image" | "audio" | "video" | "markdown" | "html" | "file";

/** Authority belongs to the task that produced the attachment. */
export interface AttachmentContext {
  cwd?: string | null;
  sessionId?: string | null;
  sessionMainRootId?: string | null;
  rootStatus?: SessionUiAuthority["rootStatus"];
}

export interface Attachment {
  /** Absolute or relative path to the artifact. */
  path: string;
  /** Coarse classification, used to pick the icon / thumbnail. */
  kind: AttachmentKind;
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const MD_EXT = /\.(md|mdx|markdown)$/i;
const HTML_EXT = /\.(html?|xhtml)$/i;

export function classifyPath(p: string): AttachmentKind {
  if (IMG_EXT.test(p)) return "image";
  const mediaKind = classifyMediaPath(p);
  if (mediaKind) return mediaKind;
  if (MD_EXT.test(p)) return "markdown";
  if (HTML_EXT.test(p)) return "html";
  return "file";
}

// Tokenize each contiguous run once, then check the complete token's extension.
// An unanchored path regex with an optional directory prefix repeatedly retries
// long extensionless strings, such as base64 screenshots in MCP result JSON.
// That quadratic work blocks the renderer even when the tool card is collapsed.
// This single character class has no ambiguous alternatives or failing suffix.
// Unicode letters/numbers preserve complete paths containing CJK segments.
const PATH_TOKEN_RE = /[\p{L}\p{N}_@.+/-]+/gu;

/**
 * Pull attachment paths out of one tool message.
 *
 * `args` is the serialized JSON string; we tolerate corrupt JSON
 * gracefully (just skip the args source).
 */
export function detectAttachments(
  toolName: string,
  args: string | undefined,
  result: string | undefined,
): Attachment[] {
  const name = toolName.toLowerCase();
  const found: Attachment[] = [];
  const seen = new Set<string>();
  const push = (p: string, requireDir = false, exact = false): void => {
    const value = exact ? p : p.trim();
    // Strip prose punctuation without retrying a suffix regex at every offset
    // of a long punctuation run that is followed by a non-punctuation byte.
    let end = value.length;
    if (!exact) while (end > 0 && ".,;:!?".includes(value[end - 1]!)) end--;
    const trimmed = value.slice(0, end);
    if (!trimmed || seen.has(trimmed)) return;
    // Prose-scraped paths must carry a directory (absolute `/`, `./`/`../`,
    // or `dir/file`). A bare filename like `TODO.md` mentioned in a sentence
    // has no cwd we can resolve it against, so clicking it opens a wrong
    // Finder location — skip it. Args-derived paths (Write/GenerateImage)
    // bypass this: the card supplies the session cwd to resolve them.
    if (requireDir && !trimmed.includes("/")) return;
    const kind = classifyPath(trimmed);
    if (kind === "file") return; // unknown extension — skip
    seen.add(trimmed);
    found.push({ path: trimmed, kind });
  };

  // (1) A Write result has one target supplied in structured args. Preserve
  // its literal spelling; scraping the same prose can invent a second suffix
  // when a directory contains spaces.
  if (args) {
    try {
      const obj = JSON.parse(args) as Record<string, unknown>;
      if (name === "write" || name === "filewrite" || name === "write_file") {
        // Only count writes that succeeded — error results live in
        // message.error, but we still see a result string like
        // "wrote /path". Treat both as success if the result is
        // truthy and doesn't start with "error".
        if (typeof obj.file_path === "string") {
          const lc = (result ?? "").toLowerCase();
          if (!lc.startsWith("error")) {
            push(obj.file_path, false, true);
            return found;
          }
        }
      }
    } catch {
      // ignore — fall through to result scraping
    }
  }

  // GenerateImage's production formatter ends with its complete absolute
  // output path. It has no quoting layer, so keep the tail literal rather than
  // tokenizing whitespace, punctuation or native separators. Multiple field
  // delimiters are ambiguous (model or cwd may contain one): retain the result
  // text instead of manufacturing a clickable path from a suffix.
  const generatedPrefix = "Generated image with ";
  if (name === "generateimage" && result?.startsWith(generatedPrefix)) {
    const delimiter = ", saved to ";
    const at = result.indexOf(delimiter, generatedPrefix.length);
    if (at <= generatedPrefix.length || result.indexOf(delimiter, at + delimiter.length) !== -1)
      return found;
    const path = result.slice(at + delimiter.length);
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\"))
      push(path, false, true);
    return found;
  }

  // (2) Result-text scraping: pull every path-shaped token. Most
  // tools that produce artifacts say "saved to /abs/path" or
  // "wrote /abs/path"; we don't even need to anchor on that prefix
  // — the file extension is enough signal.
  if (result) {
    PATH_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATH_TOKEN_RE.exec(result))) {
      push(m[0], /* requireDir */ true);
    }
  }

  return found;
}

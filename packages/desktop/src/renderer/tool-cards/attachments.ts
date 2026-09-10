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

export type AttachmentKind = "image" | "markdown" | "html" | "file";

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
  const push = (p: string, requireDir = false): void => {
    const value = p.trim();
    // Strip prose punctuation without retrying a suffix regex at every offset
    // of a long punctuation run that is followed by a non-punctuation byte.
    let end = value.length;
    while (end > 0 && ".,;:!?".includes(value[end - 1]!)) end--;
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

  // (1) Args-derived: Write / write_file / GenerateImage's output.
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
          if (!lc.startsWith("error")) push(obj.file_path);
        }
      }
    } catch {
      // ignore — fall through to result scraping
    }
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

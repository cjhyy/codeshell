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

// Match an absolute / relative file path with an extension. Same
// shape as the Markdown remarkPathLinks matcher but standalone here
// because we run against tool result strings, not MDAST.
//
// A path segment is `[\p{L}\p{N}_./@+-]` — letters/numbers via Unicode
// properties (NOT `\w`, which is ASCII-only and would resync at the first CJK
// char, dropping a `/Users/.../个人学习/代码学习/` prefix and yielding a wrong,
// non-existent absolute path — the "图片打不开" bug). `u` flag enables \p{}.
const SEG = "[\\p{L}\\p{N}_@.+-]";
const PATH_RE = new RegExp(
  `((?:/|\\.{1,2}/|${SEG}+/)?(?:${SEG}|/)+\\.[\\p{L}\\p{N}]{1,8})`,
  "gu",
);

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
    const trimmed = p.trim().replace(/[.,;:!?]+$/, "");
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
    PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATH_RE.exec(result))) {
      push(m[1]!, /* requireDir */ true);
    }
  }

  return found;
}

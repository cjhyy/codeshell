// Comment anchors — Codex-style "local comments" that pin a precise location
// (a diff line, a browser element, a file line) plus the user's note, then ride
// along with the next chat message so the model can act on that exact target.
//
// Anchors accumulate as chips above the composer; on submit they're encoded
// into a structured text block prepended to the message. We deliberately send
// structured *text* (not a bespoke protocol) so any model can read it.

export type AnchorKind = "diff" | "browser" | "file";

/** Element box within the guest page, in page coordinates. */
export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Echo payload for browser anchors — everything the browser surfaces (panel +
 * popout windows) need to re-display the picked element: the marker dot, the
 * edit-time outline highlight, and the "which page is this from" label. UI
 * only; deliberately NOT part of the wire encoding (encodeAnchorsForWire reads
 * `locator`, which already carries url/selector as text for the model).
 */
export interface BrowserAnchorEcho {
  url: string;
  /** document.title captured at pick time (page-attribution display). */
  pageTitle?: string;
  /** CSS selector for re-highlighting; rect is the fallback when it misses. */
  selector?: string;
  rect: AnchorRect;
}

export interface Anchor {
  id: string;
  kind: AnchorKind;
  /** Short chip label, e.g. "engine.ts:42" or "button.primary". */
  label: string;
  /**
   * Structured locator lines the model reads — file/line/code, or URL/selector/
   * styles. One entry per "key: value"; rendered as a list under the comment.
   */
  locator: Record<string, string>;
  /** The user's note about this location. */
  comment: string;
  /** Present iff kind === "browser": echo payload for the browser surfaces. */
  browser?: BrowserAnchorEcho;
}

let seq = 0;
/** Stable-ish id without Date.now()/random (those are banned in some envs). */
export function nextAnchorId(): string {
  seq += 1;
  return `anchor-${seq}`;
}

const KIND_LABEL: Record<AnchorKind, string> = {
  diff: "审查",
  browser: "浏览器",
  file: "文件",
};

/**
 * Encode anchors + the user's text into the wire payload. Anchors come first as
 * a fenced, clearly-delimited block so the model can map each comment to its
 * exact location; the user's free text follows.
 */
// Strip the delimiter tag from user-supplied values so a comment containing
// "</codeshell-annotations>" can't break out of / forge the annotations block.
function sanitize(v: string): string {
  return v.replace(/<\/?codeshell-annotations>/gi, "");
}

const ANNOTATIONS_BLOCK_RE =
  /<codeshell-annotations>\n([\s\S]*?)\n<\/codeshell-annotations>/;

/** One pinned location as parsed back out of the wire block for display. */
export interface ParsedAnnotationEntry {
  /** Kind label, e.g. "文件" / "浏览器" / "审查". */
  kindLabel: string;
  /** Short chip label, e.g. "engine.ts:42". */
  label: string;
  /** Locator key/value lines, in source order. */
  locator: { key: string; value: string }[];
  /** The user's note for this location. */
  comment: string;
}

export interface ParsedAnnotationBlock {
  /** Intro line shown above the entries. */
  header: string;
  entries: ParsedAnnotationEntry[];
}

export interface ExtractedAnnotations {
  /** Parsed annotations block, or null when the text has none. */
  block: ParsedAnnotationBlock | null;
  /** The user's prose with the annotations block removed and trimmed. */
  text: string;
}

const COMMENT_PREFIX = "评论:";

/**
 * Inverse of {@link encodeAnchorsForWire} for display: pull the
 * `<codeshell-annotations>` block out of a sent user turn so the renderer can
 * style it distinctly instead of showing raw XML + `[1] …` lines as prose. The
 * user's own text (which follows the block) is returned separately.
 *
 * Lenient by design — a block whose interior doesn't match the expected entry
 * shape still returns `block: null` and leaves the text untouched rather than
 * throwing, so a hand-typed look-alike never breaks the bubble.
 */
export function extractAnnotations(wire: string): ExtractedAnnotations {
  if (typeof wire !== "string" || wire.indexOf("<codeshell-annotations>") === -1) {
    return { block: null, text: wire ?? "" };
  }
  const m = ANNOTATIONS_BLOCK_RE.exec(wire);
  if (!m) return { block: null, text: wire };

  const inner = m[1];
  // Prose is whatever sits outside the block (encode prepends the block, so the
  // user's text follows it — but splice generically to be safe).
  const text = (wire.slice(0, m.index) + wire.slice(m.index + m[0].length)).trim();

  const lines = inner.split("\n");
  const header = lines.length > 0 ? lines[0] : "";
  const entries: ParsedAnnotationEntry[] = [];
  let current: ParsedAnnotationEntry | null = null;

  // Entry header lines look like "[1] 文件 · engine.ts:42"; locator lines are
  // indented "  key: value"; the comment is the indented "  评论: …" line.
  const ENTRY_HEAD_RE = /^\[\d+\]\s+(.+?)\s+·\s+([\s\S]+)$/;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const head = ENTRY_HEAD_RE.exec(line.trim());
    if (head) {
      if (current) entries.push(current);
      current = { kindLabel: head[1], label: head[2], locator: [], comment: "" };
      continue;
    }
    if (!current) continue;
    const body = line.trim();
    if (body === "") continue;
    if (body.startsWith(COMMENT_PREFIX)) {
      current.comment = body.slice(COMMENT_PREFIX.length).trim();
      continue;
    }
    const sep = body.indexOf(":");
    if (sep > 0) {
      current.locator.push({
        key: body.slice(0, sep).trim(),
        value: body.slice(sep + 1).trim(),
      });
    }
  }
  if (current) entries.push(current);

  if (entries.length === 0) return { block: null, text: wire.trim() };
  return { block: { header, entries }, text };
}

export function encodeAnchorsForWire(text: string, anchors: Anchor[]): string {
  if (anchors.length === 0) return text;
  const blocks = anchors.map((a, i) => {
    const loc = Object.entries(a.locator)
      .map(([k, v]) => `  ${k}: ${sanitize(v)}`)
      .join("\n");
    return [
      `[${i + 1}] ${KIND_LABEL[a.kind]} · ${sanitize(a.label)}`,
      loc,
      `  评论: ${sanitize(a.comment)}`,
    ].join("\n");
  });
  const header =
    "以下是我在界面上标注的位置和评论(请精准定位到这些位置处理):";
  const annotations = "<codeshell-annotations>\n" + header + "\n" + blocks.join("\n\n") + "\n</codeshell-annotations>";
  return text ? `${annotations}\n\n${text}` : annotations;
}

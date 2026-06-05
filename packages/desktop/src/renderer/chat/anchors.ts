// Comment anchors — Codex-style "local comments" that pin a precise location
// (a diff line, a browser element, a file line) plus the user's note, then ride
// along with the next chat message so the model can act on that exact target.
//
// Anchors accumulate as chips above the composer; on submit they're encoded
// into a structured text block prepended to the message. We deliberately send
// structured *text* (not a bespoke protocol) so any model can read it.

export type AnchorKind = "diff" | "browser" | "file";

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

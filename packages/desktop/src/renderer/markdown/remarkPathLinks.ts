/**
 * remark plugin that recognises `path:line` (and `path (line N)`)
 * references inside plain markdown text and rewrites them into
 * autolink nodes pointing at a `codeshell-path:` URL scheme.
 *
 * The Markdown component owns the click handler — it sees the
 * `codeshell-path:` scheme and invokes window.codeshell.openPath()
 * instead of doing a navigation.
 *
 * The matcher is intentionally conservative:
 *   - A "path" looks like one of:
 *       relative/dir/file.ext
 *       packages/x/src/y.ts
 *       ./foo, ../bar/baz
 *       /Users/.../abs/path.md
 *   - It must contain a directory separator AND a file extension OR
 *     be an absolute path. Bare words ("README" by itself) don't
 *     match — too many false positives.
 *   - The optional `:N[:M]` line suffix is preserved in the href so
 *     the IPC layer can surface line info to editors that understand
 *     it.
 *
 * The walker only touches `text` nodes that live OUTSIDE existing
 * link / inlineCode / code blocks so we don't break syntax highlight
 * or rewrite already-clickable links.
 */

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
  position?: unknown;
}

// Hand-rolled regex — anchored to whitespace / sentence-boundary so
// it doesn't grab punctuation. Group 1 = path, group 2 = line.
//
// The boundary classes include CJK punctuation (：，、（「『 …) on both
// sides: the model often writes paths in Chinese prose like "SVG 原图：
// docs/x.svg" with a full-width colon glued to the path. With only the
// ASCII [\s(,] boundary the lookbehind failed there, so the path stayed
// plain text and wasn't clickable. CJK_OPEN are leading delimiters that
// may precede a path; CJK_CLOSE are trailing delimiters that may follow.
const CJK_OPEN = "：:，,、（(「『【《“";
const CJK_CLOSE = "：，、）)」』】》”。；！？";
const PATH_LINE_RE = new RegExp(
  `(?<=^|[\\s(,${CJK_OPEN}])` +
    `((?:\\/|\\.{1,2}\\/|[\\w@.-]+\\/)[\\w./@+\\-]+\\.[\\w]{1,8})` +
    `(?::(\\d+)(?::\\d+)?)?` +
    `(?=$|[\\s),.;!?${CJK_CLOSE}])`,
  "g",
);

const SKIP_PARENTS = new Set(["link", "linkReference", "inlineCode", "code"]);

function makePathLink(pathPart: string, line: string | undefined): MdastNode {
  // Encode into a URL the markdown anchor renderer can recognise.
  const href = line
    ? `codeshell-path:${encodeURIComponent(pathPart)}:${line}`
    : `codeshell-path:${encodeURIComponent(pathPart)}`;
  const displayed = line ? `${pathPart}:${line}` : pathPart;
  return {
    type: "link",
    url: href,
    children: [{ type: "text", value: displayed }],
  };
}

function splitTextNode(node: MdastNode): MdastNode[] | null {
  const value = node.value ?? "";
  PATH_LINE_RE.lastIndex = 0;
  let lastIndex = 0;
  const out: MdastNode[] = [];
  let m: RegExpExecArray | null;
  while ((m = PATH_LINE_RE.exec(value))) {
    const start = m.index;
    const matchLen = m[0]!.length;
    if (start > lastIndex) {
      out.push({ type: "text", value: value.slice(lastIndex, start) });
    }
    out.push(makePathLink(m[1]!, m[2]));
    lastIndex = start + matchLen;
  }
  if (out.length === 0) return null;
  if (lastIndex < value.length) {
    out.push({ type: "text", value: value.slice(lastIndex) });
  }
  return out;
}

function walk(node: MdastNode, parentType: string | null): void {
  if (!node.children) return;
  if (SKIP_PARENTS.has(node.type)) return;
  const next: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && !SKIP_PARENTS.has(node.type)) {
      const replacement = splitTextNode(child);
      if (replacement) {
        for (const r of replacement) next.push(r);
        continue;
      }
    }
    walk(child, node.type);
    next.push(child);
  }
  node.children = next;
}

export function remarkPathLinks() {
  return function transformer(tree: MdastNode): void {
    walk(tree, null);
  };
}

/** The custom URL scheme produced by the plugin. */
export const CODESHELL_PATH_SCHEME = "codeshell-path:";

/**
 * Decode an href produced by makePathLink() back into the
 * (path, line) tuple the IPC layer expects.
 */
export function decodePathHref(
  href: string,
): { path: string; line?: number } | null {
  if (!href.startsWith(CODESHELL_PATH_SCHEME)) return null;
  const rest = href.slice(CODESHELL_PATH_SCHEME.length);
  // The optional :line was appended unencoded after the encoded path.
  const m = /^(.+?)(?::(\d+))?$/.exec(rest);
  if (!m) return null;
  try {
    const path = decodeURIComponent(m[1]!);
    const line = m[2] ? Number(m[2]) : undefined;
    return line !== undefined ? { path, line } : { path };
  } catch {
    return null;
  }
}

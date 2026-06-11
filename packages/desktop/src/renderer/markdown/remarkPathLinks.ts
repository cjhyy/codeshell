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
 * The walker touches `text` nodes that live outside existing link / fenced
 * code blocks. For `inlineCode` (a single-backtick span) it makes ONE
 * exception: when the whole span is exactly a path (the model's most common
 * way of writing one, e.g. `packages/x/foo.ts`), the span itself becomes a
 * clickable path link. Inline code that isn't a lone path — prose, a flag, a
 * symbol — is left as a normal <code> so highlighting/formatting is untouched.
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

// Shared leading-boundary lookbehind: a path may sit at line start or be
// preceded by whitespace / an opening delimiter (ASCII or CJK). Both the
// quoted and bare forms use it so neither links a path glued to the middle of
// a word or a prose contraction (e.g. the apostrophe in "it's").
const LEAD = `(?<=^|[\\s(,${CJK_OPEN}])`;

// Quoted form (group 1 = quote char, group 2 = path, group 3 = optional :line):
// a path wrapped in matching single / double / back quotes. The quotes delimit
// the path explicitly, so it may contain SPACES — essential for macOS
// screenshot paths like '/var/folders/…/截屏2026-06-01 18.39.07.png' that the
// bare matcher (which stops at whitespace) can't capture. The closing quote is
// a backreference (\\1) so open/close must be the SAME char — '…' and "…" pair,
// but '…` doesn't. Requires a "/" and an extension inside so we don't link
// arbitrary quoted prose, and an optional :line[:col] before the close quote.
const QUOTED =
  LEAD +
  `(['"\`])([^'"\`\\n]*?\\/[^'"\`\\n:]*?\\.[\\w]{1,8})(?::(\\d+)(?::\\d+)?)?\\1`;

// Bare form (group 4 = path, group 5 = optional :line): an unquoted path
// bounded by whitespace / sentence punctuation. The boundary classes include
// CJK punctuation (：，、（「『 …) so a path glued to a full-width colon —
// "SVG 原图：docs/x.svg" — is still recognised. Bare paths can't contain
// spaces (no reliable boundary), which is why the quoted form exists.
const BARE =
  LEAD +
  `((?:\\/|\\.{1,2}\\/|[\\w@.-]+\\/)[\\w./@+\\-]+\\.[\\w]{1,8})` +
  `(?::(\\d+)(?::\\d+)?)?` +
  `(?=$|[\\s),.;!?${CJK_CLOSE}])`;

// Bare FILENAME form (no directory): a lone `name.ext` in prose, e.g. the
// model writing "见 dev.ts (line 53)" instead of a full path. Unlike BARE this
// has no "/", so it's far more ambiguous with prose (v1.2, obj.method) — it's
// gated AFTER the match by the KNOWN_FILE_EXT whitelist in splitTextNode, the
// same guard the inlineCode path uses. The leading boundary forbids a preceding
// "/" or "." so we don't re-capture the tail of a path BARE already matched
// (a/b.ts) or a dotted token (.ts of foo.ts). Accepts a `:line` or `(line N)`
// suffix. Group 6 = filename, 7 = :line digits, 8 = (line N) digits.
const BARE_FILENAME =
  `(?<=^|[\\s(${CJK_OPEN}])` +
  `([\\w@-][\\w@.-]*\\.[\\w]{1,8})` +
  `(?::(\\d+)(?::\\d+)?|\\s*\\(line\\s+(\\d+)\\))?` +
  `(?=$|[\\s),.;!?${CJK_CLOSE}]|\\s*\\(line\\s)`;

// Combined: quoted form, then bare-with-directory, then bare filename. Group
// indices: 1 = quote char (backref only), 2 = quoted path, 3 = quoted :line,
// 4 = bare path, 5 = bare :line, 6 = bare filename, 7 = filename :line, 8 =
// filename (line N).
const PATH_LINE_RE = new RegExp(`${QUOTED}|${BARE}|${BARE_FILENAME}`, "g");

/** A bare filename links only when its extension is a known file type. */
function bareFilenameExtOk(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return KNOWN_FILE_EXT.has(name.slice(dot + 1).toLowerCase());
}

const SKIP_PARENTS = new Set(["link", "linkReference", "inlineCode", "code"]);

// Whole-string path matcher for an inlineCode span. The span is already
// delimited by the backticks, so (unlike the bare matcher) the path may contain
// spaces and needs no surrounding boundary — we just require the entire value
// to BE a path ending in an extension, optionally followed by :line[:col].
// Group 1 = path, group 2 = line. A path here is EITHER:
//   - a multi-segment path (has a "/"):  packages/x/foo.ts, /abs/a b.png
//   - a bare filename (no "/"):          README.md, package.json, TODO.md
// The bare-filename case is gated below by a known-extension whitelist so prose
// like `obj.method` or `a.b` isn't mistaken for a file.
// Matches: `packages/x/foo.ts`, `/abs/a b.png`, `src/x.ts:42`, `README.md`.
// Doesn't: `npm run build`, `--flag`, `useState` (no "."), `obj.method` (ext
// not whitelisted).
const INLINE_CODE_PATH_RE = new RegExp(
  `^((?:(?:\\/|\\.{1,2}\\/|[\\w@.-]+\\/)[^\\n:]*?|[\\w][\\w.-]*?)\\.([\\w]{1,8}))(?::(\\d+)(?::\\d+)?)?$`,
);

// Extensions that make a BARE filename (no directory) confidently a file. A
// path WITH a "/" needs no whitelist — the separator already disambiguates it
// from prose. Kept broad but real: code, config, docs, common assets.
const KNOWN_FILE_EXT = new Set([
  // code
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "py", "rs", "go", "java",
  "kt", "rb", "php", "c", "h", "cpp", "hpp", "cc", "cs", "swift", "sh", "bash",
  "zsh", "sql", "css", "scss", "less", "html", "vue", "svelte", "lua", "dart",
  // config / data
  "toml", "yaml", "yml", "ini", "env", "lock", "xml", "gradle", "properties",
  // docs
  "md", "mdx", "markdown", "txt", "rst", "pdf",
  // assets
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "csv", "tsv",
]);

/** If an inlineCode value is exactly one path, return {path, line}; else null. */
function inlineCodePath(value: string): { path: string; line?: string } | null {
  const m = INLINE_CODE_PATH_RE.exec(value.trim());
  if (!m) return null;
  const path = m[1]!;
  const ext = (m[2] ?? "").toLowerCase();
  const hasSlash = path.includes("/");
  if (hasSlash) {
    // Reject a domain-shaped first segment (example.com/x.html) — that's a URL,
    // not a workspace path. Mirrors decodeLocalPathHref's guard.
    const firstSeg = path.split("/", 1)[0] ?? "";
    if (!path.startsWith("/") && !path.startsWith(".") && firstSeg.includes(".")) {
      return null;
    }
  } else if (!KNOWN_FILE_EXT.has(ext)) {
    // Bare filename: only link when the extension is a known file type, so
    // `obj.method` / `a.b` / `v1.2` stay as plain code.
    return null;
  }
  return { path, line: m[3] };
}

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
    // Group 2 = quoted path (3 = its :line); group 4 = bare path with dir (5 =
    // its :line); group 6 = bare filename (7 = :line, 8 = "(line N)"). Group 1
    // is the quote char, a backreference only. A bare filename links only if
    // its extension is whitelisted — otherwise emit it back as plain text so
    // prose like "v1.2" / "obj.method" stays untouched (and the matched span
    // isn't silently dropped).
    if (m[2] !== undefined) {
      out.push(makePathLink(m[2], m[3]));
    } else if (m[4] !== undefined) {
      out.push(makePathLink(m[4], m[5]));
    } else if (m[6] !== undefined && bareFilenameExtOk(m[6])) {
      out.push(makePathLink(m[6], m[7] ?? m[8]));
    } else {
      out.push({ type: "text", value: m[0]! });
    }
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
    // A backtick path span — `packages/x/foo.ts` — becomes a clickable link.
    // (The node never recurses into walk() since inlineCode has no children.)
    if (child.type === "inlineCode" && child.value) {
      const hit = inlineCodePath(child.value);
      if (hit) {
        next.push(makePathLink(hit.path, hit.line));
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

/**
 * Decode an ordinary markdown href when the author wrote a real local path,
 * e.g. `[foo.ts](/Users/me/app/foo.ts:12)` or `[foo](packages/x/foo.ts)`.
 * ReactMarkdown keeps those as normal hrefs, so the renderer needs a second
 * decoder in addition to the synthetic `codeshell-path:` scheme above.
 */
export function decodeLocalPathHref(
  href: string,
): { path: string; line?: number } | null {
  if (!href) return null;
  if (/^(?:https?|mailto|xmpp|irc|ircs):/i.test(href)) return null;
  if (href.startsWith("#")) return null;

  const clean = href.split(/[?#]/, 1)[0] ?? "";
  if (!clean) return null;

  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return null;
  }

  const m = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(decoded);
  if (!m) return null;
  const pathPart = m[1] ?? "";
  const line = m[2] ? Number(m[2]) : undefined;

  // Protocol-relative URL (//host/…) is a web link, never a local path.
  if (pathPart.startsWith("//")) return null;

  const isExplicitLocal =
    pathPart.startsWith("/") ||
    pathPart.startsWith("./") ||
    pathPart.startsWith("../");
  // Bare "seg/more" form: only treat as local when the first segment is NOT
  // domain-shaped. A code dir (packages, src, a_b) has no dot; a host
  // (example.com, www.google.com) does — so a dotted first segment means it's
  // almost certainly a scheme-less URL the author meant to open externally,
  // not a path under the workspace. Without this, `example.com/x.html` and
  // `//cdn/x.js` got linked as local files that openPath can't resolve.
  const firstSeg = pathPart.split("/", 1)[0] ?? "";
  const bareLocal = /^[\w@.-]+\//.test(pathPart) && !firstSeg.includes(".");
  const looksLocal = isExplicitLocal || bareLocal;

  const hasExtension = /\.[\w]{1,12}$/.test(pathPart);
  if (!looksLocal || !hasExtension) return null;

  return line !== undefined ? { path: pathPart, line } : { path: pathPart };
}

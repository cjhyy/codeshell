/**
 * Markdown body renderer.
 *
 * Used for completed assistant messages. While a message is still
 * streaming we render plain text to avoid jitter from re-parsing
 * half-formed markdown on every token.
 *
 * Plugins:
 *   - remark-gfm: tables, strikethrough, task lists, autolinks.
 *   - rehype-highlight: server-side code highlighting via highlight.js.
 *
 * highlight.js' GitHub CSS is bundled at module level — small
 * (~3KB) and gives us a sensible default theme that reads on a light
 * background.
 */

import React, { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";

/**
 * Sanitize schema for the raw HTML that rehype-raw now lets through. This is a
 * SECURITY boundary: the same <Markdown> renders untrusted assistant/LLM output
 * (and content the agent relayed from fetched web pages), so raw HTML must be
 * scrubbed of <script>, event handlers (onerror/onclick), <iframe>, etc. We
 * start from rehype's safe default and only widen it for the benign formatting
 * a README uses: <img> with width/height/align, and center alignment on
 * p/div/span. highlight.js className/style on code spans is also allowed so the
 * later rehype-highlight pass survives sanitization.
 */
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  // Allow our internal path-link scheme (remarkPathLinks rewrites file paths to
  // `codeshell-path:` hrefs/srcs). Without this, sanitize drops the scheme and
  // every in-answer file/image link goes dead. http(s)/data/etc. stay from the
  // default whitelist; everything else is still scrubbed.
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "codeshell-path"],
    src: [...(defaultSchema.protocols?.src ?? []), "codeshell-path"],
  },
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height", "align"],
    p: [...(defaultSchema.attributes?.p ?? []), "align"],
    div: [...(defaultSchema.attributes?.div ?? []), "align"],
    span: [...(defaultSchema.attributes?.span ?? []), ["className"], ["style"]],
    code: [...(defaultSchema.attributes?.code ?? []), ["className"]],
    // highlight.js wraps tokens in <span class="hljs-…"> — keep class globally
    // on the elements it touches so syntax highlighting isn't stripped.
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className"],
  },
};
import { Copy } from "./ui/icons";
import {
  remarkPathLinks,
  decodePathHref,
  decodeLocalPathHref,
  CODESHELL_PATH_SCHEME,
} from "./markdown/remarkPathLinks";
import { classifyPath } from "./tool-cards/attachments";
import { Lightbox } from "./chat/Lightbox";
import { useToast } from "./ui/ToastProvider";

interface Props {
  text: string;
  /**
   * Workspace dir for the session this message belongs to. Used to resolve
   * relative image paths (e.g. `docs/x.png`) to an absolute `file://` URL so
   * the inline thumbnail can load. Omitted in contexts with no workspace
   * (skill/agent bodies) — relative image paths there degrade to a link.
   */
  cwd?: string | null;
}

/**
 * Memoized — re-parses markdown only when `text` actually changes.
 * Without memo, every dispatch from a streaming text_delta would
 * re-run ReactMarkdown/remark-gfm/rehype-highlight on every completed
 * assistant message in the transcript, which is the dominant cost
 * in long sessions.
 */
function MarkdownImpl({ text, cwd }: Props) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkPathLinks]}
        // rehype-raw parses raw HTML embedded in markdown (e.g. a README's
        // `<p align="center"><img …></p>`) into real hast nodes so our `img`/`a`
        // component overrides apply to them too. rehype-sanitize IMMEDIATELY
        // after scrubs that HTML (script/iframe/event-handlers) — required
        // because this same renderer shows untrusted assistant/LLM output.
        // Order: raw → sanitize → highlight (highlight adds hljs spans last, so
        // sanitize must precede it or it'd strip the highlight classNames).
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, SANITIZE_SCHEMA],
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
        urlTransform={(url) =>
          url.startsWith(CODESHELL_PATH_SCHEME) ? url : defaultUrlTransform(url)
        }
        components={{
          img: ({ src, alt, node: _node, ...rest }) => {
            const localDecoded = src ? decodeLocalPathHref(src) : null;
            if (localDecoded && classifyPath(localDecoded.path) === "image") {
              return <InlineImageLink path={localDecoded.path} cwd={cwd} alt={alt} />;
            }
            // A plain local/relative image src (e.g. a README's
            // `<img src="docs/images/x.png">` or markdown `![](docs/x.png)`)
            // can't load via file:// (webSecurity + CSP `img-src 'self' data:`).
            // Route it through InlineImageLink, which resolves it against cwd
            // and loads the bytes as a data: URL. data:/http(s)/blob srcs are
            // already loadable, so leave those as a plain <img>.
            if (src && !/^(data:|https?:|blob:)/i.test(src)) {
              return <InlineImageLink path={src} cwd={cwd} alt={alt} />;
            }
            return <img src={src} alt={alt} {...rest} />;
          },
          a: ({ href, children, node: _node, ...rest }) => {
            const schemeDecoded = href ? decodePathHref(href) : null;
            const localDecoded = href ? decodeLocalPathHref(href) : null;
            const decoded = schemeDecoded ?? localDecoded;
            const isPathLink = decoded !== null;
            // Inline-render image/SVG artifacts (GenerateImage output,
            // Playwright screenshots, generated SVGs) as a thumbnail right
            // in the answer, so the user sees the picture instead of an
            // unclickable path. Click opens a full-screen Lightbox; the
            // filename caption still opens the file in the OS app.
            if (schemeDecoded && classifyPath(schemeDecoded.path) === "image") {
              return <InlineImageLink path={schemeDecoded.path} cwd={cwd} />;
            }
            if (localDecoded && classifyPath(localDecoded.path) === "image") {
              return <InlineImageLink path={localDecoded.path} cwd={cwd} />;
            }
            // A path reference: render it as a file link ONLY if the file
            // actually exists in the workspace (checked async in PathLink).
            // Missing files fall back to plain text, so a path the model
            // invented — or `obj.method` shaped like a path — never becomes a
            // dead link. The link shows just the filename; hover reveals the
            // full path.
            if (isPathLink && decoded) {
              return (
                <PathLink
                  path={decoded.path}
                  line={decoded.line}
                  cwd={cwd}
                  isScheme={schemeDecoded !== null}
                >
                  {children}
                </PathLink>
              );
            }
            return (
              <a
                href={href}
                {...rest}
                onClick={(e) => {
                  if (!href) return;
                  if (/^https?:/i.test(href)) {
                    e.preventDefault();
                    // Open web links in the in-app browser panel, not the OS
                    // browser. Holding ⌘/Ctrl falls back to the external browser.
                    if (e.metaKey || e.ctrlKey) {
                      void window.codeshell.openExternal(href);
                    } else {
                      window.dispatchEvent(
                        new CustomEvent("codeshell:open-url", { detail: { url: href } }),
                      );
                    }
                  }
                }}
              >
                {children}
              </a>
            );
          },
          // Wrap multi-line code blocks with a header bar showing the
          // language label (when react-markdown supplies a `language-*`
          // class) and a copy button. Inline `code` (no language class
          // and no newline) is left as-is.
          pre: ({ children, ...rest }) => {
            // The child should be a single <code> element whose
            // className looks like "language-ts" when GFM/rehype-highlight
            // resolved a language.
            return <CodeBlock {...rest}>{children}</CodeBlock>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);

/** Last path segment — the filename we show as the link label. */
function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** Resolve a (possibly relative) path against cwd into an absolute path for the
 *  hover tooltip. Absolute paths pass through; relative joins onto cwd. */
function toAbsolute(path: string, cwd?: string | null): string {
  if (path.startsWith("/")) return path;
  if (!cwd) return path;
  return `${cwd.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;
}

// Existence-check cache: keyed by `${cwd}\0${path}`. A path can appear many
// times across a transcript; this keeps repeated answers from re-hitting the
// fs:exists IPC for the same file. Holds a Promise so concurrent mounts of the
// same path share one in-flight check.
const existsCache = new Map<string, Promise<boolean>>();
function checkExists(cwd: string | null, path: string): Promise<boolean> {
  const root = cwd ?? "";
  const key = `${root}\0${path}`;
  let p = existsCache.get(key);
  if (!p) {
    // No workspace root → can't resolve a relative path; treat absolute-only.
    p = root || path.startsWith("/")
      ? window.codeshell.fileExists(root || "/", path).catch(() => false)
      : Promise.resolve(false);
    existsCache.set(key, p);
  }
  return p;
}

/**
 * A file path mentioned in an answer. We confirm the file EXISTS in the
 * workspace before making it clickable — a path the model invented, or a
 * dotted token shaped like a path (`obj.method`), resolves to nothing and
 * stays plain text. When it does exist the label is just the filename;
 * hovering shows the full (absolute) path. Click opens it in the Files panel;
 * ⌘/Ctrl-click escapes to the OS editor.
 */

/**
 * Shared click contract for any clickable file-path in an answer: a plain click
 * opens the internal Files panel; ⌘/Ctrl-click escapes to the OS default app.
 * Used by PathLink and by InlineImageLink's caption/fallback so image paths
 * follow the same rule (#13 — image-path captions used to always open the OS
 * app because they called openPath directly with no modifier check).
 */
function openFileTarget(
  e: React.MouseEvent,
  opts: { path: string; cwd?: string | null; line?: number; isScheme?: boolean },
): void {
  e.preventDefault();
  const { path, cwd, line, isScheme } = opts;
  const toOsApp = e.metaKey || e.ctrlKey;
  if (toOsApp) {
    const arg = line ? `${path}:${line}` : path;
    // Scheme links resolve relative paths in main; local links need cwd.
    void window.codeshell.openPath(arg, isScheme ? undefined : cwd ?? undefined);
  } else {
    window.dispatchEvent(
      new CustomEvent("codeshell:open-file", { detail: { path, cwd: cwd ?? null } }),
    );
  }
}

function PathLink({
  path,
  line,
  cwd,
  isScheme,
  children,
}: {
  path: string;
  line?: number;
  cwd?: string | null;
  /** True when the link came from the codeshell-path: scheme (vs a local href). */
  isScheme: boolean;
  children?: React.ReactNode;
}) {
  // null = still checking; true/false once known. While checking we render
  // plain text (no flash of a link that might turn out dead).
  const [exists, setExists] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setExists(null);
    void checkExists(cwd ?? null, path).then((ok) => {
      if (!cancelled) setExists(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [path, cwd]);

  // Not (yet) a known-existing file → render the original text, unstyled.
  if (exists !== true) {
    return <span>{children}</span>;
  }

  const abs = toAbsolute(path, cwd);
  const tooltip = line ? `${abs}:${line}` : abs;
  const label = basename(path);

  return (
    <a
      href="#"
      data-path-link="true"
      className="md-file-link"
      title={tooltip}
      onClick={(e) => openFileTarget(e, { path, cwd, line, isScheme })}
    >
      <span className="md-file-link-label">{label}</span>
    </a>
  );
}

/**
 * Inline thumbnail for an image/SVG path mentioned in an assistant answer.
 * Loads the bytes via the images:readDataUrl IPC (returns a base64 data: URL)
 * because the renderer can't use `file://` — webSecurity blocks it and the CSP
 * only allows `img-src 'self' data:`. Clicking the thumbnail opens a
 * full-screen Lightbox; the filename caption opens the file in the internal
 * Files panel (⌘/Ctrl-click → OS default app), same as a normal path link.
 * Until the data URL resolves (and if it fails — relative path with no cwd,
 * deleted file, non-image), it shows a clickable filename link instead.
 */
function InlineImageLink({
  path,
  cwd,
  alt,
}: {
  path: string;
  cwd?: string | null;
  alt?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const filename = path.split("/").pop() ?? path;
  // Resolve to an absolute path, then load via the images:readDataUrl IPC.
  // We can't use `file://` directly — webSecurity blocks it and the CSP only
  // allows `img-src 'self' data:`. Main reads the bytes and returns a
  // base64 data: URL. Absolute paths used as-is; relative (docs/x.png) joined
  // onto the session workspace.
  const isAbs = path.startsWith("/");
  const abs = isAbs ? path : cwd ? `${cwd.replace(/\/$/, "")}/${path}` : null;
  // Tri-state: while the IPC is in flight we render nothing rather than the
  // fallback link, so a valid image doesn't flash "link → thumbnail" on every
  // mount. The link only shows once we know the image won't load (`failed`).
  const [loading, setLoading] = useState(Boolean(abs));

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    if (!abs) {
      setLoading(false);
      setFailed(true);
      return;
    }
    setLoading(true);
    void window.codeshell.readImageDataUrl(abs).then((dataUrl) => {
      if (cancelled) return;
      setLoading(false);
      if (dataUrl) setSrc(dataUrl);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [abs]);

  if (loading) {
    return (
      <span className="md-inline-image">
        <button
          type="button"
          className="md-inline-image-name"
          title={path}
          onClick={(e) => openFileTarget(e, { path, cwd })}
        >
          {filename}
        </button>
      </span>
    );
  }

  if (!src || failed) {
    // Couldn't resolve to an absolute path (relative with no cwd) or the image
    // failed to load — degrade to a clickable link that shows only the
    // filename, not the full path. Click opens the file via openPath (which
    // resolves the relative path against cwd on the main side).
    return (
      <a
        href="#"
        data-path-link="true"
        title={path}
        onClick={(e) => openFileTarget(e, { path, cwd })}
      >
        {filename}
      </a>
    );
  }

  return (
    <span className="md-inline-image">
      <img
        className="md-inline-image-thumb"
        src={src}
        alt={alt ?? filename}
        loading="lazy"
        onError={() => setFailed(true)}
        onClick={() => setZoomed(true)}
      />
      <button
        type="button"
        className="md-inline-image-name"
        title={path}
        onClick={(e) => openFileTarget(e, { path, cwd })}
      >
        {filename}
      </button>
      {zoomed && (
        <Lightbox
          src={src}
          alt={alt ?? filename}
          path={path}
          cwd={cwd}
          name={filename}
          onClose={() => setZoomed(false)}
        />
      )}
    </span>
  );
}

/** Long code blocks (> this many lines) collapse to a scrollable, capped box
 *  with an expand toggle so a 500-line paste doesn't dominate the transcript. */
const CODE_COLLAPSE_LINES = 24;

function CodeBlock({ children, ...rest }: React.HTMLAttributes<HTMLPreElement>) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const toast = useToast();

  // Clear the "copied" reset timer on unmount so it doesn't fire setCopied on
  // an unmounted component (React warning / leak).
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  let lang = "";
  // Read the language off the inner <code> className.
  const child = React.Children.toArray(children)[0] as
    | React.ReactElement<{ className?: string }>
    | undefined;
  if (child?.props?.className) {
    const m = /language-([\w-]+)/.exec(child.props.className);
    if (m) lang = m[1];
  }

  // Line count drives the collapse affordance. Derived from the raw text so it
  // doesn't depend on layout/measurement (works in tests + on first paint).
  const codeText = typeof child?.props === "object"
    ? extractText(child)
    : "";
  const lineCount = codeText ? codeText.replace(/\n$/, "").split("\n").length : 0;
  const collapsible = lineCount > CODE_COLLAPSE_LINES;
  const collapsed = collapsible && !expanded;

  const onCopy = (): void => {
    const text = preRef.current?.textContent ?? "";
    void navigator.clipboard.writeText(text);
    setCopied(true);
    toast({ message: "已复制代码", variant: "success" });
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="md-code">
      <div className="md-code-head">
        {lang && <span className="md-code-lang">{lang}</span>}
        <button className="md-code-copy" onClick={onCopy} aria-label="copy code">
          <Copy size={11} /> {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre ref={preRef} {...rest} className={collapsed ? "md-code-collapsed" : undefined}>
        {children}
      </pre>
      {collapsible && (
        <button
          type="button"
          className="md-code-expand"
          onClick={() => setExpanded((v) => !v)}
        >
          {collapsed ? `展开全部 (${lineCount} 行)` : "收起"}
        </button>
      )}
    </div>
  );
}

/** Recursively pull text out of react-markdown's code children for line counting. */
function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

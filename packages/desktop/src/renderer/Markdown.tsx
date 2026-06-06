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
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import { Copy } from "./ui/icons";
import {
  remarkPathLinks,
  decodePathHref,
  decodeLocalPathHref,
  CODESHELL_PATH_SCHEME,
} from "./markdown/remarkPathLinks";
import { classifyPath } from "./tool-cards/attachments";
import { Lightbox } from "./chat/Lightbox";

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
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        urlTransform={(url) =>
          url.startsWith(CODESHELL_PATH_SCHEME) ? url : defaultUrlTransform(url)
        }
        components={{
          img: ({ src, alt, node: _node, ...rest }) => {
            const localDecoded = src ? decodeLocalPathHref(src) : null;
            if (localDecoded && classifyPath(localDecoded.path) === "image") {
              return <InlineImageLink path={localDecoded.path} cwd={cwd} alt={alt} />;
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
            const pathTarget = decoded ? formatPathTarget(decoded.path, decoded.line) : "";
            const showPathTarget = localDecoded !== null;
            return (
              <a
                href={href}
                {...rest}
                {...(isPathLink ? { "data-path-link": "true" } : {})}
                className={isPathLink ? "md-file-link" : rest.className}
                title={isPathLink ? pathTarget : rest.title}
                onClick={(e) => {
                  if (!href) return;
                  e.preventDefault();
                  if (href.startsWith(CODESHELL_PATH_SCHEME) && decoded) {
                    const arg = decoded.line
                      ? `${decoded.path}:${decoded.line}`
                      : decoded.path;
                    void window.codeshell.openPath(arg);
                    return;
                  }
                  if (localDecoded) {
                    void window.codeshell.openPath(pathTarget, cwd ?? undefined);
                    return;
                  }
                  if (/^https?:/i.test(href)) {
                    void window.codeshell.openExternal(href);
                  }
                }}
              >
                {isPathLink ? (
                  <>
                    <span className="md-file-link-label">{children}</span>
                    {showPathTarget && (
                      <span className="md-file-link-target">{pathTarget}</span>
                    )}
                  </>
                ) : (
                  children
                )}
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

function formatPathTarget(path: string, line?: number): string {
  return line ? `${path}:${line}` : path;
}

/**
 * Inline thumbnail for an image/SVG path mentioned in an assistant answer.
 * Loads the bytes via the images:readDataUrl IPC (returns a base64 data: URL)
 * because the renderer can't use `file://` — webSecurity blocks it and the CSP
 * only allows `img-src 'self' data:`. Clicking the thumbnail opens a
 * full-screen Lightbox; the filename caption opens the file in the OS default
 * app. Until the data URL resolves (and if it fails — relative path with no
 * cwd, deleted file, non-image), it shows a clickable filename link instead.
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
          onClick={() => void window.codeshell.openPath(path, cwd ?? undefined)}
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
        onClick={(e) => {
          e.preventDefault();
          void window.codeshell.openPath(path, cwd ?? undefined);
        }}
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
        onClick={() => void window.codeshell.openPath(path, cwd ?? undefined)}
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

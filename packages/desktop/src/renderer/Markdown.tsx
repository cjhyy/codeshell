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

import React, { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { openFileTarget } from "./chat/openWith";
import { useToast } from "./ui/ToastProvider";
import { useT } from "./i18n/I18nProvider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

export const markdownBodyClassName =
  "max-w-[720px] text-sm leading-relaxed text-foreground " +
  "[&_p]:my-2 [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-xl [&_h1]:font-semibold " +
  "[&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-lg [&_h2]:font-semibold " +
  "[&_h3]:mb-1.5 [&_h3]:mt-2.5 [&_h3]:text-base [&_h3]:font-semibold " +
  "[&_h4]:mb-1 [&_h4]:mt-2 [&_h4]:font-semibold [&_ul]:my-2 [&_ol]:my-2 " +
  // Tailwind v4 preflight resets ul/ol to `list-style: none`; restore the
  // bullet/number markers so standard markdown lists show prefixes. list-outside
  // keeps the marker within the pl-6 indent.
  "[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:list-outside [&_ol]:list-outside " +
  "[&_ul]:pl-6 [&_ol]:pl-6 [&_li]:my-1 [&_blockquote]:my-2 " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 " +
  "[&_blockquote]:text-muted-foreground [&_a]:text-primary [&_a]:underline-offset-2 " +
  "[&_a:hover]:underline [&_code:not(pre_code)]:rounded-sm [&_code:not(pre_code)]:bg-muted " +
  "[&_code:not(pre_code)]:px-1.5 [&_code:not(pre_code)]:py-0.5 " +
  "[&_code:not(pre_code)]:font-mono [&_code:not(pre_code)]:text-[0.92em] " +
  "[&_table]:my-2 [&_table]:border-collapse [&_table]:text-xs " +
  "[&_th]:border [&_td]:border [&_th]:border-border [&_td]:border-border " +
  "[&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1";

export const streamingMarkdownClassName = cn(
  markdownBodyClassName,
  "text-muted-foreground [&_pre]:m-0 [&_pre]:whitespace-pre-wrap [&_pre]:border-0 [&_pre]:bg-transparent [&_pre]:p-0 [&_pre]:font-sans",
);

/**
 * Memoized — re-parses markdown only when `text` actually changes.
 * Without memo, every dispatch from a streaming text_delta would
 * re-run ReactMarkdown/remark-gfm/rehype-highlight on every completed
 * assistant message in the transcript, which is the dominant cost
 * in long sessions.
 */
function MarkdownImpl({ text, cwd }: Props) {
  return (
    <div className={markdownBodyClassName}>
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

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function joinPath(cwd: string, path: string): string {
  const sep = cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${sep}${path.replace(/^\.\//, "")}`;
}

/** Resolve a (possibly relative) path against cwd into an absolute path for the
 *  hover tooltip. Absolute paths pass through; relative joins onto cwd. */
function toAbsolute(path: string, cwd?: string | null): string {
  if (isAbsolutePath(path)) return path;
  if (!cwd) return path;
  return joinPath(cwd, path);
}

// Existence-check cache: keyed by `${cwd}\0${path}`. A path can appear many
// times across a transcript; this keeps repeated answers from re-hitting the
// fs:exists IPC for the same file.
//
// We cache ONLY positive results. A file that exists won't stop existing mid
// session, so `true` is safe to memoize forever. A `false` is NOT: the model
// very often writes a path to a file it CREATES this same turn, and the first
// existence check races the write — the file isn't on disk yet, so fs:exists
// returns false. Caching that false permanently pinned the link as dead text,
// and it only came back after a session switch happened to build a new cache
// key (the "刚输出点不了,切一下 session 才能点" bug). So a negative check is
// re-run on the next mount, and `files-changed` (fired when an AI turn ends)
// also clears the cache so a just-written file re-validates immediately.
const existsCache = new Map<string, boolean>();
function checkExists(cwd: string | null, path: string): Promise<boolean> {
  const root = cwd ?? "";
  const key = `${root}\0${path}`;
  if (existsCache.get(key) === true) return Promise.resolve(true);
  // No workspace root → can't resolve a relative path; treat absolute-only.
  const p =
    root || isAbsolutePath(path)
      ? window.codeshell.fileExists(root || "/", path).catch(() => false)
      : Promise.resolve(false);
  return p.then((ok) => {
    if (ok) existsCache.set(key, true); // memoize positives only
    return ok;
  });
}

// A bump source so PathLink re-checks existence after an AI turn writes files.
// files-changed carries no payload, so we clear the whole cache and nudge every
// mounted PathLink to re-run its check via useSyncExternalStore.
let filesChangedNonce = 0;
const filesChangedListeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("codeshell:files-changed", () => {
    existsCache.clear();
    filesChangedNonce++;
    for (const l of filesChangedListeners) l();
  });
}
function subscribeFilesChanged(cb: () => void): () => void {
  filesChangedListeners.add(cb);
  return () => filesChangedListeners.delete(cb);
}

/**
 * A file path mentioned in an answer. We confirm the file EXISTS in the
 * workspace before making it clickable — a path the model invented, or a
 * dotted token shaped like a path (`obj.method`), resolves to nothing and
 * stays plain text. When it does exist the label is just the filename;
 * hovering shows the full (absolute) path. Click opens it in the Files panel;
 * ⌘/Ctrl-click escapes to the OS editor.
 */

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

  // Re-checks existence when an AI turn writes files (see filesChangedNonce):
  // a path to a just-created file whose FIRST check raced the write (→ false)
  // re-validates and becomes clickable without a session switch.
  const filesNonce = useSyncExternalStore(
    subscribeFilesChanged,
    () => filesChangedNonce,
    () => 0,
  );

  useEffect(() => {
    let cancelled = false;
    // Don't blink an already-resolved link back to plain text on a re-check;
    // only show the neutral "checking" state on a genuinely new path/cwd.
    setExists((prev) => (prev === true ? true : null));
    void checkExists(cwd ?? null, path).then((ok) => {
      if (!cancelled) setExists(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [path, cwd, filesNonce]);

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
      className="inline-flex max-w-full items-baseline rounded-sm px-0.5 font-mono text-primary underline-offset-2 hover:bg-primary/10 hover:underline"
      title={tooltip}
      onClick={(e) => openFileTarget(e, { path, cwd, line, isScheme })}
    >
      <span className="truncate">{label}</span>
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
  const isAbs = isAbsolutePath(path);
  const abs = isAbs ? path : cwd ? joinPath(cwd, path) : null;
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
      <span className="my-2 inline-flex max-w-full flex-col gap-1 align-top">
        <Button
          type="button"
          variant="link"
          className="h-auto justify-start p-0 font-mono text-xs"
          title={path}
          onClick={(e) => openFileTarget(e, { path, cwd })}
        >
          {filename}
        </Button>
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
    <span className="my-2 inline-flex max-w-full flex-col gap-1 align-top">
      <img
        className="max-h-80 max-w-full cursor-zoom-in rounded-md border object-contain"
        src={src}
        alt={alt ?? filename}
        loading="lazy"
        onError={() => setFailed(true)}
        onClick={() => setZoomed(true)}
      />
      <Button
        type="button"
        variant="link"
        className="h-auto justify-start p-0 font-mono text-xs"
        title={path}
        onClick={(e) => openFileTarget(e, { path, cwd })}
      >
        {filename}
      </Button>
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
  const { t } = useT();

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
    toast({ message: t("msg.markdown.copyCode"), variant: "success" });
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-2 overflow-hidden rounded-md border bg-muted/30">
      <div className="flex min-h-8 items-center justify-between gap-2 border-b bg-muted/50 px-2 py-1">
        {lang && <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{lang}</span>}
        <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-2 text-xs" onClick={onCopy} aria-label={t("msg.markdown.copyCodeAria")}>
          <Copy size={11} /> {copied ? t("msg.markdown.copied") : t("msg.markdown.copy")}
        </Button>
      </div>
      <pre
        ref={preRef}
        {...rest}
        className={cn("overflow-x-auto p-3 text-xs", collapsed && "max-h-96 overflow-y-auto")}
      >
        {children}
      </pre>
      {collapsible && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-full rounded-none border-t text-xs text-muted-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {collapsed ? t("msg.markdown.expandAll", { count: lineCount }) : t("msg.markdown.collapse")}
        </Button>
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

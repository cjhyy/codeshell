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

import React, { memo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import { Copy } from "./ui/icons";
import {
  remarkPathLinks,
  decodePathHref,
  CODESHELL_PATH_SCHEME,
} from "./markdown/remarkPathLinks";

interface Props {
  text: string;
}

/**
 * Memoized — re-parses markdown only when `text` actually changes.
 * Without memo, every dispatch from a streaming text_delta would
 * re-run ReactMarkdown/remark-gfm/rehype-highlight on every completed
 * assistant message in the transcript, which is the dominant cost
 * in long sessions.
 */
function MarkdownImpl({ text }: Props) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkPathLinks]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ href, children, ...rest }) => {
            const decoded = href ? decodePathHref(href) : null;
            const isPathLink = decoded !== null;
            return (
              <a
                href={href}
                {...rest}
                {...(isPathLink ? { "data-path-link": "true" } : {})}
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
                  if (/^https?:/i.test(href)) {
                    void window.codeshell.openExternal(href);
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

function CodeBlock({ children, ...rest }: React.HTMLAttributes<HTMLPreElement>) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  let lang = "";
  // Read the language off the inner <code> className.
  const child = React.Children.toArray(children)[0] as
    | React.ReactElement<{ className?: string }>
    | undefined;
  if (child?.props?.className) {
    const m = /language-([\w-]+)/.exec(child.props.className);
    if (m) lang = m[1];
  }

  const onCopy = (): void => {
    const text = preRef.current?.textContent ?? "";
    void navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="md-code">
      <div className="md-code-head">
        {lang && <span className="md-code-lang">{lang}</span>}
        <button className="md-code-copy" onClick={onCopy} aria-label="copy code">
          <Copy size={11} /> {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre ref={preRef} {...rest}>
        {children}
      </pre>
    </div>
  );
}

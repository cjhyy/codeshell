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

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";

interface Props {
  text: string;
}

export function Markdown({ text }: Props) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          // Open links in the user's default browser, not inside the
          // electron renderer. The renderer has no chrome to navigate
          // back from, so any link click would trap them.
          a: ({ href, children, ...rest }) => (
            <a
              href={href}
              {...rest}
              onClick={(e) => {
                if (!href) return;
                e.preventDefault();
                window.open(href, "_blank", "noopener,noreferrer");
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

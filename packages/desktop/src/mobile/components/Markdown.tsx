/**
 * Lightweight Markdown renderer for the phone client.
 *
 * The desktop renderer's <Markdown> is coupled to Electron IPC (file-exists
 * checks, image data-URL loading, openExternal, Lightbox/toast/i18n providers)
 * that the phone has none of — the mobile client talks to the host over a
 * WebSocket, not window.codeshell. So this is a deliberately self-contained
 * version: react-markdown + remark-gfm (both already in the bundle) with
 * rehype-sanitize as the security boundary (the same content can be untrusted
 * assistant/LLM output), and mobile-tuned typography. No IPC, no plugins that
 * reach into the host.
 *
 * Streaming text renders as plain text upstream (MessageStream) to avoid
 * re-parsing half-formed markdown every token; this component is for completed
 * (done) assistant prose.
 */
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

const bodyClassName =
  "text-[15px] leading-6 text-foreground " +
  "[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 " +
  "[&_h1]:mb-1.5 [&_h1]:mt-2 [&_h1]:text-lg [&_h1]:font-semibold " +
  "[&_h2]:mb-1.5 [&_h2]:mt-2 [&_h2]:text-base [&_h2]:font-semibold " +
  "[&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold " +
  "[&_ul]:my-1.5 [&_ol]:my-1.5 [&_ul]:list-disc [&_ol]:list-decimal " +
  "[&_ul]:list-outside [&_ol]:list-outside [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-0.5 " +
  "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border " +
  "[&_blockquote]:pl-2.5 [&_blockquote]:text-muted-foreground " +
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a]:break-words " +
  "[&_code:not(pre_code)]:rounded-sm [&_code:not(pre_code)]:bg-muted " +
  "[&_code:not(pre_code)]:px-1 [&_code:not(pre_code)]:py-0.5 " +
  "[&_code:not(pre_code)]:font-mono [&_code:not(pre_code)]:text-[0.88em] [&_code:not(pre_code)]:break-words " +
  "[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted/40 " +
  "[&_pre]:p-2.5 [&_pre]:text-[12px] [&_pre]:font-mono " +
  "[&_table]:my-1.5 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto " +
  "[&_table]:border-collapse [&_table]:text-xs " +
  "[&_th]:border [&_td]:border [&_th]:border-border [&_td]:border-border " +
  "[&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1 " +
  "[&_img]:max-w-full [&_img]:rounded-md [&_hr]:my-3 [&_hr]:border-border";

function MarkdownImpl({ text }: { text: string }) {
  return (
    <div className={bodyClassName}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Untrusted assistant/LLM output → sanitize is mandatory. We don't enable
        // rehype-raw (no need for embedded HTML on the phone), so the default
        // sanitize schema is sufficient: it scrubs script/iframe/event handlers
        // while keeping standard markdown-derived elements.
        rehypePlugins={[rehypeSanitize]}
        components={{
          // Phone has no in-app browser routing; open web links externally in the
          // device browser (a normal target=_blank). rel guards tab-nabbing.
          a: ({ href, children, ...rest }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
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

/** Memoized: only re-parses when `text` changes (long feeds re-render often). */
export const Markdown = memo(MarkdownImpl);

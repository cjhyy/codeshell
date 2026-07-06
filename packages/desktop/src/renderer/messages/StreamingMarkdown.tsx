import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Markdown,
  MarkdownTable,
  markdownBodyClassName,
  streamingMarkdownClassName,
} from "../Markdown";
import { splitStreamingMarkdown } from "../markdown/splitStreamingMarkdown";

interface StreamingMarkdownProps {
  text: string;
  /** True once the turn/agent finished — switches to the full Markdown pipeline. */
  done: boolean;
  /** Session workspace dir — lets the done Markdown resolve relative image paths. */
  cwd?: string | null;
  /**
   * When false, streaming falls back to today's plain `<pre>` (feature-flag /
   * conservative rollback). Defaults to true (rich streaming render).
   */
  streamingRichRender?: boolean;
}

/**
 * The done/streaming split for assistant + agent message bodies, hoisted out of
 * the three inline `done ? <Markdown/> : <pre>` sites into one place.
 *
 *  - done → full `<Markdown>` pipeline (highlight, raw→sanitize, path links).
 *  - streaming + rich → stable-prefix markdown + active-tail plain text.
 *  - streaming + !rich → today's plain `<pre>` (byte-identical fallback).
 *  - empty text → nothing.
 */
export function StreamingMarkdown({
  text,
  done,
  cwd,
  streamingRichRender = true,
}: StreamingMarkdownProps) {
  if (text === "") return null;
  if (done) return <Markdown text={text} cwd={cwd} />;
  if (!streamingRichRender) {
    return (
      <div className={streamingMarkdownClassName}>
        <pre className="whitespace-pre-wrap font-sans">{text}</pre>
      </div>
    );
  }
  return <StreamingMarkdownBody text={text} />;
}

/** Throttle a fast-changing value: emit at most once per `ms`, always eventually
 *  settling on the latest value. Unlike useDeferredValue this is a HARD rate cap
 *  — needed because each prefix change re-parses O(prefix) markdown (N2/C4). */
function useThrottled<T>(value: T, ms: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastRef.current;
    if (elapsed >= ms) {
      lastRef.current = now;
      setThrottled(value);
      return;
    }
    // Schedule a trailing update so we always land on the latest value.
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      lastRef.current = Date.now();
      setThrottled(value);
    }, ms - elapsed);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value, ms]);
  return throttled;
}

const PREFIX_THROTTLE_MS = 120;

/**
 * Stable-prefix + active-tail streaming renderer.
 *
 * The prefix is split into blank-line-separated CHUNKS, each rendered by a
 * memoized narrow-pipeline component. Only the newest chunk re-parses as it
 * grows; already-settled chunks keep a stable string and skip re-render (C4) —
 * this is what bounds per-tick cost instead of re-parsing the whole prefix.
 *
 * The active tail is plain text (zero pipeline cost), so the still-arriving
 * content shows as source until it crosses a blank-line boundary and settles.
 */
function StreamingMarkdownBody({ text }: { text: string }) {
  // Throttle the whole split so a burst of tokens doesn't re-parse every frame.
  // Prefix AND tail come from the SAME (throttled) split so no content ever
  // falls between them mid-window (a block that just settled in the live split
  // but not yet in the throttled prefix would otherwise vanish from both). The
  // 120ms cap is imperceptible for the source view and keeps them consistent.
  const throttledText = useThrottled(text, PREFIX_THROTTLE_MS);
  const { stablePrefix, activeTail } = useMemo(
    () => splitStreamingMarkdown(throttledText),
    [throttledText],
  );

  const chunks = useMemo(() => splitIntoChunks(stablePrefix), [stablePrefix]);

  return (
    <div className={markdownBodyClassName}>
      {chunks.map((chunk, i) => (
        <StreamMarkdownChunk key={i} text={chunk} />
      ))}
      {activeTail.trim() !== "" && (
        <pre className="m-0 whitespace-pre-wrap border-0 bg-transparent p-0 font-sans text-muted-foreground">
          {activeTail.replace(/^\n+/, "")}
        </pre>
      )}
    </div>
  );
}

/** Split a stable prefix on blank-line boundaries into independently-parseable
 *  chunks. Each chunk is a self-contained block group (paragraphs, lists, closed
 *  code blocks) so parsing them separately matches parsing them together. */
function splitIntoChunks(prefix: string): string[] {
  if (prefix === "") return [];
  return prefix
    .split(/\n{2,}/)
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

/**
 * One stable prefix chunk, narrow pipeline: remark-gfm ONLY.
 *
 * Security (N1): no `rehypeRaw` → raw HTML is escaped, not parsed, so
 * `<script>`/`<iframe>`/`<img onerror>` in the stream can't execute. We pass NO
 * custom `urlTransform`, so react-markdown's built-in `defaultUrlTransform`
 * runs and strips `javascript:`/`vbscript:`/`file:` from links/images. Do NOT
 * add a custom urlTransform here without also re-adding rehypeSanitize.
 *
 * Deliberately omitted vs the full pipeline (deferred to `done`): rehype-highlight
 * (the ~150ms cost), rehype-raw/sanitize, remarkPathLinks + path existence IPC,
 * inline image loading, code-block collapse/copy. Streaming does only cheap,
 * stable structural rendering.
 *
 * Memoized so a settled chunk never re-parses when a later chunk grows.
 */
const StreamMarkdownChunk = memo(function StreamMarkdownChunk({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ table: MarkdownTable }}>
      {text}
    </ReactMarkdown>
  );
});

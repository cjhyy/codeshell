import React from "react";
import { Markdown, streamingMarkdownClassName } from "../Markdown";

interface StreamingMarkdownProps {
  text: string;
  /** True once the turn/agent finished — switches to the full Markdown pipeline. */
  done: boolean;
  /** Session workspace dir — lets the done Markdown resolve relative image paths. */
  cwd?: string | null;
}

/**
 * The done/streaming split for assistant + agent message bodies, hoisted out of
 * the three inline `done ? <Markdown/> : <pre>` sites (AssistantMessageView,
 * AgentMessageView, TurnProcessGroupCard) into one place.
 *
 * Stage 0a: behaviour is byte-identical to the previous inline form —
 *   - done  → full `<Markdown>` pipeline (highlight, raw→sanitize, path links)
 *   - streaming → plain `<pre>` inside `streamingMarkdownClassName`
 *   - empty text → render nothing
 * The empty-text guard is safe here because every call site already suppressed
 * empty text before reaching this component. Stage 2 will replace the streaming
 * branch with a stable-prefix / active-tail renderer behind a flag; keeping the
 * split in one component is what makes that a single, reviewable change.
 */
export function StreamingMarkdown({ text, done, cwd }: StreamingMarkdownProps) {
  if (text === "") return null;
  if (done) return <Markdown text={text} cwd={cwd} />;
  return (
    <div className={streamingMarkdownClassName}>
      <pre className="whitespace-pre-wrap font-sans">{text}</pre>
    </div>
  );
}

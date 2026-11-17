/**
 * A `user_prompt_submit` hook may rewrite the user's prompt (`updatedPrompt`).
 * The user message event is written before hooks fire (hook processes may
 * read the transcript), so the rewrite is persisted as its own
 * `prompt_rewrite` event naming that message. Model replay (toMessages)
 * sends the rewritten text — what the model saw before a restart — while
 * display paths keep reading the message event's original content.
 */
import type { ContentBlock, TranscriptEvent } from "../types.js";

/** `data` of a `prompt_rewrite` event. */
export interface PromptRewriteEventData {
  /** The message event as replay sees it (a checkpoint may have absorbed it). */
  messageEventId: string;
  /** Model-visible content that replaces the message's content in replay. */
  content: string;
}

/** Unknown or malformed data is ignored, never thrown on. */
export function readPromptRewrite(event: TranscriptEvent): PromptRewriteEventData | undefined {
  if (event.type !== "prompt_rewrite") return undefined;
  const { messageEventId, content } = event.data;
  if (typeof messageEventId !== "string" || !messageEventId) return undefined;
  if (typeof content !== "string") return undefined;
  return { messageEventId, content };
}

/** Rewritten content by message event id; a later rewrite of the same message wins. */
export function promptRewritesOf(events: readonly TranscriptEvent[]): Map<string, string> {
  const rewrites = new Map<string, string>();
  for (const event of events) {
    const rewrite = readPromptRewrite(event);
    if (rewrite) rewrites.set(rewrite.messageEventId, rewrite.content);
  }
  return rewrites;
}

/** The content a `message` event contributes to model replay. */
export function modelContentOf(
  event: TranscriptEvent,
  rewrites: ReadonlyMap<string, string>,
): string | ContentBlock[] {
  const content = event.data.content as string | ContentBlock[];
  // Only a user prompt is ever rewritten; anything else keeps its content.
  if (event.data.role !== "user") return content;
  return rewrites.get(event.id) ?? content;
}

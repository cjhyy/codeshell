/**
 * The transcript-first layout of the end-of-run analysis prompts. The memory
 * pipeline sends memory extraction; the session-summary builder
 * (session-memory.ts) keeps the same layout, but no pipeline step calls it.
 *
 * Instead of leading with its own system prompt and instructions, a task uses
 * a neutral system prompt, a fixed head and the transcript rendered byte for
 * byte the same way; only the final message (the task) differs. The next run
 * of the session then reads this run's cached prefix (append-only transcript
 * rendering, memory-transcript.ts).
 * See docs/todo/prompt-cache-optimization.md §五 (head / ledger / tail).
 */
import {
  memoryPromptSegments,
  type MemoryPromptCachePlan,
  type MemoryPromptSegments,
} from "./memory-prompt-segments.js";
import { layoutMemoryTranscript, type MemoryTranscriptMessage } from "./memory-transcript.js";

/** System prompt of every call that uses this layout; task specifics go in the last message. */
export const SESSION_TRANSCRIPT_SYSTEM_PROMPT =
  "You analyse a finished conversation for a background task. The conversation comes first; " +
  "the final message states the task and its required output. Follow that task exactly.";

/** One cache scope for all calls with this prefix, so they share a prompt cache key. */
export const SESSION_TRANSCRIPT_CACHE_PURPOSE = "session-transcript" as const;

/** Per-message budget; one value for every task, or the renderings would differ. */
const MAX_MESSAGE_CHARS = 3_000;

const HEAD =
  "The conversation to analyse follows. The task comes after the conversation.\n\n## Conversation\n";

/**
 * Segments of a transcript-first prompt: fixed head, then the conversation
 * (sealed pieces are stable), then `task` in the final message.
 */
export function sessionTranscriptPromptSegments(
  transcript: readonly MemoryTranscriptMessage[],
  task: string,
): MemoryPromptSegments {
  return memoryPromptSegments(
    HEAD,
    layoutMemoryTranscript(transcript, MAX_MESSAGE_CHARS),
    `\n\n${task}`,
  );
}

/** Cache plan handed to `callLLM` for a prompt built by `sessionTranscriptPromptSegments`. */
export function sessionTranscriptCachePlan(segments: MemoryPromptSegments): MemoryPromptCachePlan {
  return { purpose: SESSION_TRANSCRIPT_CACHE_PURPOSE, ...segments };
}

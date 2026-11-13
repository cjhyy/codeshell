/**
 * Memory prompts split for the provider prompt cache.
 *
 * A provider resumes a cached prefix only from a save point whose preceding
 * bytes are identical, and a save point can only sit at the end of a message.
 * So the part of a prompt that the next call for the same session repeats
 * (fixed instructions, then the conversation so far) is sent as separate
 * messages, and everything that changes between calls goes in the last one.
 */
import type { MemoryTranscriptLayout } from "./memory-transcript.js";

export interface MemoryPromptSegments {
  /** Messages the next call for this session sends again unchanged. */
  stable: string[];
  /** Final message: newest conversation, changing lists, the task itself. */
  volatile: string;
}

export type MemoryPromptPurpose = "memory-extraction" | "session-summary" | "memory-write-decision";

/** Handed to `callLLM` next to the single-string prompt, which stays complete. */
export interface MemoryPromptCachePlan extends MemoryPromptSegments {
  /** Separates cache scopes: prompts of different purposes share no prefix. */
  purpose: MemoryPromptPurpose;
}

/** A piece is sealed once it holds at least this many characters. */
const SEALED_PIECE_CHARS = 2_000;

/**
 * Cut a growing list of text items into pieces at positions that survive
 * appends: the pieces of a longer list start with the pieces of a shorter
 * one. Each item must carry its own separator, so a sealed piece never
 * depends on what follows it.
 */
export function sealMemoryPromptPieces(items: readonly string[]): MemoryTranscriptLayout {
  const sealed: string[] = [];
  let open = "";
  for (const item of items) {
    open += item;
    if (open.length >= SEALED_PIECE_CHARS) {
      sealed.push(open);
      open = "";
    }
  }
  return { sealed, open };
}

/**
 * `head` must be the same for every call (no dates, counts or names), `tail`
 * may be anything.
 */
export function memoryPromptSegments(
  head: string,
  transcript: MemoryTranscriptLayout,
  tail: string,
): MemoryPromptSegments {
  return { stable: [head, ...transcript.sealed], volatile: `${transcript.open}${tail}` };
}

export function joinMemoryPrompt(segments: MemoryPromptSegments): string {
  return segments.stable.join("") + segments.volatile;
}

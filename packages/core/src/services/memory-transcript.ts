import { sealMemoryPromptPieces } from "./memory-prompt-segments.js";

const MAX_CONVERSATION_CHARS = 30_000;
const MESSAGE_OMISSION = "\n[... middle of message omitted ...]\n";
const CONVERSATION_OMISSION = "[... earlier conversation omitted ...]";
const SEPARATOR = "\n\n";
/**
 * When the conversation outgrows the budget, drop this much more than strictly
 * needed. The window start then stays put for the next ~10k characters of
 * conversation instead of moving on every call, so consecutive memory prompts
 * for one session keep a byte-identical beginning (provider prompt cache).
 */
const WINDOW_STEP_CHARS = 10_000;

/**
 * A bounded transcript rendering split at positions that survive appends.
 * `sealed.join("") + open` is the full text. Rendering a longer transcript
 * yields the same sealed pieces followed by more, until the window start
 * moves or an earlier message changes.
 */
export interface MemoryTranscriptLayout {
  sealed: string[];
  /** Newest messages that do not fill a piece yet. */
  open: string;
}

/**
 * Index of the first message kept after the opening one. Replays the growth of
 * the conversation, so the answer for a longer transcript passes through the
 * answers for its prefixes: the start only moves when the budget is exceeded,
 * and then by a whole step.
 */
function windowStart(parts: readonly string[]): number {
  if (parts.length <= 1) return 1;
  const fullBudget = MAX_CONVERSATION_CHARS - parts[0]!.length;
  const windowBudget = fullBudget - CONVERSATION_OMISSION.length - SEPARATOR.length;
  let start = 1;
  let omitted = false;
  let size = 0;
  for (let index = 1; index < parts.length; index++) {
    size += parts[index]!.length + SEPARATOR.length;
    if (size <= (omitted ? windowBudget : fullBudget)) continue;
    omitted = true;
    while (start < index && size > windowBudget - WINDOW_STEP_CHARS) {
      size -= parts[start]!.length + SEPARATOR.length;
      start++;
    }
  }
  return start;
}

/** One conversation message as the memory prompts render it. */
export interface MemoryTranscriptMessage {
  role: string;
  content: string;
  /**
   * An assistant message that ends a turn (no tool call). A run normally ends
   * on one, so a piece is sealed after it: the next run's prompt then still
   * has a message boundary where this run's transcript ended, and its cache
   * save point stays reusable. Without it only the size rule seals pieces.
   */
  endsTurn?: boolean;
}

/** Keep the original intent and recent outcomes inside the memory prompt budget. */
export function layoutMemoryTranscript(
  messages: readonly MemoryTranscriptMessage[],
  maxMessageChars: number,
): MemoryTranscriptLayout {
  const parts = messages.map(({ role, content }) => {
    if (content.length > maxMessageChars) {
      const headChars = Math.ceil((maxMessageChars - MESSAGE_OMISSION.length) / 2);
      const tailChars = maxMessageChars - MESSAGE_OMISSION.length - headChars;
      content = `${content.slice(0, headChars)}${MESSAGE_OMISSION}${content.slice(-tailChars)}`;
    }
    return `[${role}]: ${content}`;
  });
  const start = windowStart(parts);
  // Indexes into `messages`; -1 stands for the omission marker.
  const all = parts.map((_, index) => index);
  const kept = start > 1 ? [0, -1, ...all.slice(start)] : all;
  const items = kept.map((index) => (index < 0 ? CONVERSATION_OMISSION : parts[index]!));

  // The separator leads, so a sealed piece never depends on what follows it.
  return sealMemoryPromptPieces(
    items.map((item, index) => (index === 0 ? item : `${SEPARATOR}${item}`)),
    (index) => messages[kept[index]!]?.endsTurn === true,
  );
}

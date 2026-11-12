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

/** Keep the original intent and recent outcomes inside the memory prompt budget. */
export function layoutMemoryTranscript(
  messages: Array<{ role: string; content: string }>,
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
  const items = start > 1 ? [parts[0]!, CONVERSATION_OMISSION, ...parts.slice(start)] : parts;

  // The separator leads, so a sealed piece never depends on what follows it.
  return sealMemoryPromptPieces(
    items.map((item, index) => (index === 0 ? item : `${SEPARATOR}${item}`)),
  );
}

export function formatMemoryTranscript(
  messages: Array<{ role: string; content: string }>,
  maxMessageChars: number,
): string {
  const { sealed, open } = layoutMemoryTranscript(messages, maxMessageChars);
  return sealed.join("") + open;
}

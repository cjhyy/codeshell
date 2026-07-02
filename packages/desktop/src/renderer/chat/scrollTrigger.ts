import type { Message } from "../types";

/**
 * Bucket a character length so streaming growth ticks the scroll trigger every
 * ~BUCKET chars instead of on every token — cheap coarse follow. The
 * ResizeObserver in useStickToBottom catches the fine-grained / height-only
 * changes this can miss; this is the cheap primary signal.
 */
const BUCKET = 40;
export function bucket(len: number): number {
  return Math.floor(len / BUCKET);
}

/**
 * Build the stick-to-bottom trigger string. Encodes message count + trailing
 * key (new messages / cards) AND, while a turn is live, the bucketed length of
 * the streaming tail so growth *within* a single assistant/agent message keeps
 * following. History messages never affect the trigger.
 */
export function buildScrollTrigger(
  messages: Message[],
  liveTurnActive: boolean | undefined,
  trailingKey: string | null | undefined,
): string {
  let liveTail = 0;
  if (liveTurnActive) {
    // Length of the last streaming message's visible text. Assistant streams
    // into `text`; agents accumulate into `textBuffer` before flush.
    const last = messages[messages.length - 1];
    if (last) {
      if (last.kind === "assistant" && !last.done) {
        liveTail = last.text.length;
      } else if (last.kind === "agent") {
        liveTail = (last.text?.length ?? 0) + (last.textBuffer?.length ?? 0);
      }
    }
  }
  return `${messages.length}:${trailingKey ?? ""}:${bucket(liveTail)}`;
}

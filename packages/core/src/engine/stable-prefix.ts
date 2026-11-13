/**
 * Where the explicit "stable history" cache breakpoint goes.
 *
 * A provider resumes a cached prefix only from a save point — the end of the
 * system prompt, an explicit breakpoint, or the end of the previous request —
 * whose preceding content is byte-identical. Reads are not longest-common-
 * prefix. The breakpoint therefore belongs on the last message that is
 * settled: nothing before it will be rewritten or removed by this run.
 *
 *   - A deferred rewrite batch (context/rewrite-gate.ts) will change old
 *     messages when it is applied; a breakpoint just before the earliest of
 *     them survives the rewrite, so only the content after it is re-billed.
 *   - Otherwise everything before this run is settled, and the breakpoint at
 *     the run start lets the next run (or a retry after an in-run rewrite)
 *     resume from there.
 *   - A volatile context message is removed after the run, so the stable
 *     prefix can never extend past it. On a route with explicit breakpoints it
 *     rides the tail of every request (engine/volatile-context-tail.ts) and
 *     the breakpoint goes immediately before it: that is the only place from
 *     which both the next step and the next run can resume, and a breakpoint
 *     further back would re-bill this run's whole tail on every step. A
 *     pending rewrite still takes precedence when its boundary is earlier.
 *
 * See docs/todo/prompt-cache-optimization.md §五.
 */
import type { Message } from "../types.js";

export interface StablePrefixInput {
  /** The message list about to be sent (volatile messages included). */
  messages: readonly Message[];
  isVolatile: (message: Message) => boolean;
  /** Earliest message a deferred rewrite batch would change, if one is pending. */
  pendingRewriteMessage?: Message;
  /** First message this run added to the history (see assembleRunMessages). */
  runStartMessage?: Message;
  /** The volatile messages ride the request tail; the prefix ends just before them. */
  volatileAtTail?: boolean;
}

/** Number of leading messages that form the stable prefix. */
export function resolveStablePrefixMessageCount(input: StablePrefixInput): number {
  const { messages } = input;
  // Messages are looked up by identity, never by an index computed against a
  // differently shaped array (e.g. one with the volatile messages stripped).
  const indexOf = (message: Message | undefined): number =>
    message === undefined ? -1 : messages.indexOf(message);

  const volatileIndex = messages.findIndex(input.isVolatile);
  let settled = indexOf(input.pendingRewriteMessage);
  if (input.volatileAtTail && volatileIndex >= 0) {
    return settled < 0 ? volatileIndex : Math.min(volatileIndex, settled);
  }

  if (settled < 0) settled = indexOf(input.runStartMessage);
  // The reference was compacted away (or replaced): nothing narrower is known.
  if (settled < 0) settled = messages.length;

  return volatileIndex >= 0 ? Math.min(volatileIndex, settled) : settled;
}

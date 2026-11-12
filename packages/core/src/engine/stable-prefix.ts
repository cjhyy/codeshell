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
 *     prefix can never extend past it.
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
}

/** Number of leading messages that form the stable prefix. */
export function resolveStablePrefixMessageCount(input: StablePrefixInput): number {
  const { messages } = input;
  // Messages are looked up by identity, never by an index computed against a
  // differently shaped array (e.g. one with the volatile messages stripped).
  const indexOf = (message: Message | undefined): number =>
    message === undefined ? -1 : messages.indexOf(message);

  let settled = indexOf(input.pendingRewriteMessage);
  if (settled < 0) settled = indexOf(input.runStartMessage);
  // The reference was compacted away (or replaced): nothing narrower is known.
  if (settled < 0) settled = messages.length;

  const volatileIndex = messages.findIndex(input.isVolatile);
  return volatileIndex >= 0 ? Math.min(volatileIndex, settled) : settled;
}

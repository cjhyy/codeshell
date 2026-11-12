/**
 * Where a run's non-durable (volatile) context message sits in a request.
 *
 * The message is removed after the run, so whatever follows it in a request
 * can never be read from cache by the next run. Two placements, by route:
 *
 *   - Explicit breakpoints (see llm/prompt-cache.ts): the message rides the
 *     TRUE TAIL of every request — it is moved behind the newest message
 *     before each model call — and the stable-history breakpoint sits on the
 *     message just before it (engine/stable-prefix.ts). History itself is then
 *     append-only across steps and runs; only this one message is uncached.
 *   - No explicit breakpoints: the only save point inside the history is the
 *     end of the previous request. Moving the message on every step would
 *     break that save point every step, so it stays where the run put it.
 */
import type { Message } from "../types.js";

/** Move the volatile messages behind every other message, in place, keeping their order. */
export function moveVolatileContextToTail(
  messages: Message[],
  volatile: ReadonlySet<Message>,
): void {
  if (volatile.size === 0) return;
  let trailing = 0;
  while (trailing < messages.length && volatile.has(messages[messages.length - 1 - trailing]!)) {
    trailing += 1;
  }
  const head = messages.length - trailing;
  // Already at the tail: nothing volatile before the trailing run.
  if (!messages.slice(0, head).some((message) => volatile.has(message))) return;
  const moved = messages.filter((message) => volatile.has(message));
  const kept = messages.filter((message) => !volatile.has(message));
  messages.splice(0, messages.length, ...kept, ...moved);
}

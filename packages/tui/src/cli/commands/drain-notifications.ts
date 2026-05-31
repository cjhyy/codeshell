/**
 * Headless background-agent notification drain (Phase 1, headless tail).
 *
 * The TUI drains the notification queue on idle and injects results as a new
 * turn. Headless `run` has no idle loop, so it must drain explicitly before
 * exiting — otherwise a background agent that finishes after the main result
 * has its completion silently dropped when the server/client close.
 *
 * Lifecycle contract: draining once immediately after `client.run()` and then
 * exiting would miss any background agent still in flight. So when waiting is
 * enabled we poll `hasRunning()` up to `timeoutMs`, then drain whatever has
 * accumulated. A timeout is reported by the caller, not silently swallowed.
 */

import { notificationQueue, asyncAgentRegistry, type NotificationItem } from "@cjhyy/code-shell-core";

export interface DrainOptions {
  /** Wait for in-flight background agents before draining. Default true. */
  wait?: boolean;
  /** Max time to wait for background agents to finish. Default 5000ms. */
  timeoutMs?: number;
  /** Poll interval while waiting. Default 100ms. */
  pollMs?: number;
  /** Injectable queue (defaults to the process singleton). For tests. */
  queue?: { drainAll(sessionId: string): NotificationItem[] };
  /** Injectable running-probe (defaults to the registry). For tests. */
  hasRunning?: () => boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Drain completion notifications for `sessionId`. Optionally waits for any
 * still-running background agents to finish first. Returns the drained items
 * (possibly empty). Never throws.
 */
export async function drainBackgroundNotifications(
  sessionId: string,
  opts: DrainOptions = {},
): Promise<NotificationItem[]> {
  const queue = opts.queue ?? notificationQueue;
  const hasRunning = opts.hasRunning ?? (() => asyncAgentRegistry.hasRunning());
  const wait = opts.wait ?? true;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 100;

  if (wait && hasRunning()) {
    const deadline = Date.now() + timeoutMs;
    while (hasRunning() && Date.now() < deadline) {
      await sleep(pollMs);
    }
  }

  return queue.drainAll(sessionId);
}

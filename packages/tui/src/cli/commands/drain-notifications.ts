/**
 * Headless background-work notification drain (Phase 1, headless tail).
 *
 * The TUI drains the notification queue on idle and injects results as a new
 * turn. Headless `run` has no idle loop, so it must drain explicitly before
 * exiting — otherwise a background agent that finishes after the main result
 * has its completion silently dropped when the server/client close.
 *
 * Lifecycle contract: draining once immediately after `client.run()` and then
 * exiting would miss any background agent or job (including DriveAgent) still
 * in flight. So when waiting is enabled we poll the session-scoped registries
 * up to `timeoutMs`, then drain whatever has accumulated. A timeout is reported
 * by the caller, not silently swallowed.
 */

import {
  notificationQueue,
  asyncAgentRegistry,
  backgroundJobRegistry,
  type NotificationItem,
} from "@cjhyy/code-shell-core/internal";

/**
 * Whether this Session still owns in-process work that can notify it,
 * transitively: a background agent registers under its SPAWNER's session id,
 * so work spawned by a (possibly already-finished) child agent lives under
 * that child's own session id. Following childSessionId edges keeps the
 * headless exit wait alive for grandchildren instead of truncating them the
 * moment their parent agent finishes.
 */
export function hasRunningBackgroundWork(sessionId: string): boolean {
  const pending = [sessionId];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const sid = pending.pop()!;
    if (
      asyncAgentRegistry.hasRunningForSession(sid) ||
      backgroundJobRegistry.hasRunningForSession(sid)
    ) {
      return true;
    }
    for (const entry of asyncAgentRegistry.list()) {
      if (entry.sessionId === sid && entry.childSessionId && !seen.has(entry.childSessionId)) {
        seen.add(entry.childSessionId);
        pending.push(entry.childSessionId);
      }
    }
  }
  return false;
}

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
  const hasRunning = opts.hasRunning ?? (() => hasRunningBackgroundWork(sessionId));
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

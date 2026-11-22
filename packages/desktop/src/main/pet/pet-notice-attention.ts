import type { PetIpcAttention } from "./pet-ipc.js";

const MAX_VIEWED_SESSIONS = 500;

/**
 * Remembers which work Session the owner had open on the desktop, so a
 * queued done / failed notice the owner has already looked at is not
 * replayed later over IM.
 */
export class SessionViewTracker {
  private active: string | null = null;
  private readonly lastViewed = new Map<string, number>();

  setActive(sessionId: string | null, now: number): void {
    if (this.active) this.touch(this.active, now);
    this.active = sessionId;
    if (sessionId) this.touch(sessionId, now);
  }

  viewedSince(sessionId: string, ms: number, focused: boolean): boolean {
    if (this.active === sessionId && focused) return true;
    return (this.lastViewed.get(sessionId) ?? Number.NEGATIVE_INFINITY) >= ms;
  }

  private touch(sessionId: string, now: number): void {
    this.lastViewed.delete(sessionId);
    this.lastViewed.set(sessionId, now);
    while (this.lastViewed.size > MAX_VIEWED_SESSIONS) {
      const oldest = this.lastViewed.keys().next().value;
      if (oldest === undefined) break;
      this.lastViewed.delete(oldest);
    }
  }
}

/** The router as pet IPC (the bell) sees it; also records which Session the owner is viewing. */
export function createNoticeAttention(
  owner: PetIpcAttention & { start(): void | Promise<void> },
  views: SessionViewTracker,
  now: () => number,
) {
  let unsubscribeFocus: (() => void) | undefined;
  return {
    start: () => owner.start(),
    getSnapshot: () => owner.getSnapshot(),
    subscribe: (listener: Parameters<PetIpcAttention["subscribe"]>[0]) => owner.subscribe(listener),
    setActiveSession: (sessionId: string | null, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      unsubscribeFocus?.();
      unsubscribeFocus = undefined;
      views.setActive(sessionId, now());
      if (signal && sessionId) {
        const clear = () => views.setActive(null, now());
        signal.addEventListener("abort", clear, { once: true });
        unsubscribeFocus = () => signal.removeEventListener("abort", clear);
      }
      return owner.setActiveSession(sessionId, signal);
    },
    markReceipts: (...args: Parameters<PetIpcAttention["markReceipts"]>) =>
      owner.markReceipts(...args),
  };
}

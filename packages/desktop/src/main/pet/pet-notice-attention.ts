import type { PetIpcAttention } from "./pet-ipc.js";
import type { PetNoticeRouter } from "./pet-notice-router.js";

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
  router: Pick<PetNoticeRouter, "getSnapshot" | "subscribe" | "setActiveSession" | "markReceipts">,
  views: SessionViewTracker,
  now: () => number,
): PetIpcAttention {
  return {
    getSnapshot: () => router.getSnapshot(),
    subscribe: (listener) => router.subscribe(listener),
    setActiveSession: (sessionId) => {
      views.setActive(sessionId, now());
      router.setActiveSession(sessionId);
    },
    markReceipts: (keys, state) => router.markReceipts(keys, state),
  };
}

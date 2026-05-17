/**
 * QueryGuard — synchronous state machine for "is a query in flight".
 * Replaces React useState for isRunning. Subscribers (via useSyncExternalStore)
 * see state changes immediately, bypassing React 18 batching that otherwise
 * opens a 1–10 ms window for double-submit / dead-click bugs.
 *
 * States:
 *   idle      — no query active
 *   reserved  — processUserInput started its sync prep but hasn't created the AbortController yet
 *   running   — AbortController attached; query is in flight
 *
 * The only writers are reserve/tryStart/cancelReservation/end/forceEnd.
 * No setter is exposed.
 */

export type QueryState = "idle" | "reserved" | "running";

export class QueryGuard {
  private state: QueryState = "idle";
  private controller: AbortController | null = null;
  private listeners = new Set<() => void>();

  // ── useSyncExternalStore contract ──
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): boolean => this.state !== "idle";

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  /** Reserve a slot synchronously before the AbortController exists. */
  reserve(): boolean {
    if (this.state !== "idle") return false;
    this.state = "reserved";
    this.notify();
    return true;
  }

  /** Attach the AbortController. Must follow reserve(). */
  tryStart(controller: AbortController): boolean {
    if (this.state !== "reserved") return false;
    this.controller = controller;
    this.state = "running";
    this.notify();
    return true;
  }

  /** Roll back reserve() when processUserInput threw before tryStart. */
  cancelReservation(): void {
    if (this.state !== "reserved") return;
    this.state = "idle";
    this.notify();
  }

  /** Normal completion — clean up without aborting (already finished). */
  end(): void {
    if (this.state === "idle") return;
    this.state = "idle";
    this.controller = null;
    this.notify();
  }

  /** Hard abort: abort the controller AND clean up. */
  forceEnd(reason: string = "force-end"): void {
    if (this.state === "running" && this.controller) {
      try {
        this.controller.abort(reason);
      } catch {
        // swallow — listener errors must not block state transition
      }
    }
    this.state = "idle";
    this.controller = null;
    this.notify();
  }

  /** Read the current controller's signal; null when idle/reserved. */
  getSignal(): AbortSignal | null {
    return this.controller?.signal ?? null;
  }
}

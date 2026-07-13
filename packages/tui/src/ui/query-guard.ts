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
  private externalOwner = false;
  private generation = 0;
  private ownerToken: number | null = null;
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
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        // listener errors must not block subsequent listeners or callers;
        // React's useSyncExternalStore scheduler should not throw, but
        // defensive isolation makes guard robust to listener bugs
      }
    }
  }

  /** Reserve a slot synchronously before the AbortController exists. */
  reserve(): number | null {
    if (this.state !== "idle") return null;
    const token = ++this.generation;
    this.ownerToken = token;
    this.state = "reserved";
    this.externalOwner = false;
    this.notify();
    return token;
  }

  /** Attach the AbortController. Must follow reserve(). */
  tryStart(controller: AbortController, token: number): boolean {
    if (this.state !== "reserved" || this.ownerToken !== token) return false;
    this.controller = controller;
    this.externalOwner = false;
    this.state = "running";
    this.notify();
    return true;
  }

  /** Mark a server-driven turn (Goal resume/background wake) as running. */
  startExternal(): number | null {
    if (this.state !== "idle") return null;
    const token = ++this.generation;
    this.ownerToken = token;
    this.controller = null;
    this.externalOwner = true;
    this.state = "running";
    this.notify();
    return token;
  }

  /** Roll back reserve() when processUserInput threw before tryStart. */
  cancelReservation(token: number): void {
    if (this.state !== "reserved" || this.ownerToken !== token) return;
    this.state = "idle";
    this.externalOwner = false;
    this.ownerToken = null;
    this.notify();
  }

  /** Normal completion — clean up without aborting (already finished). */
  end(token: number): void {
    if (this.state === "idle" || this.ownerToken !== token) return;
    this.state = "idle";
    this.controller = null;
    this.externalOwner = false;
    this.ownerToken = null;
    this.notify();
  }

  /** End only a server-driven turn; never release a client.run-owned guard. */
  endExternal(): boolean {
    if (this.state !== "running" || !this.externalOwner) return false;
    this.state = "idle";
    this.controller = null;
    this.externalOwner = false;
    this.ownerToken = null;
    this.notify();
    return true;
  }

  /** Hard abort: abort the controller AND clean up. */
  forceEnd(reason: string = "force-end"): "local" | "external" | null {
    if (this.state === "idle") return null;
    const owner = this.externalOwner ? "external" : "local";
    if (this.state === "running" && this.controller) {
      try {
        this.controller.abort(reason);
      } catch {
        // abort() can throw if already aborted in some environments
      }
    }
    this.state = "idle";
    this.controller = null;
    this.externalOwner = false;
    this.ownerToken = null;
    this.generation++;
    this.notify();
    return owner;
  }

  /** Read the current controller's signal; null when idle/reserved. */
  getSignal(): AbortSignal | null {
    return this.controller?.signal ?? null;
  }

  /**
   * Release only a client.run-owned slot when its transport response arrives.
   * This runs synchronously inside AgentClient before a following queued
   * session_started notification is parsed, closing the Promise-microtask
   * handoff gap. The old local finally is token-fenced and cannot release the
   * external owner which may start immediately afterward.
   */
  endLocalResponse(token: number): boolean {
    if (this.state === "idle" || this.externalOwner || this.ownerToken !== token) return false;
    this.state = "idle";
    this.controller = null;
    this.externalOwner = false;
    this.ownerToken = null;
    this.generation++;
    this.notify();
    return true;
  }
}

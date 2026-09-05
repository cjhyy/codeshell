/**
 * Exclusive write control over one browser tab.
 *
 * Two agents must never write the same page, and a lease taken on one page
 * must not survive that page turning into a different one. Both matter most in
 * exactly the flows where a mistake is expensive — checkout, posting, settings.
 *
 * Named TabControl, not "lease": `background-runtime.ts` already has a `leases`
 * counter, but that is a refcount keeping Chromium alive, not a writer lock.
 *
 * EVERY METHOD IS ASYNC ON PURPOSE. The desktop holds one main process and
 * could do this in memory, but a server runs several instances and must put the
 * lease in shared storage or two of them will each grant control of the same
 * tab. Retrofitting async later would touch every call site, so the interface
 * commits to it now — see docs/todo/browser-profile-workspace-lease-design.md
 * §7.3.
 */

/** What a Session asks for when taking control of a tab. */
export interface TabControlClaim {
  tabId: string;
  holderSessionId: string;
  /** Only one `control` holder at a time; any number of `observe`. */
  mode: "control" | "observe";
  turnId: string;
  /** Identity of the BROWSER. An external one restarts and this changes. */
  browserId: string;
  /** Page identity at claim time; re-checked before every write. */
  expectedOrigin: string;
  expectedTitleHash: string;
}

export interface TabControlRecord extends TabControlClaim {
  expiresAt: number;
  /** Bumped per claim so a reused tabId cannot be mistaken for the old tab. */
  generation: number;
}

export type TabControlDenial =
  | "held"
  | "no_lease"
  | "not_holder"
  | "expired"
  | "navigated"
  | "browser_changed";

export type TabControlResult =
  | { ok: true; record: TabControlRecord }
  | { ok: false; reason: TabControlDenial };

export type TabControlValidation = { ok: true } | { ok: false; reason: TabControlDenial };

/** What the caller observes about the tab right now, at write time. */
export interface TabControlCheck {
  tabId: string;
  holderSessionId: string;
  browserId: string;
  currentOrigin: string;
  currentTitleHash: string;
}

export interface TabControlStore {
  acquire(claim: TabControlClaim, ttlMs: number): Promise<TabControlResult>;
  validate(check: TabControlCheck): Promise<TabControlValidation>;
  release(tabId: string, holderSessionId: string): Promise<void>;
}

/**
 * Desktop implementation: one main process, so memory is enough. A server
 * substitutes a shared-storage implementation behind the same interface.
 */
export class InMemoryTabControlStore implements TabControlStore {
  private readonly controllers = new Map<string, TabControlRecord>();
  /** tabId → sessions observing it. Recorded only so validate() can say
   *  "you are an observer" instead of the misleading "no lease exists". */
  private readonly observers = new Map<string, Set<string>>();
  private generation = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async acquire(claim: TabControlClaim, ttlMs: number): Promise<TabControlResult> {
    // Observers never contend: they cannot write, so they cannot conflict.
    if (claim.mode === "observe") {
      let watching = this.observers.get(claim.tabId);
      if (!watching) {
        watching = new Set();
        this.observers.set(claim.tabId, watching);
      }
      watching.add(claim.holderSessionId);
      return {
        ok: true,
        record: { ...claim, expiresAt: this.now() + ttlMs, generation: ++this.generation },
      };
    }
    const existing = this.controllers.get(claim.tabId);
    const live = existing && existing.expiresAt > this.now();
    // A live lease held by someone else blocks; the holder may renew its own so
    // a second turn in the same Session does not deadlock against itself.
    if (live && existing.holderSessionId !== claim.holderSessionId) {
      return { ok: false, reason: "held" };
    }
    const record: TabControlRecord = {
      ...claim,
      expiresAt: this.now() + ttlMs,
      generation: ++this.generation,
    };
    this.controllers.set(claim.tabId, record);
    return { ok: true, record };
  }

  async validate(check: TabControlCheck): Promise<TabControlValidation> {
    const record = this.controllers.get(check.tabId);
    if (!record) {
      // An observer asking to write is a different mistake from having no
      // lease at all, and the caller's error message should say which.
      return {
        ok: false,
        reason: this.observers.get(check.tabId)?.has(check.holderSessionId)
          ? "not_holder"
          : "no_lease",
      };
    }
    if (record.holderSessionId !== check.holderSessionId)
      return { ok: false, reason: "not_holder" };
    if (record.expiresAt <= this.now()) return { ok: false, reason: "expired" };
    // Browser identity first: a restarted browser invalidates everything below,
    // and reporting "navigated" for it would be misleading.
    if (record.browserId !== check.browserId) return { ok: false, reason: "browser_changed" };
    if (
      record.expectedOrigin !== check.currentOrigin ||
      record.expectedTitleHash !== check.currentTitleHash
    ) {
      return { ok: false, reason: "navigated" };
    }
    return { ok: true };
  }

  async release(tabId: string, holderSessionId: string): Promise<void> {
    const record = this.controllers.get(tabId);
    // Only the holder may release, or any Session could free someone else's tab
    // and then immediately claim it.
    if (record && record.holderSessionId === holderSessionId) this.controllers.delete(tabId);
    const watching = this.observers.get(tabId);
    if (watching?.delete(holderSessionId) && watching.size === 0) this.observers.delete(tabId);
  }
}

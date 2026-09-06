/**
 * TabControl backed by shared storage, for a server running several instances.
 *
 * The desktop can hold leases in memory because it has exactly one main
 * process. A server cannot: two instances each consulting their own memory
 * would both grant control of the same tab, and the single-writer guarantee
 * would break silently — the failure mode is two agents typing into one
 * checkout page, not an error anyone sees.
 *
 * See docs/todo/browser-profile-workspace-lease-design.md §7.2.
 */

import type {
  TabControlCheck,
  TabControlClaim,
  TabControlRecord,
  TabControlResult,
  TabControlStore,
  TabControlValidation,
} from "./tab-control.js";

/**
 * The storage primitives this store needs.
 *
 * `putIfAbsent` MUST be atomic — a compare-and-set, not a read followed by a
 * write. Redis SETNX, a unique index, or a conditional write all qualify; a
 * get-then-set does not, because the gap between them is exactly the race this
 * class exists to close. It returns false when a live lease already exists.
 */
export interface TabControlBackend {
  get(tabId: string): Promise<TabControlRecord | undefined>;
  putIfAbsent(record: TabControlRecord): Promise<boolean>;
  replace(record: TabControlRecord): Promise<void>;
  remove(tabId: string): Promise<void>;
}

export class SharedTabControlStore implements TabControlStore {
  private generation = 0;

  constructor(
    private readonly backend: TabControlBackend,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async acquire(claim: TabControlClaim, ttlMs: number): Promise<TabControlResult> {
    // Observers never contend: they cannot write, so they need no row.
    if (claim.mode === "observe") {
      return { ok: true, record: this.record(claim, ttlMs) };
    }
    const record = this.record(claim, ttlMs);
    if (await this.backend.putIfAbsent(record)) return { ok: true, record };

    // Lost the race, or a live lease exists. The holder may renew its own so a
    // later turn of the same Session does not deadlock against itself — and it
    // may do so from a DIFFERENT instance, since Sessions are not pinned.
    const existing = await this.backend.get(claim.tabId);
    if (!existing || existing.expiresAt <= this.now()) {
      // Expired between the failed CAS and this read; retry once rather than
      // reporting a lease that no longer exists.
      return (await this.backend.putIfAbsent(record))
        ? { ok: true, record }
        : { ok: false, reason: "held" };
    }
    if (existing.holderSessionId !== claim.holderSessionId) {
      return { ok: false, reason: "held" };
    }
    await this.backend.replace(record);
    return { ok: true, record };
  }

  async validate(check: TabControlCheck): Promise<TabControlValidation> {
    const record = await this.backend.get(check.tabId);
    if (!record) return { ok: false, reason: "no_lease" };
    if (record.holderSessionId !== check.holderSessionId)
      return { ok: false, reason: "not_holder" };
    if (record.expiresAt <= this.now()) return { ok: false, reason: "expired" };
    // Browser identity first: a restarted browser invalidates everything below,
    // and calling that "navigated" would misdescribe it.
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
    const record = await this.backend.get(tabId);
    // Only the holder may release, or any Session could free someone else's tab
    // and immediately claim it.
    if (record && record.holderSessionId === holderSessionId) await this.backend.remove(tabId);
  }

  async handoff(
    tabId: string,
    fromSessionId: string,
    toSessionId: string,
    ttlMs: number,
  ): Promise<TabControlResult> {
    const record = await this.backend.get(tabId);
    if (!record) return { ok: false, reason: "no_lease" };
    // A gift from the holder, never a grab by the receiver.
    if (record.holderSessionId !== fromSessionId) return { ok: false, reason: "not_holder" };
    if (record.expiresAt <= this.now()) return { ok: false, reason: "expired" };
    const next: TabControlRecord = {
      ...record,
      holderSessionId: toSessionId,
      expiresAt: this.now() + ttlMs,
      generation: ++this.generation,
    };
    await this.backend.replace(next);
    return { ok: true, record: next };
  }

  private record(claim: TabControlClaim, ttlMs: number): TabControlRecord {
    return { ...claim, expiresAt: this.now() + ttlMs, generation: ++this.generation };
  }
}

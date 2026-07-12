import { describe, expect, test } from "bun:test";
import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
} from "./pet-state-aggregator";
import { PetAttentionPolicy } from "./pet-attention-policy";

class FakeClock {
  now = 0;
  private next = 0;
  private timers = new Map<number, { at: number; run: () => void }>();
  setTimeout = (run: () => void, delay: number) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + delay, run });
    return id;
  };
  clearTimeout = (id: number) => this.timers.delete(id);
  advance(ms: number) {
    this.now += ms;
    let ready = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.now);
    while (ready.length > 0) {
      for (const [id, timer] of ready) {
        this.timers.delete(id);
        timer.run();
      }
      ready = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.now);
    }
  }
}

function snapshot(count = 1): DesktopPetProjectionSnapshot {
  return {
    version: 4,
    generation: 2,
    workerState: "active",
    observedAt: 1,
    sessions: [],
    pending: Array.from({ length: count }, (_, index) => ({
      agentSessionId: `work-${index}`,
      requestId: `req-${index}`,
      workerGeneration: 2,
      kind: "ask_user" as const,
      title: `Question ${index}`,
      createdAt: 0,
      status: "pending" as const,
    })),
  };
}

describe("PetAttentionPolicy", () => {
  test("waits the full 15s grace and cancels resolved work", () => {
    const clock = new FakeClock();
    let current = snapshot();
    let sourceListener: ((event: DesktopPetProjectionEvent) => void) | undefined;
    const events: unknown[] = [];
    const policy = new PetAttentionPolicy({
      source: {
        getSnapshot: () => current,
        subscribe: (listener) => {
          sourceListener = listener;
          return () => {};
        },
      },
      receipts: { has: () => false, mark: () => {} },
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    policy.subscribe((event) => events.push(event));
    policy.start();

    clock.advance(14_999);
    expect(policy.getSnapshot().surfaceablePendingCount).toBe(0);
    clock.advance(1);
    expect(policy.getSnapshot().surfaceablePendingCount).toBe(1);

    current = { ...current, pending: [] };
    sourceListener?.({ kind: "reset", version: 5, generation: 2, observedAt: 2 });
    expect(policy.getSnapshot().surfaceablePendingCount).toBe(0);
  });

  test("dedupes receipts, suppresses the active target and aggregates a burst", () => {
    const clock = new FakeClock();
    let current = snapshot(1);
    const marked: string[] = [];
    const peeks: unknown[] = [];
    const policy = new PetAttentionPolicy({
      source: { getSnapshot: () => current, subscribe: () => () => {} },
      receipts: { has: (key) => marked.includes(key), mark: (key) => marked.push(key) },
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    policy.subscribe((event) => {
      if (event.kind === "peek") peeks.push(event.peek);
    });
    policy.setActiveSession("work-0");
    policy.start();
    clock.advance(15_000);
    clock.advance(2_000);

    expect(policy.getSnapshot().surfaceablePendingCount).toBe(1);
    expect(peeks).toHaveLength(0);
    expect(marked).toHaveLength(1);

    current = snapshot(3);
    policy.setActiveSession(null);
    policy.reconcile();
    clock.advance(2_000);
    expect(policy.getSnapshot().surfaceablePendingCount).toBe(3);
    expect(peeks).toHaveLength(1);
    expect(peeks[0]).toMatchObject({ action: { type: "open_pet_pending", count: 2 } });
    expect(marked).toHaveLength(3);
  });
});

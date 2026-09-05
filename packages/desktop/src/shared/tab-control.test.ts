import { describe, expect, test } from "bun:test";
import { InMemoryTabControlStore, type TabControlClaim } from "./tab-control";

function claim(over: Partial<TabControlClaim> = {}): TabControlClaim {
  return {
    tabId: "tab-1",
    holderSessionId: "s-aaa",
    mode: "control",
    turnId: "turn-1",
    browserId: "browser-1",
    expectedOrigin: "https://shop.example",
    expectedTitleHash: "hash-checkout",
    ...over,
  };
}

describe("single writer", () => {
  test("grants control to the first claimant", async () => {
    const store = new InMemoryTabControlStore();
    expect((await store.acquire(claim(), 1_000)).ok).toBe(true);
  });

  test("refuses a second controller while the first still holds it", async () => {
    // The core guarantee: two agents must never write the same tab.
    const store = new InMemoryTabControlStore();
    await store.acquire(claim(), 1_000);
    const second = await store.acquire(claim({ holderSessionId: "s-bbb" }), 1_000);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("held");
  });

  test("the holder may re-acquire its own tab", async () => {
    // A later turn in the same Session must not deadlock against itself.
    const store = new InMemoryTabControlStore();
    await store.acquire(claim(), 1_000);
    expect((await store.acquire(claim({ turnId: "turn-2" }), 1_000)).ok).toBe(true);
  });

  test("observers coexist with a controller and with each other", async () => {
    const store = new InMemoryTabControlStore();
    await store.acquire(claim(), 1_000);
    expect(
      (await store.acquire(claim({ holderSessionId: "s-b", mode: "observe" }), 1_000)).ok,
    ).toBe(true);
    expect(
      (await store.acquire(claim({ holderSessionId: "s-c", mode: "observe" }), 1_000)).ok,
    ).toBe(true);
  });

  test("control passes to the next claimant after release", async () => {
    const store = new InMemoryTabControlStore();
    await store.acquire(claim(), 1_000);
    await store.release("tab-1", "s-aaa");
    expect((await store.acquire(claim({ holderSessionId: "s-bbb" }), 1_000)).ok).toBe(true);
  });

  test("a non-holder cannot release someone else's control", async () => {
    const store = new InMemoryTabControlStore();
    await store.acquire(claim(), 1_000);
    await store.release("tab-1", "s-bbb");
    expect((await store.acquire(claim({ holderSessionId: "s-ccc" }), 1_000)).ok).toBe(false);
  });

  test("an expired lease no longer blocks a new claimant", async () => {
    // A crashed holder must not hold a tab hostage forever.
    let now = 1_000;
    const store = new InMemoryTabControlStore(() => now);
    await store.acquire(claim(), 50);
    now = 1_100;
    expect((await store.acquire(claim({ holderSessionId: "s-bbb" }), 50)).ok).toBe(true);
  });
});

describe("validation before every write", () => {
  test("accepts the page the lease was taken on", async () => {
    const store = new InMemoryTabControlStore();
    await store.acquire(claim(), 1_000);
    const v = await store.validate({
      tabId: "tab-1",
      holderSessionId: "s-aaa",
      browserId: "browser-1",
      currentOrigin: "https://shop.example",
      currentTitleHash: "hash-checkout",
    });
    expect(v.ok).toBe(true);
  });

  test("refuses after the tab navigated away", async () => {
    // The real hazard: the user clicks elsewhere between turns and the agent
    // resumes typing into a completely different page.
    const store = new InMemoryTabControlStore();
    await store.acquire(claim(), 1_000);
    const v = await store.validate({
      tabId: "tab-1",
      holderSessionId: "s-aaa",
      browserId: "browser-1",
      currentOrigin: "https://evil.example",
      currentTitleHash: "hash-checkout",
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("navigated");
  });

  test("refuses when the page changed under the same origin", async () => {
    const store = new InMemoryTabControlStore();
    await store.acquire(claim(), 1_000);
    const v = await store.validate({
      tabId: "tab-1",
      holderSessionId: "s-aaa",
      browserId: "browser-1",
      currentOrigin: "https://shop.example",
      currentTitleHash: "hash-order-history",
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("navigated");
  });

  test("refuses after the external browser restarted", async () => {
    // browserId changes on restart while the endpoint does not, so tabId alone
    // would happily match a brand-new tab.
    const store = new InMemoryTabControlStore();
    await store.acquire(claim(), 1_000);
    const v = await store.validate({
      tabId: "tab-1",
      holderSessionId: "s-aaa",
      browserId: "browser-2",
      currentOrigin: "https://shop.example",
      currentTitleHash: "hash-checkout",
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("browser_changed");
  });

  test("refuses a Session that never held the lease", async () => {
    const store = new InMemoryTabControlStore();
    await store.acquire(claim(), 1_000);
    const v = await store.validate({
      tabId: "tab-1",
      holderSessionId: "s-bbb",
      browserId: "browser-1",
      currentOrigin: "https://shop.example",
      currentTitleHash: "hash-checkout",
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("not_holder");
  });

  test("refuses once the lease expired", async () => {
    let now = 1_000;
    const store = new InMemoryTabControlStore(() => now);
    await store.acquire(claim(), 50);
    now = 1_100;
    const v = await store.validate({
      tabId: "tab-1",
      holderSessionId: "s-aaa",
      browserId: "browser-1",
      currentOrigin: "https://shop.example",
      currentTitleHash: "hash-checkout",
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("expired");
  });

  test("refuses an unknown tab instead of defaulting to allow", async () => {
    const store = new InMemoryTabControlStore();
    const v = await store.validate({
      tabId: "never-claimed",
      holderSessionId: "s-aaa",
      browserId: "browser-1",
      currentOrigin: "https://shop.example",
      currentTitleHash: "hash-checkout",
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("no_lease");
  });

  test("an observer is never allowed to write", async () => {
    const store = new InMemoryTabControlStore();
    await store.acquire(claim({ mode: "observe" }), 1_000);
    const v = await store.validate({
      tabId: "tab-1",
      holderSessionId: "s-aaa",
      browserId: "browser-1",
      currentOrigin: "https://shop.example",
      currentTitleHash: "hash-checkout",
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("not_holder");
  });
});

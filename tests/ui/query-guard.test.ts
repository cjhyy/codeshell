import { test, expect, mock } from "bun:test";
import { QueryGuard } from "../../packages/tui/src/ui/query-guard.js";

test("idle → reserve → tryStart → end happy path", () => {
  const g = new QueryGuard();
  expect(g.getSnapshot()).toBe(false);
  const token = g.reserve();
  expect(token).not.toBeNull();
  expect(g.getSnapshot()).toBe(true);
  const ac = new AbortController();
  expect(g.tryStart(ac, token!)).toBe(true);
  expect(g.getSnapshot()).toBe(true);
  expect(g.getSignal()).toBe(ac.signal);
  g.end(token!);
  expect(g.getSnapshot()).toBe(false);
  expect(g.getSignal()).toBe(null);
});

test("second reserve while busy returns false", () => {
  const g = new QueryGuard();
  expect(g.reserve()).not.toBeNull();
  expect(g.reserve()).toBeNull();
});

test("tryStart without reserve returns false", () => {
  const g = new QueryGuard();
  const ac = new AbortController();
  expect(g.tryStart(ac, 1)).toBe(false);
  expect(g.getSnapshot()).toBe(false);
});

test("forceEnd while running aborts the controller", () => {
  const g = new QueryGuard();
  const token = g.reserve()!;
  const ac = new AbortController();
  g.tryStart(ac, token);
  const abortSpy = mock(() => {});
  ac.signal.addEventListener("abort", abortSpy);
  g.forceEnd("user-cancel");
  expect(abortSpy).toHaveBeenCalledTimes(1);
  expect(ac.signal.aborted).toBe(true);
  expect(g.getSnapshot()).toBe(false);
});

test("forceEnd while reserved (no controller yet) returns to idle without throwing", () => {
  const g = new QueryGuard();
  g.reserve();
  expect(() => g.forceEnd("user-cancel")).not.toThrow();
  expect(g.getSnapshot()).toBe(false);
});

test("listener is notified exactly once per transition", () => {
  const g = new QueryGuard();
  const cb = mock(() => {});
  g.subscribe(cb);
  const token = g.reserve()!; // 1 notify
  g.tryStart(new AbortController(), token); // 2
  g.end(token); // 3
  expect(cb).toHaveBeenCalledTimes(3);
});

test("unsubscribe stops future notifications", () => {
  const g = new QueryGuard();
  const cb = mock(() => {});
  const unsub = g.subscribe(cb);
  const token = g.reserve()!;
  unsub();
  g.end(token);
  g.reserve();
  expect(cb).toHaveBeenCalledTimes(1);
});

test("cancelReservation rolls back reserve()", () => {
  const g = new QueryGuard();
  const token = g.reserve()!;
  g.cancelReservation(token);
  expect(g.getSnapshot()).toBe(false);
  // Should be reservable again
  expect(g.reserve()).not.toBeNull();
});

test("forceEnd() on idle is a no-op (no notify)", () => {
  const g = new QueryGuard();
  const cb = mock(() => {});
  g.subscribe(cb);
  g.forceEnd("user-cancel"); // already idle
  expect(cb).not.toHaveBeenCalled();
  expect(g.getSnapshot()).toBe(false);
});

test("a throwing listener does not block other listeners or state changes", () => {
  const g = new QueryGuard();
  let secondCalled = false;
  g.subscribe(() => {
    throw new Error("listener boom");
  });
  g.subscribe(() => {
    secondCalled = true;
  });
  expect(() => g.reserve()).not.toThrow();
  expect(secondCalled).toBe(true);
  expect(g.getSnapshot()).toBe(true);
});

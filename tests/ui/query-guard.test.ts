import { test, expect, mock } from "bun:test";
import { QueryGuard } from "../../src/ui/query-guard.js";

test("idle → reserve → tryStart → end happy path", () => {
  const g = new QueryGuard();
  expect(g.getSnapshot()).toBe(false);
  expect(g.reserve()).toBe(true);
  expect(g.getSnapshot()).toBe(true);
  const ac = new AbortController();
  expect(g.tryStart(ac)).toBe(true);
  expect(g.getSnapshot()).toBe(true);
  expect(g.getSignal()).toBe(ac.signal);
  g.end();
  expect(g.getSnapshot()).toBe(false);
  expect(g.getSignal()).toBe(null);
});

test("second reserve while busy returns false", () => {
  const g = new QueryGuard();
  expect(g.reserve()).toBe(true);
  expect(g.reserve()).toBe(false);
});

test("tryStart without reserve returns false", () => {
  const g = new QueryGuard();
  const ac = new AbortController();
  expect(g.tryStart(ac)).toBe(false);
  expect(g.getSnapshot()).toBe(false);
});

test("forceEnd while running aborts the controller", () => {
  const g = new QueryGuard();
  g.reserve();
  const ac = new AbortController();
  g.tryStart(ac);
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
  g.reserve();          // 1 notify
  g.tryStart(new AbortController()); // 2
  g.end();              // 3
  expect(cb).toHaveBeenCalledTimes(3);
});

test("unsubscribe stops future notifications", () => {
  const g = new QueryGuard();
  const cb = mock(() => {});
  const unsub = g.subscribe(cb);
  g.reserve();
  unsub();
  g.end();
  g.reserve();
  expect(cb).toHaveBeenCalledTimes(1);
});

test("cancelReservation rolls back reserve()", () => {
  const g = new QueryGuard();
  g.reserve();
  g.cancelReservation();
  expect(g.getSnapshot()).toBe(false);
  // Should be reservable again
  expect(g.reserve()).toBe(true);
});

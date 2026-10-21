import { expect, test } from "bun:test";
import { STATE_LEASE_LOCK_OPTIONS } from "./output-journal-state-lease.js";

test("the shared state lease never throws from a compromised refresh", () => {
  expect(() =>
    STATE_LEASE_LOCK_OPTIONS.onCompromised(
      Object.assign(new Error("ENOENT: lease removed"), { code: "ECOMPROMISED" }),
    ),
  ).not.toThrow();
  // Sync locks cannot retry; both repair paths rely on failing fast.
  expect(STATE_LEASE_LOCK_OPTIONS.retries).toBe(0);
});

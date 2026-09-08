import { describe, expect, test } from "bun:test";
import { ApprovalLeases, type ApprovalLease } from "./approval-lease.js";

describe("Hub approval leases", () => {
  test("first device wins, explicit release and expiry permit another claimant", () => {
    let now = 1_000;
    const changes: ApprovalLease[] = [];
    const leases = new ApprovalLeases(
      (event) => changes.push(event),
      100,
      () => now,
    );
    leases.add({ requestId: "approval", sessionId: "session" });
    leases.claim("approval", "a");
    expect(() => leases.claim("approval", "b")).toThrow(/another device/);
    leases.release("approval", "b");
    expect(() => leases.claim("approval", "b")).toThrow();
    leases.releaseHolder("a");
    leases.claim("approval", "b");
    now += 101;
    expect(leases.claim("approval", "a").holderId).toBe("a");
    expect(changes.filter((event) => event.holderId === null)).toHaveLength(2);
  });

  test("a submitted decision is one-shot even after TTL or disconnect; worker error can retry", () => {
    let now = 0;
    const leases = new ApprovalLeases(
      () => {},
      10,
      () => now,
    );
    leases.add({ requestId: "approval", sessionId: "session" });
    expect(leases.snapshot()).toHaveLength(1);
    leases.submit("approval", "a");
    now = 100;
    leases.releaseHolder("a");
    expect(() => leases.submit("approval", "b")).toThrow(/no longer pending/);
    expect(leases.snapshot()).toHaveLength(0);
    leases.retry("approval");
    leases.submit("approval", "b");
    leases.resolved("approval");
    expect(leases.get("approval")).toBeUndefined();
  });
});

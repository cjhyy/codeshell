import { describe, expect, test } from "bun:test";
import { MAX_PENDING_PAIRING_TOKENS, PairingTokenManager } from "./pairing.js";

describe("PairingTokenManager", () => {
  test("creates one-use token", () => {
    const mgr = new PairingTokenManager(() => 1000);
    const token = mgr.createToken(10_000);
    expect(mgr.consume(token.value)).toBe(true);
    expect(mgr.consume(token.value)).toBe(false);
  });

  test("rejects expired token", () => {
    let now = 1000;
    const mgr = new PairingTokenManager(() => now);
    const token = mgr.createToken(10);
    now = 2000;
    expect(mgr.consume(token.value)).toBe(false);
  });

  test("rejects invalid TTLs and clock values instead of minting immortal tokens", () => {
    const mgr = new PairingTokenManager(() => 1000);
    expect(() => mgr.createToken(Number.NaN)).toThrow("positive safe integer");
    expect(() => mgr.createToken(0)).toThrow("positive safe integer");
    expect(() => mgr.createToken(Number.POSITIVE_INFINITY)).toThrow("positive safe integer");
    expect(() => new PairingTokenManager(() => Number.NaN).createToken()).toThrow(
      "clock is invalid",
    );
    expect(() =>
      new PairingTokenManager(() => Number.MAX_SAFE_INTEGER).createToken(1),
    ).toThrow("clock is invalid");
  });

  test("a broken clock fails closed when consuming an existing token", () => {
    let now = 1000;
    const mgr = new PairingTokenManager(() => now);
    const token = mgr.createToken(1000);
    now = Number.NaN;
    expect(mgr.consume(token.value)).toBe(false);
  });

  test("failed commit keeps the token retryable", () => {
    const mgr = new PairingTokenManager(() => 1000);
    const token = mgr.createToken(10_000);
    expect(() =>
      mgr.commit(token.value, () => {
        throw new Error("disk failed");
      }),
    ).toThrow("disk failed");
    expect(mgr.commit(token.value, () => "ok")).toBe("ok");
    expect(mgr.commit(token.value, () => "again")).toBeUndefined();
  });

  test("successful commit samples expiry once and consumes exactly once", () => {
    let now = 1000;
    const mgr = new PairingTokenManager(() => now);
    const token = mgr.createToken(10);
    const result = mgr.commit(token.value, () => {
      now = 2000;
      return "stored";
    });
    expect(result).toBe("stored");
    expect(mgr.commit(token.value, () => "again")).toBeUndefined();
  });

  test("minting prunes expired tokens and caps abandoned QR codes", () => {
    let now = 1_000;
    const mgr = new PairingTokenManager(() => now);
    mgr.createToken(1);
    now = 1_002;
    mgr.createToken(10_000);
    expect(mgr.pendingCount).toBe(1);

    let oldest = "";
    for (let index = 0; index < MAX_PENDING_PAIRING_TOKENS; index += 1) {
      const token = mgr.createToken(10_000);
      if (index === 0) oldest = token.value;
    }
    expect(mgr.pendingCount).toBe(MAX_PENDING_PAIRING_TOKENS);
    // The previous live token and then the oldest loop token are evicted in
    // insertion order as newer QR codes reach the cap.
    mgr.createToken(10_000);
    expect(mgr.pendingCount).toBe(MAX_PENDING_PAIRING_TOKENS);
    expect(mgr.consume(oldest)).toBe(false);
  });
});

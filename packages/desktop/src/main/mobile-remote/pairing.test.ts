import { describe, expect, test } from "bun:test";
import { PairingTokenManager } from "./pairing.js";

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
});

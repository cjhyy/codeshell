import { randomBytes } from "node:crypto";
import type { PairingToken } from "./types.js";

export const MAX_PENDING_PAIRING_TOKENS = 256;

export class PairingTokenManager {
  private tokens = new Map<string, PairingToken>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  createToken(ttlMs = 10 * 60 * 1000): PairingToken {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Pairing token TTL must be a positive safe integer");
    }
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - ttlMs) {
      throw new Error("Pairing token clock is invalid");
    }
    this.prune(now);
    while (this.tokens.size >= MAX_PENDING_PAIRING_TOKENS) {
      const oldest = this.tokens.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.tokens.delete(oldest);
    }
    const token = {
      value: randomBytes(32).toString("base64url"),
      expiresAt: now + ttlMs,
    };
    this.tokens.set(token.value, token);
    return token;
  }

  consume(value: string): boolean {
    const token = this.tokens.get(value);
    if (!token) return false;
    this.tokens.delete(value);
    const now = this.now();
    return Number.isSafeInteger(now) && now >= 0 && token.expiresAt >= now;
  }

  /**
   * Run a synchronous commit while the token is valid, consuming it only when
   * that commit succeeds. The validity timestamp is sampled once, so a commit
   * that crosses the expiry millisecond cannot create a device yet report a
   * false pairing failure.
   */
  commit<T>(value: string, action: () => T): T | undefined {
    const token = this.tokens.get(value);
    if (!token) return undefined;
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || token.expiresAt < now) {
      this.tokens.delete(value);
      return undefined;
    }
    const result = action();
    this.tokens.delete(value);
    return result;
  }

  /** Live token count for diagnostics/tests; expired entries are pruned on mint. */
  get pendingCount(): number {
    return this.tokens.size;
  }

  private prune(now: number): void {
    for (const [value, token] of this.tokens) {
      if (token.expiresAt < now) this.tokens.delete(value);
    }
  }
}

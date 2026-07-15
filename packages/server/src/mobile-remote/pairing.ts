import { randomBytes } from "node:crypto";
import type { PairingToken } from "./types.js";

export class PairingTokenManager {
  private tokens = new Map<string, PairingToken>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  createToken(ttlMs = 10 * 60 * 1000): PairingToken {
    const token = {
      value: randomBytes(32).toString("base64url"),
      expiresAt: this.now() + ttlMs,
    };
    this.tokens.set(token.value, token);
    return token;
  }

  consume(value: string): boolean {
    const token = this.tokens.get(value);
    if (!token) return false;
    this.tokens.delete(value);
    return token.expiresAt >= this.now();
  }
}

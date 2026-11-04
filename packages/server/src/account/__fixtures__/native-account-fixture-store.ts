import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { RelaySecretCipher } from "../store.js";

/** Test-only key; no real OS store or account credentials are accessed. */
export function fixtureCipher(): RelaySecretCipher {
  const key = Buffer.alloc(32, 7);
  return {
    available: () => true,
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decrypt(value) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
}

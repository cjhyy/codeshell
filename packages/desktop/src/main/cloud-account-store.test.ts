import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CloudAccountStore, type SavedCloudAccount } from "./cloud-account-store.js";

test("account store persists ciphertext with owner-only permissions; corruption, symlinks and unavailable encryption fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-account-store-"));
  const file = join(root, "account.enc");
  const key = randomBytes(32);
  let available = true;
  const store = new CloudAccountStore(file, {
    available: () => available,
    encrypt: (value) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decrypt: (bytes) => {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    },
  });
  const saved: SavedCloudAccount = {
    origin: "https://account.example",
    account: { id: randomUUID(), username: "alice" },
    sessionId: randomUUID(),
    accessToken: randomBytes(32).toString("base64url"),
    refreshToken: randomBytes(32).toString("base64url"),
    accessTokenExpiresAt: Date.now() + 60_000,
    refreshTokenExpiresAt: Date.now() + 86400_000,
  };
  try {
    expect(store.load()).toBeUndefined();
    store.preflight();
    store.save(saved);
    expect(store.load()).toEqual(saved);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file).includes(Buffer.from(saved.accessToken))).toBe(false);
    expect(readFileSync(file).includes(Buffer.from(saved.refreshToken))).toBe(false);
    available = false;
    expect(() => store.preflight()).toThrow();
    expect(() => store.save(saved)).toThrow();
    expect(() => store.load()).toThrow();
    available = true;
    writeFileSync(file, "invalid ciphertext");
    expect(() => store.load()).toThrow();
    store.forget();
    const target = join(root, "other");
    writeFileSync(target, "unchanged");
    symlinkSync(target, file);
    expect(() => store.load()).toThrow();
    store.forget();
    expect(readFileSync(target, "utf8")).toBe("unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

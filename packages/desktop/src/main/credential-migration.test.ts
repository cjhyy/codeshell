import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PlaintextCipher,
  setDefaultCredentialCipher,
  type EncryptionCipher,
} from "@cjhyy/code-shell-core";
import { migrateCredentialStore } from "./credential-migration.js";

class FakeSafeCipher implements EncryptionCipher {
  encrypt(plaintext: string): string {
    return `enc:safeStorage:${Buffer.from(plaintext, "utf8").toString("base64")}`;
  }
  decrypt(stored: string): string {
    if (stored.startsWith("enc:safeStorage:")) {
      return Buffer.from(stored.slice("enc:safeStorage:".length), "base64").toString("utf8");
    }
    if (stored.startsWith("plain:")) return stored.slice("plain:".length);
    if (stored.startsWith("enc:")) throw new Error("foreign ciphertext");
    return stored;
  }
  canDecrypt(stored: string): boolean {
    return !stored.startsWith("enc:") || stored.startsWith("enc:safeStorage:");
  }
}

class FallbackPlainCipher extends FakeSafeCipher {
  override encrypt(plaintext: string): string {
    return `plain:${plaintext}`;
  }
}

describe("credential migration", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-migrate-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-migrate-cwd-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    setDefaultCredentialCipher(new PlaintextCipher());
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("rewrites legacy bare/plain secrets through the active safeStorage cipher", () => {
    setDefaultCredentialCipher(new FakeSafeCipher());
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "credentials.json"),
      JSON.stringify({
        version: 1,
        credentials: [
          { id: "legacy", type: "token", label: "Legacy", secret: "bare-secret" },
          { id: "plain", type: "token", label: "Plain", secret: "plain:plain-secret" },
        ],
      }),
    );

    migrateCredentialStore(cwd);

    const raw = readFileSync(join(home, ".code-shell", "credentials.json"), "utf8");
    expect(raw).toContain("enc:safeStorage:");
    expect(raw).not.toContain("bare-secret");
    expect(raw).not.toContain("plain-secret");
  });

  test("safeStorage unavailable fallback writes plain tagged secrets without failing", () => {
    setDefaultCredentialCipher(new FallbackPlainCipher());
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "credentials.json"),
      JSON.stringify({
        version: 1,
        credentials: [{ id: "legacy", type: "token", label: "Legacy", secret: "bare-secret" }],
      }),
    );

    migrateCredentialStore(cwd);

    const raw = readFileSync(join(home, ".code-shell", "credentials.json"), "utf8");
    expect(raw).toContain("plain:bare-secret");
  });
});

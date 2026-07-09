import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialStore,
  PlaintextCipher,
  setDefaultCredentialCipher,
  type EncryptionCipher,
} from "@cjhyy/code-shell-core";
import { migrateCredentialStore } from "./credential-migration.js";
import { buildCredentialSnapshot } from "./credential-access-service.js";

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

  test("rewrites legacy bare/plain secrets through the active safeStorage cipher", async () => {
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

    await migrateCredentialStore(cwd);

    const raw = readFileSync(join(home, ".code-shell", "credentials.json"), "utf8");
    expect(raw).toContain("enc:safeStorage:");
    expect(raw).not.toContain("bare-secret");
    expect(raw).not.toContain("plain-secret");
  });

  test("safeStorage unavailable fallback writes plain tagged secrets without failing", async () => {
    setDefaultCredentialCipher(new FallbackPlainCipher());
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "credentials.json"),
      JSON.stringify({
        version: 1,
        credentials: [{ id: "legacy", type: "token", label: "Legacy", secret: "bare-secret" }],
      }),
    );

    await migrateCredentialStore(cwd);

    const raw = readFileSync(join(home, ".code-shell", "credentials.json"), "utf8");
    expect(raw).toContain("plain:bare-secret");
  });

  test("does not rewrite already safeStorage-encrypted entries or during snapshot", async () => {
    setDefaultCredentialCipher(new FakeSafeCipher());
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    const credentialsPath = join(home, ".code-shell", "credentials.json");
    writeFileSync(
      credentialsPath,
      JSON.stringify(
        {
          version: 1,
          credentials: [
            {
              id: "encrypted",
              type: "token",
              label: "Encrypted",
              secret: "enc:safeStorage:YWxyZWFkeS1lbmNyeXB0ZWQ=",
            },
          ],
        },
        null,
        2,
      ),
    );
    const beforeSnapshot = readFileSync(credentialsPath, "utf8");

    buildCredentialSnapshot([cwd], 1);
    expect(readFileSync(credentialsPath, "utf8")).toBe(beforeSnapshot);

    const result = await migrateCredentialStore(cwd);
    expect(result.credentials).toBe(0);
    expect(readFileSync(credentialsPath, "utf8")).toBe(beforeSnapshot);
  });

  test("serializes concurrent migrations without corrupting the credentials file", async () => {
    setDefaultCredentialCipher(new FakeSafeCipher());
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "credentials.json"),
      JSON.stringify({
        version: 1,
        credentials: [
          { id: "a", type: "token", label: "A", secret: "secret-a" },
          { id: "b", type: "token", label: "B", secret: "plain:secret-b" },
        ],
      }),
    );

    const runs = Array.from({ length: 8 }, () => migrateCredentialStore(cwd));
    const snapshot = buildCredentialSnapshot([cwd], 2);
    expect(snapshot.revision).toBe(2);
    const results = await Promise.all(runs);

    expect(results.reduce((sum, item) => sum + item.credentials, 0)).toBe(2);
    const raw = readFileSync(join(home, ".code-shell", "credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as { credentials: Array<{ id: string; secret: string }> };
    expect(parsed.credentials.map((cred) => cred.id)).toEqual(["a", "b"]);
    expect(parsed.credentials.every((cred) => cred.secret.startsWith("enc:safeStorage:"))).toBe(
      true,
    );
    expect(raw).not.toContain("secret-a");
    expect(raw).not.toContain("secret-b");
    const listed = new CredentialStore(cwd).list("full");
    expect(listed.map((cred) => ({ id: cred.id, secret: cred.secret }))).toEqual([
      { id: "a", secret: "secret-a" },
      { id: "b", secret: "secret-b" },
    ]);
  });
});

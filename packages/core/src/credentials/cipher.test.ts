import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialStore } from "./store.js";
import { PlaintextCipher, type EncryptionCipher } from "./cipher.js";

/** A reversible fake encrypting cipher: base64 with an `enc:fake:` tag. */
class FakeCipher implements EncryptionCipher {
  encrypt(plaintext: string): string {
    return `enc:fake:${Buffer.from(plaintext, "utf8").toString("base64")}`;
  }
  decrypt(stored: string): string {
    if (stored.startsWith("enc:fake:")) {
      return Buffer.from(stored.slice("enc:fake:".length), "base64").toString("utf8");
    }
    if (stored.startsWith("plain:")) return stored.slice("plain:".length);
    if (stored.startsWith("enc:")) throw new Error("foreign ciphertext");
    return stored; // legacy bare plaintext
  }
  canDecrypt(stored: string): boolean {
    return !stored.startsWith("enc:") || stored.startsWith("enc:fake:");
  }
}

// Isolate HOME to a tmp dir (same pattern as store.test.ts) so list()/resolve()
// — which always merge the user scope (~/.code-shell) — never read the real
// machine's credentials. bun runs each test file in its own process, so this
// HOME override does not race other suites.
describe("CredentialStore + EncryptionCipher", () => {
  let dir: string;
  let prevHome: string | undefined;
  const credPath = () => join(dir, ".code-shell", "credentials.json");

  beforeEach(() => {
    prevHome = process.env.HOME;
    dir = mkdtempSync(join(tmpdir(), "cred-cipher-"));
    process.env.HOME = dir;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  test("encrypting cipher writes ciphertext to disk but returns plaintext", () => {
    const store = new CredentialStore(dir, new FakeCipher());
    store.save("user", { id: "t1", type: "token", label: "T1", secret: "super-secret" });

    // On disk: encrypted, no plaintext present.
    const raw = readFileSync(credPath(), "utf8");
    expect(raw).not.toContain("super-secret");
    expect(raw).toContain("enc:fake:");

    // Through the API: plaintext.
    expect(store.resolve("t1")?.secret).toBe("super-secret");
    expect(store.list()[0].secret).toBe("super-secret");
    // Masked list never leaks full secret.
    const masked = store.listMasked()[0];
    expect(masked.hasSecret).toBe(true);
    expect((masked as { secret?: string }).secret).toBeUndefined();
  });

  test("no double-encryption: save → patch → save keeps a single enc layer", () => {
    // The whole cipher design hinges on read()=decrypt / write()=encrypt being
    // an exact pair: a re-save must NOT wrap the already-encrypted disk value
    // in a second enc layer. Guard it directly — one `enc:fake:` token only,
    // and the value still decrypts to the original plaintext.
    const store = new CredentialStore(dir, new FakeCipher());
    store.save("user", { id: "t1", type: "token", label: "T1", secret: "s3cret" });
    store.patch("user", "t1", { label: "renamed" }); // read→write round-trip
    store.save("user", { id: "t1", type: "token", label: "again", secret: "s3cret" });

    const raw = readFileSync(credPath(), "utf8");
    const stored: string = JSON.parse(raw).credentials[0].secret;
    expect(stored.match(/enc:fake:/g)?.length).toBe(1); // single layer, not nested
    expect(stored).not.toContain("super-secret");
    expect(store.resolve("t1")?.secret).toBe("s3cret"); // decrypts cleanly
  });

  test("PlaintextCipher keeps secrets readable (tagged) — current default behavior", () => {
    const store = new CredentialStore(dir, new PlaintextCipher());
    store.save("user", { id: "t2", type: "token", label: "T2", secret: "abc123" });
    expect(store.resolve("t2")?.secret).toBe("abc123");
    store.save("user", {
      id: "t3",
      type: "token",
      label: "T3",
      secret: "tok",
      exposeAsEnv: "MY_TOKEN",
    });
    expect(store.envExposures("full").MY_TOKEN).toBe("tok");
  });

  test("legacy bare-plaintext credentials.json is still readable under an encrypting cipher", () => {
    // Simulate a pre-cipher file (bare plaintext secret, no tag).
    mkdirSync(join(dir, ".code-shell"), { recursive: true });
    writeFileSync(
      credPath(),
      JSON.stringify({
        version: 1,
        credentials: [{ id: "old", type: "token", label: "Old", secret: "legacy-plain" }],
      }),
    );
    const store = new CredentialStore(dir, new FakeCipher());
    expect(store.resolve("old")?.secret).toBe("legacy-plain");

    // Re-saving migrates it to ciphertext.
    store.save("user", { id: "old", type: "token", label: "Old", secret: "legacy-plain" });
    const raw = readFileSync(credPath(), "utf8");
    expect(raw).not.toContain("legacy-plain");
    expect(raw).toContain("enc:fake:");
    expect(store.resolve("old")?.secret).toBe("legacy-plain");
  });
});

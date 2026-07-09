import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialStore,
  PlaintextCipher,
  setDefaultCredentialCipher,
  type EncryptionCipher,
} from "@cjhyy/code-shell-core";
import { resolveCookieCredentialForBrowser } from "./credential-action.js";

const tempDirs: string[] = [];
let previousHome: string | undefined;

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

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  setDefaultCredentialCipher(new PlaintextCipher());
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  previousHome = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveCookieCredentialForBrowser", () => {
  test("project scope does not fall back to a same-id user credential", () => {
    previousHome = process.env.HOME;
    process.env.HOME = tempDir("cs-desktop-cred-home-");
    const cwd = tempDir("cs-desktop-cred-cwd-");
    const store = new CredentialStore(cwd);
    store.save("user", {
      id: "browser-login",
      type: "cookie",
      label: "User Browser Login",
      secret: JSON.stringify([{ name: "sid", value: "user", domain: "example.com", path: "/" }]),
    });

    const projectScoped = resolveCookieCredentialForBrowser(cwd, "browser-login", "project");
    expect(projectScoped).toEqual({ ok: false, error: '无 cookie 凭证: "browser-login"' });

    const fullScoped = resolveCookieCredentialForBrowser(cwd, "browser-login", "full");
    expect(fullScoped.ok).toBe(true);
  });

  test("decrypts a safeStorage-backed cookie jar for browser injection", () => {
    setDefaultCredentialCipher(new FakeSafeCipher());
    previousHome = process.env.HOME;
    process.env.HOME = tempDir("cs-desktop-cred-home-");
    const cwd = tempDir("cs-desktop-cred-cwd-");
    const store = new CredentialStore(cwd);
    store.save("user", {
      id: "browser-login",
      type: "cookie",
      label: "Browser Login",
      secret: JSON.stringify([
        { name: "sid", value: "plain-cookie", domain: "example.com", path: "/" },
      ]),
    });

    const raw = readFileSync(join(process.env.HOME, ".code-shell", "credentials.json"), "utf8");
    expect(raw).toContain("enc:safeStorage:");
    expect(raw).not.toContain("plain-cookie");
    const resolved = resolveCookieCredentialForBrowser(cwd, "browser-login", "full");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.jar).toEqual([
        { name: "sid", value: "plain-cookie", domain: "example.com", path: "/" },
      ]);
    }
  });
});

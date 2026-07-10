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
import {
  buildCredentialSnapshot,
  materializeCredentialCookieForWorker,
  resolveCredentialValueForWorker,
} from "./credential-access-service.js";

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

class UnavailableSafeCipher implements EncryptionCipher {
  encrypt(plaintext: string): string {
    return `enc:safeStorage:${Buffer.from(plaintext, "utf8").toString("base64")}`;
  }
  decrypt(_stored: string): string {
    throw new Error("safeStorage unavailable");
  }
  canDecrypt(stored: string): boolean {
    return !stored.startsWith("enc:");
  }
}

describe("desktop credential access service", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-main-cred-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-main-cred-cwd-"));
    process.env.HOME = home;
    setDefaultCredentialCipher(new FakeSafeCipher());
  });

  afterEach(() => {
    setDefaultCredentialCipher(new PlaintextCipher());
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("snapshot is metadata-only while resolver/materializer return plaintext-derived values", () => {
    const store = new CredentialStore(cwd);
    store.save("user", {
      id: "figma",
      type: "token",
      label: "Figma",
      secret: "figd_secret",
      exposeAsEnv: "FIGMA_TOKEN",
    });
    store.save("user", {
      id: "xhs",
      type: "cookie",
      label: "XHS",
      secret: JSON.stringify([
        { name: "web_session", value: "cookie-secret", domain: ".example.com", path: "/" },
      ]),
    });

    const raw = readFileSync(join(home, ".code-shell", "credentials.json"), "utf8");
    expect(raw).toContain("enc:safeStorage:");
    expect(raw).not.toContain("figd_secret");
    expect(raw).not.toContain("cookie-secret");

    const snapshot = buildCredentialSnapshot([cwd], 7);
    const entry = snapshot.entries.find((item) => item.cwd === cwd)!;
    expect(snapshot.revision).toBe(7);
    expect(JSON.stringify(entry.full)).not.toContain("figd_secret");
    expect(entry.full.map((cred) => ({ id: cred.id, hasSecret: cred.hasSecret }))).toEqual([
      { id: "figma", hasSecret: true },
      { id: "xhs", hasSecret: true },
    ]);
    expect(entry.envFull.FIGMA_TOKEN).toBe("figd_secret");

    expect(
      resolveCredentialValueForWorker({ cwd, id: "figma", scope: "full", purpose: "use" }),
    ).toEqual({ value: "figd_secret" });
    const materialized = materializeCredentialCookieForWorker({ cwd, id: "xhs", scope: "full" });
    const cookieText = readFileSync(materialized.cookiesFile, "utf8");
    expect(cookieText).toContain("web_session");
    expect(cookieText).toContain("cookie-secret");
    expect(cookieText).not.toContain("enc:safeStorage");
    rmSync(materialized.cookiesFile, { force: true });
  });

  test("snapshot env fail-closes for unreadable safeStorage ciphertext", () => {
    setDefaultCredentialCipher(new UnavailableSafeCipher());
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "credentials.json"),
      JSON.stringify({
        version: 1,
        credentials: [
          {
            id: "figma",
            type: "token",
            label: "Figma",
            secret: "enc:safeStorage:dG9rLTEyMw==",
            exposeAsEnv: "FIGMA_TOKEN",
          },
        ],
      }),
    );

    const snapshot = buildCredentialSnapshot([cwd], 8);
    const entry = snapshot.entries.find((item) => item.cwd === cwd)!;
    expect(entry.full).toEqual([
      {
        id: "figma",
        type: "token",
        label: "Figma",
        exposeAsEnv: "FIGMA_TOKEN",
        autoUseByAI: undefined,
        autoInjectByAI: undefined,
        meta: undefined,
        hasSecret: false,
        secretHint: undefined,
      },
    ]);
    expect(entry.envFull).toEqual({});
    expect(JSON.stringify(snapshot)).not.toContain("enc:safeStorage");
    expect(() =>
      resolveCredentialValueForWorker({ cwd, id: "figma", scope: "full", purpose: "use" }),
    ).toThrow(/unavailable/);
  });

  test("oauth credentials never expose their full secret to the worker", () => {
    const secret = JSON.stringify({
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    new CredentialStore(cwd).save("user", {
      id: "figma-oauth",
      type: "oauth",
      label: "Figma OAuth",
      secret,
    });

    expect(() =>
      resolveCredentialValueForWorker({
        cwd,
        id: "figma-oauth",
        scope: "full",
        purpose: "mcp",
      }),
    ).toThrow(/host access resolver/);
    expect(() =>
      resolveCredentialValueForWorker({
        cwd,
        id: "figma-oauth",
        scope: "full",
        purpose: "use",
      }),
    ).toThrow(/token\/link credential/);
  });
});

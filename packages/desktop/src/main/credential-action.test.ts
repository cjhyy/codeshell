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
import {
  refreshCookieCredentialFromBrowser,
  resolveCookieCredentialForBrowser,
} from "./credential-action.js";

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

  test("a same-id project token still shadows a user cookie in full scope", () => {
    previousHome = process.env.HOME;
    process.env.HOME = tempDir("cs-desktop-cred-home-");
    const cwd = tempDir("cs-desktop-cred-cwd-");
    const store = new CredentialStore(cwd);
    store.save("user", {
      id: "browser-login",
      type: "cookie",
      label: "User Browser Login",
      secret: JSON.stringify([{ name: "sid", value: "user", domain: "example.com" }]),
    });
    store.save("project", {
      id: "browser-login",
      type: "token",
      label: "Project Token",
      secret: "not-a-cookie",
    });

    expect(resolveCookieCredentialForBrowser(cwd, "browser-login", "full")).toEqual({
      ok: false,
      error: '无 cookie 凭证: "browser-login"',
    });
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
      expect(resolved.storeScope).toBe("user");
    }
  });

  test("writes a refreshed jar back to the originating project credential", () => {
    previousHome = process.env.HOME;
    process.env.HOME = tempDir("cs-desktop-cred-home-");
    const cwd = tempDir("cs-desktop-cred-cwd-");
    const store = new CredentialStore(cwd);
    store.save("user", {
      id: "browser-login",
      type: "cookie",
      label: "User Login",
      secret: JSON.stringify([{ name: "sid", value: "user", domain: "example.com" }]),
    });
    store.save("project", {
      id: "browser-login",
      type: "cookie",
      label: "Project Login",
      secret: JSON.stringify([{ name: "sid", value: "old", domain: "example.com" }]),
      meta: { domain: "example.com", scope: "domain", autoRefreshFromBrowser: true },
    });

    expect(
      refreshCookieCredentialFromBrowser(
        cwd,
        "browser-login",
        "project",
        [{ name: "sid", value: "fresh", domain: "example.com" }],
        store.resolve("browser-login", "project")!.secret!,
      ),
    ).toBe("updated");
    expect(JSON.parse(store.resolve("browser-login", "project")!.secret!)[0].value).toBe("fresh");
    expect(JSON.parse(new CredentialStore().resolve("browser-login")!.secret!)[0].value).toBe(
      "user",
    );
    store.remove("project", "browser-login");
    expect(
      refreshCookieCredentialFromBrowser(
        cwd,
        "browser-login",
        "project",
        [{ name: "sid", value: "late", domain: "example.com" }],
        "old",
      ),
    ).toBe("missing");
    expect(JSON.parse(new CredentialStore().resolve("browser-login")!.secret!)[0].value).toBe(
      "user",
    );
  });

  test("does not resurrect a missing credential or overwrite it with an empty jar", () => {
    previousHome = process.env.HOME;
    process.env.HOME = tempDir("cs-desktop-cred-home-");
    const cwd = tempDir("cs-desktop-cred-cwd-");
    const store = new CredentialStore(cwd);
    store.save("user", {
      id: "browser-login",
      type: "cookie",
      label: "Browser Login",
      secret: JSON.stringify([{ name: "sid", value: "kept", domain: "example.com" }]),
    });

    expect(refreshCookieCredentialFromBrowser(cwd, "browser-login", "user", [], "old")).toBe(
      "empty",
    );
    expect(JSON.parse(new CredentialStore().resolve("browser-login")!.secret!)[0].value).toBe(
      "kept",
    );
    store.remove("user", "browser-login");
    expect(
      refreshCookieCredentialFromBrowser(
        cwd,
        "browser-login",
        "user",
        [{ name: "sid", value: "stale", domain: "example.com" }],
        "old",
      ),
    ).toBe("missing");
  });

  test("does not update a cookie credential while automatic refresh is disabled", () => {
    previousHome = process.env.HOME;
    process.env.HOME = tempDir("cs-desktop-cred-home-");
    const cwd = tempDir("cs-desktop-cred-cwd-");
    const store = new CredentialStore(cwd);
    store.save("user", {
      id: "browser-login",
      type: "cookie",
      label: "Browser Login",
      secret: JSON.stringify([{ name: "sid", value: "kept", domain: "example.com" }]),
      meta: { domain: "example.com", autoRefreshFromBrowser: false },
    });

    expect(
      refreshCookieCredentialFromBrowser(
        cwd,
        "browser-login",
        "user",
        [{ name: "sid", value: "fresh", domain: "example.com" }],
        store.resolve("browser-login")!.secret!,
      ),
    ).toBe("disabled");
    expect(JSON.parse(new CredentialStore().resolve("browser-login")!.secret!)[0].value).toBe(
      "kept",
    );
    const original = new CredentialStore().resolve("browser-login")!.secret!;
    store.patch("user", "browser-login", { meta: { autoRefreshFromBrowser: true } });
    // A later same-id project record must not redirect the bound user's write.
    store.save("project", {
      id: "browser-login",
      type: "cookie",
      label: "Project",
      secret: "[]",
      meta: { autoRefreshFromBrowser: true },
    });
    expect(
      refreshCookieCredentialFromBrowser(
        cwd,
        "browser-login",
        "user",
        [{ domain: "example.com", value: "kept", name: "sid" }],
        original,
      ),
    ).toBe("unchanged");
    expect(new CredentialStore().resolve("browser-login")!.secret).toBe(original);
    expect(
      refreshCookieCredentialFromBrowser(
        cwd,
        "browser-login",
        "user",
        [{ name: "sid", value: "fresh", domain: "example.com" }],
        original,
      ),
    ).toBe("updated");
    expect(store.resolve("browser-login", "project")!.secret).toBe("[]");
    // A delayed snapshot cannot undo a newer saved login or rotation.
    expect(
      refreshCookieCredentialFromBrowser(
        cwd,
        "browser-login",
        "user",
        [{ name: "sid", value: "late", domain: "example.com" }],
        original,
      ),
    ).toBe("conflict");
    expect(JSON.parse(new CredentialStore().resolve("browser-login")!.secret!)[0].value).toBe(
      "fresh",
    );
  });
});

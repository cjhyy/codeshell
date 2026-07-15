/**
 * Task 1 (identity dimension foundations): CredentialStore's user scope must
 * honor an explicitly injected store dir — the seam a per-identity server
 * deployment uses instead of relocating $HOME. Default (no override) behavior
 * is covered by the existing credentials tests.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "./store.js";
import type { Credential } from "./types.js";

function cred(id: string): Credential {
  return {
    id,
    type: "token",
    label: `cred ${id}`,
    secret: `secret-${id}`,
  } as Credential;
}

describe("CredentialStore — injected user dir", () => {
  let userDir: string;
  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), "csh-creds-"));
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  test("user-scope save/read round-trips through the injected dir", () => {
    const store = new CredentialStore(undefined, undefined, userDir);
    store.save("user", cred("alpha"));

    const file = join(userDir, "credentials.json");
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf-8")) as { credentials: Credential[] };
    expect(onDisk.credentials.map((c) => c.id)).toEqual(["alpha"]);

    // A second store pointed at the same injected dir sees the credential…
    const reread = new CredentialStore(undefined, undefined, userDir);
    expect(reread.list("full").map((c) => c.id)).toEqual(["alpha"]);

    // …while a store rooted elsewhere does not (isolation between roots).
    const otherDir = mkdtempSync(join(tmpdir(), "csh-creds-other-"));
    try {
      const other = new CredentialStore(undefined, undefined, otherDir);
      expect(other.list("full")).toEqual([]);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("remove() operates on the injected dir", () => {
    const store = new CredentialStore(undefined, undefined, userDir);
    store.save("user", cred("beta"));
    store.remove("user", "beta");
    expect(new CredentialStore(undefined, undefined, userDir).list("full")).toEqual([]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "./store.js";
import { PlaintextCipher } from "./cipher.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "credential-cas-"));
  directories.push(directory);
  return { directory, store: new CredentialStore(undefined, new PlaintextCipher(), directory) };
}
const credential = {
  id: "fixture",
  type: "link" as const,
  label: "Fixture",
  secret: "synthetic-secret",
};

describe("CredentialStore atomic compare-and-swap", () => {
  test("create-only cannot overwrite an existing record or unrelated credential", () => {
    const { store } = fixture();
    store.save("user", { ...credential, id: "unrelated" });
    expect(store.compareAndSwap("user", credential.id, null, credential)).toBe(true);
    expect(
      store.compareAndSwap("user", credential.id, null, { ...credential, secret: "changed" }),
    ).toBe(false);
    expect(store.list()).toHaveLength(2);
    expect(store.resolve(credential.id)?.secret).toBe(credential.secret);
  });
  test("another store instance changing a secret invalidates replace and delete", () => {
    const { store, directory } = fixture();
    store.save("user", credential);
    const reviewed = store.resolve(credential.id)!;
    const other = new CredentialStore(undefined, new PlaintextCipher(), directory);
    other.save("user", { ...credential, secret: "rotated" });
    expect(
      store.compareAndSwap("user", credential.id, reviewed, { ...reviewed, label: "Old" }),
    ).toBe(false);
    expect(store.compareAndSwap("user", credential.id, reviewed, null)).toBe(false);
    expect(other.resolve(credential.id)?.secret).toBe("rotated");
  });
  test("deleted credentials cannot be resurrected and successful deletion preserves neighbors", () => {
    const { store } = fixture();
    store.save("user", credential);
    store.save("user", { ...credential, id: "neighbor" });
    const reviewed = store.resolve(credential.id)!;
    expect(store.compareAndSwap("user", credential.id, reviewed, null)).toBe(true);
    expect(store.compareAndSwap("user", credential.id, reviewed, credential)).toBe(false);
    expect(store.list().map((entry) => entry.id)).toEqual(["neighbor"]);
  });
  test("replacement retains the injected encryption boundary and normalizes object order", () => {
    const { directory } = fixture();
    const cipher = {
      encrypt: (value: string) => "enc:fixture:" + Buffer.from(value).toString("base64"),
      decrypt: (value: string) =>
        Buffer.from(value.slice("enc:fixture:".length), "base64").toString(),
      canDecrypt: (value: string) => value.startsWith("enc:fixture:"),
    };
    const store = new CredentialStore(undefined, cipher, directory);
    store.save("user", credential);
    const reviewed = {
      secret: credential.secret,
      label: credential.label,
      type: credential.type,
      id: credential.id,
    };
    expect(
      store.compareAndSwap("user", credential.id, reviewed, { ...credential, label: "Renamed" }),
    ).toBe(true);
    expect(store.resolve(credential.id)?.label).toBe("Renamed");
    expect(readFileSync(join(directory, "credentials.json"), "utf8")).not.toContain(
      credential.secret,
    );
  });
});

test("asynchronous store operations replay a conflicting edit outside locks and preserve opaque entries", async () => {
  const { credentialFileCommand } = await import("../storage/credential-files.js");
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "credential-detached-"));
  try {
    const path = join(dir, "credentials.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, credentials: [{ type: "future", token: "untouched" }] }),
    );
    const sync = new PlaintextCipher();
    const cipher = Object.assign(sync, {
      asynchronous: {
        async decrypt(stored: string) {
          expect(existsSync(dir + ".lock")).toBe(false);
          return sync.decrypt(stored);
        },
        async encrypt(plain: string) {
          expect(existsSync(dir + ".lock")).toBe(false);
          return sync.encrypt(plain);
        },
      },
    });
    const store = new CredentialStore(undefined, cipher, dir);
    let interfere = true,
      attempts = 0;
    const files = {
      read: async (address: import("../storage/credential-files.js").CredentialFileAddress) =>
        credentialFileCommand(
          dir,
          "credentials/read",
          address,
        ) as import("../storage/credential-files.js").CredentialFileSnapshot,
      commit: async (
        address: import("../storage/credential-files.js").CredentialFileAddress,
        expectedRevision: string,
        file: import("./types.js").CredentialStoreFile,
      ) => {
        if (interfere) {
          interfere = false;
          store.save("user", { ...credential, id: "other" });
        }
        return credentialFileCommand(dir, "credentials/commit", {
          ...address,
          expectedRevision,
          file,
        }) as boolean;
      },
    };
    await store.withAsyncCipher(files, ["user"], "user", (s) => {
      attempts++;
      s.save("user", credential);
    });
    expect(attempts).toBe(2);
    expect(
      store
        .list()
        .map((c) => c.id)
        .sort(),
    ).toEqual(["fixture", "other"]);
    expect(JSON.parse(readFileSync(path, "utf8")).credentials).toContainEqual({
      type: "future",
      token: "untouched",
    });
    const before = await files.read({ scope: "user" });
    expect(() =>
      credentialFileCommand(
        dir,
        "credentials/commit",
        { scope: "user", expectedRevision: before.revision, file: { version: 1, credentials: [] } },
        new Int32Array(new SharedArrayBuffer(4)).fill(2),
      ),
    ).toThrow("revoked");
    expect(store.list()).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

import { test, expect } from "bun:test";
import { encryptDesktopCredential } from "./credential-cipher-policy.js";

test("unavailable and Linux basic_text keyrings never silently save plaintext", () => {
  const storage = {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw Error("must not encrypt");
    },
  };
  expect(() => encryptDesktopCredential(storage, "fixture", "darwin")).toThrow("钥匙串");
  expect(() =>
    encryptDesktopCredential(
      {
        ...storage,
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "basic_text",
      },
      "fixture",
      "linux",
    ),
  ).toThrow("钥匙串");
  expect(
    encryptDesktopCredential(
      {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "gnome_libsecret",
        encryptString: () => Buffer.from("encrypted"),
      },
      "fixture",
      "linux",
    ),
  ).toBe("enc:safeStorage:ZW5jcnlwdGVk");
});

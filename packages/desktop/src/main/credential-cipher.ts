/**
 * Desktop credential cipher — Electron safeStorage implementation of core's
 * EncryptionCipher. The OS-keychain-backed key lives only in the main process,
 * which is why core can't own this: core defines the interface, the host (here)
 * supplies the key.
 *
 * New writes require the OS keyring. Legacy plain values remain readable so
 * users can migrate them after restoring a protected storage backend.
 */
import { encryptDesktopCredential } from "./credential-cipher-policy.js";
import { safeStorage } from "electron";
import type { AsyncEncryptionCipher, EncryptionCipher } from "@cjhyy/code-shell-core";

const ENC_PREFIX = "enc:safeStorage:";
const PLAIN_PREFIX = "plain:";

export class SafeStorageCipher implements EncryptionCipher {
  readonly asynchronous: AsyncEncryptionCipher = {
    storagePrefix: ENC_PREFIX,
    encrypt: async (plaintext) => {
      if (
        !(await safeStorage.isAsyncEncryptionAvailable()) ||
        (process.platform === "linux" &&
          ["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend()))
      )
        throw new Error(
          "系统钥匙串不可用，无法安全保存凭据。请解锁钥匙串或启用系统密钥服务后重试。",
        );
      const encrypted = await safeStorage.encryptStringAsync(plaintext);
      return ENC_PREFIX + encrypted.toString("base64");
    },
    decrypt: async (stored) => {
      if (stored.startsWith(ENC_PREFIX)) {
        const { result } = await safeStorage.decryptStringAsync(
          Buffer.from(stored.slice(ENC_PREFIX.length), "base64"),
        );
        return result;
      }
      if (stored.startsWith("enc:")) throw new Error("Unrecognized encrypted credential");
      return stored.startsWith(PLAIN_PREFIX) ? stored.slice(PLAIN_PREFIX.length) : stored;
    },
    canDecrypt: async (stored) =>
      stored.startsWith(ENC_PREFIX)
        ? safeStorage.isAsyncEncryptionAvailable()
        : !stored.startsWith("enc:"),
  };
  private available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  encrypt(plaintext: string): string {
    return encryptDesktopCredential(safeStorage, plaintext);
  }

  decrypt(stored: string): string {
    if (stored.startsWith(ENC_PREFIX)) {
      const buf = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
      return safeStorage.decryptString(buf);
    }
    if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
    if (stored.startsWith("enc:")) {
      throw new Error("SafeStorageCipher cannot decrypt a foreign encrypted credential");
    }
    return stored; // legacy bare plaintext
  }

  canDecrypt(stored: string): boolean {
    if (stored.startsWith(ENC_PREFIX)) return this.available();
    // plain: and legacy bare plaintext are always readable.
    return !stored.startsWith("enc:");
  }
}

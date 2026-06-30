/**
 * Desktop credential cipher — Electron safeStorage implementation of core's
 * EncryptionCipher. The OS-keychain-backed key lives only in the main process,
 * which is why core can't own this: core defines the interface, the host (here)
 * supplies the key.
 *
 * Stored form: `enc:safeStorage:<base64>`. On a platform where safeStorage is
 * unavailable (some Linux desktops without a keyring), we fall back to writing
 * plaintext (tagged `plain:`) so credentials still work at 0o600 — exactly the
 * pre-cipher behavior — rather than failing to save. canDecrypt() lets the
 * store recognize foreign/legacy values and migrate them on next save.
 */
import { safeStorage } from "electron";
import type { EncryptionCipher } from "@cjhyy/code-shell-core";

const ENC_PREFIX = "enc:safeStorage:";
const PLAIN_PREFIX = "plain:";

export class SafeStorageCipher implements EncryptionCipher {
  private available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  encrypt(plaintext: string): string {
    if (!this.available()) return `${PLAIN_PREFIX}${plaintext}`;
    const buf = safeStorage.encryptString(plaintext);
    return `${ENC_PREFIX}${buf.toString("base64")}`;
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

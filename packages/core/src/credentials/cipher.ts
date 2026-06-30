/**
 * Credential encryption boundary.
 *
 * The core has no business owning a platform encryption key — on the desktop
 * the only safe key lives behind Electron `safeStorage`, which is in the main
 * process, not in this worker. So core defines an INTERFACE and the host feeds
 * an implementation: desktop main injects a safeStorage-backed cipher; the
 * headless CLI / SDK inject {@link PlaintextCipher}. This keeps `safeStorage`
 * out of `packages/core` entirely (`grep -R safeStorage packages/core/src`
 * must stay empty) and puts secret crypto where the key actually is.
 *
 * The stored field is a tagged string so a store written by one cipher can be
 * read (or rejected) by another:
 *   - `plain:<secret>`        — PlaintextCipher, or any pre-cipher legacy value
 *                               that has no recognized prefix (treated as plain).
 *   - `enc:<scheme>:<base64>` — an encrypting cipher; `<scheme>` lets a cipher
 *                               recognize its own ciphertext via canDecrypt().
 */
export interface EncryptionCipher {
  /** Encrypt a plaintext secret into its stored (tagged) form. */
  encrypt(plaintext: string): string;
  /** Decrypt a stored value back to plaintext. Must accept this cipher's own
   *  output and legacy un-prefixed plaintext; may throw if a value is
   *  recognizably foreign and undecryptable. */
  decrypt(stored: string): string;
  /** True when this cipher can decrypt `stored`. Used by the store to decide
   *  whether to migrate (re-encrypt on next save) a value written by a
   *  different cipher / left as legacy plaintext. */
  canDecrypt?(stored: string): boolean;
}

const PLAIN_PREFIX = "plain:";

/**
 * The no-encryption strategy — chosen explicitly, not a no-op. Headless and
 * SDK hosts have no safe key store, so they keep credentials as owner-only
 * (0o600) plaintext, exactly as before this boundary existed. Named so the
 * choice reads honestly in host wiring: `new CredentialStore(cwd, new
 * PlaintextCipher())` says "plaintext on purpose", not "forgot to encrypt".
 */
export class PlaintextCipher implements EncryptionCipher {
  encrypt(plaintext: string): string {
    return `${PLAIN_PREFIX}${plaintext}`;
  }

  decrypt(stored: string): string {
    // Accept our own tag, and treat any un-tagged legacy value as plaintext.
    if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
    if (stored.startsWith("enc:")) {
      throw new Error("PlaintextCipher cannot decrypt an encrypted credential");
    }
    return stored;
  }

  canDecrypt(stored: string): boolean {
    return !stored.startsWith("enc:");
  }
}

/** Reads a value that may be tagged (`plain:`) or legacy bare plaintext. */
export function readPlaintext(stored: string): string {
  return stored.startsWith(PLAIN_PREFIX) ? stored.slice(PLAIN_PREFIX.length) : stored;
}

// ─── Process-default cipher ──────────────────────────────────────
// CredentialStore is constructed at ~12 call sites (core + desktop) as
// `new CredentialStore(cwd)`. Rather than thread a cipher through every one,
// the host sets the process default ONCE at startup; stores pick it up unless
// a cipher is passed explicitly. Defaults to PlaintextCipher so any host that
// never calls the setter behaves exactly as before.
let defaultCipher: EncryptionCipher = new PlaintextCipher();

/** Host startup hook: install the process-wide credential cipher (desktop main
 *  passes a safeStorage-backed implementation). Idempotent; last call wins. */
export function setDefaultCredentialCipher(cipher: EncryptionCipher): void {
  defaultCipher = cipher;
}

/** The current process-default cipher (PlaintextCipher unless a host set one). */
export function getDefaultCredentialCipher(): EncryptionCipher {
  return defaultCipher;
}

import { randomUUID } from "node:crypto";
import type { EncryptionCipher } from "./cipher.js";
import type { CredentialStoreFile } from "./types.js";
import type { CredentialScope } from "./store.js";
import type { CredentialFileAddress, CredentialFileSnapshot } from "../storage/credential-files.js";

export interface CredentialFileAccess {
  read(address: CredentialFileAddress): Promise<CredentialFileSnapshot>;
  commit(
    address: CredentialFileAddress,
    expectedRevision: string,
    file: CredentialStoreFile,
  ): Promise<boolean>;
}
export interface DetachedCredentialState {
  files: Partial<Record<CredentialScope, CredentialStoreFile>>;
  writeScope?: CredentialScope;
  next?: CredentialStoreFile;
}

/** Runs one synchronous, replayable credential operation on an isolated image.
 * Only the final tagged bytes and expected revision reach the storage writer.
 * Private cleanup entries use the same cipher as ordinary credentials. */
export async function runCredentialOperation<T>(
  files: CredentialFileAccess,
  platform: EncryptionCipher,
  cwd: string | undefined,
  readScopes: readonly CredentialScope[],
  writeScope: CredentialScope | undefined,
  operation: (cipher: EncryptionCipher, state: DetachedCredentialState) => T,
): Promise<T> {
  const cipher = platform.asynchronous ?? platform;
  const scopes = new Set([...readScopes, ...(writeScope ? [writeScope] : [])]);
  if (!cwd) scopes.delete("project");
  if (writeScope === "project" && !cwd) throw new Error("Credential project scope is unavailable");
  const address = (scope: CredentialScope): CredentialFileAddress =>
    scope === "user" ? { scope } : { scope, cwd };
  for (let attempt = 0; attempt < 16; attempt++) {
    const images = await Promise.all(
      [...scopes].map(async (scope) => [scope, await files.read(address(scope))] as const),
    );
    const state: DetachedCredentialState = { files: {}, writeScope };
    const plaintexts = new Map<string, string>();
    const unavailable = new Set<string>();
    const prepared = new Map<string, string>();
    const nonce = randomUUID();
    async function decode(value: string) {
      if (plaintexts.has(value) || unavailable.has(value)) return plaintexts.get(value);
      try {
        if (cipher.canDecrypt && !(await cipher.canDecrypt(value))) throw new Error("Unavailable");
        const plain = await cipher.decrypt(value);
        plaintexts.set(value, plain);
        return plain;
      } catch {
        unavailable.add(value);
        return undefined;
      }
    }
    for (const [scope, img] of images) {
      state.files[scope] = img.file;
      for (const entry of img.file.credentials) {
        if (
          typeof entry?.secret !== "string" ||
          !entry.secret ||
          !["token", "link", "cookie", "oauth", "remote-link-retirement"].includes(entry.type)
        )
          continue;
        const plain = await decode(entry.secret);
        // Retirement records can retain custody of an older encrypted token.
        if ((entry as { type: string }).type === "remote-link-retirement" && plain) {
          try {
            const nested = JSON.parse(plain)?.secret;
            if (typeof nested === "string" && nested.startsWith("enc:")) await decode(nested);
          } catch {
            /* Opaque cleanup data remains byte-for-byte intact. */
          }
        }
      }
    }
    const cached: EncryptionCipher = {
      canDecrypt: (value) => !unavailable.has(value) && plaintexts.has(value),
      decrypt(value) {
        const plain = plaintexts.get(value);
        if (plain === undefined) throw new Error("Credential unavailable");
        return plain;
      },
      encrypt(value) {
        const tag = "enc:pending-" + nonce + ":" + prepared.size;
        prepared.set(tag, value);
        return tag;
      },
    };
    // A keychain prompt may outlive a rotation or removal. Re-read every
    // observed revision before publishing plaintext, including read-only use.
    if (!writeScope) {
      const current = await Promise.all(images.map(([scope]) => files.read(address(scope))));
      if (current.some((value, index) => value.revision !== images[index][1].revision)) continue;
    }
    const result = operation(cached, state);
    if (result && typeof (result as { then?: unknown }).then === "function")
      throw new Error("Credential transaction operations must be synchronous");
    if (!state.next || !writeScope) return result;
    const encoded: CredentialStoreFile["credentials"] = [];
    for (const entry of state.next.credentials) {
      const plain = typeof entry?.secret === "string" ? prepared.get(entry.secret) : undefined;
      encoded.push(plain === undefined ? entry : { ...entry, secret: await cipher.encrypt(plain) });
    }
    const before = images.find(([scope]) => scope === writeScope)![1];
    if (
      await files.commit(address(writeScope), before.revision, {
        ...state.next,
        credentials: encoded,
      })
    )
      return result;
  }
  throw new Error("Credential store changed repeatedly; retry the operation");
}

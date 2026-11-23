import {
  getDefaultCredentialCipher,
  type Credential,
  type EncryptionCipher,
  type AsyncEncryptionCipher,
} from "@cjhyy/code-shell-core";
import { credentialFiles } from "./credential-file-client.js";
import type { CredentialFileAddress } from "@cjhyy/code-shell-core/internal/storage";

export interface CredentialMigrationResult {
  stores: number;
  credentials: number;
}

const fileQueues = new Map<string, Promise<void>>();
const PROBE_SECRET = "__codeshell_migration_probe__";

export async function migrateCredentialStore(cwd?: string): Promise<CredentialMigrationResult> {
  const result: CredentialMigrationResult = { stores: 0, credentials: 0 };
  result.credentials += await rewriteScope("user", undefined);
  result.stores += 1;
  if (cwd) {
    result.credentials += await rewriteScope("project", cwd);
    result.stores += 1;
  }
  return result;
}

export async function migrateKnownCredentialStores(
  cwds: string[],
): Promise<CredentialMigrationResult> {
  const result: CredentialMigrationResult = { stores: 0, credentials: 0 };
  const seen = new Set<string>();
  result.credentials += await rewriteScope("user", undefined);
  result.stores += 1;
  for (const cwd of cwds) {
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    result.credentials += await rewriteScope("project", cwd);
    result.stores += 1;
  }
  return result;
}

async function rewriteScope(scope: "user" | "project", cwd: string | undefined): Promise<number> {
  if (scope === "project" && !cwd) return 0;
  const address: CredentialFileAddress = scope === "user" ? { scope } : { scope, cwd };
  return enqueueForFile(JSON.stringify(address), () => rewriteCredentialFile(address));
}

function enqueueForFile<T>(filePath: string, work: () => T | Promise<T>): Promise<T> {
  const previous = fileQueues.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  const marker = current.then(
    () => undefined,
    () => undefined,
  );
  fileQueues.set(filePath, marker);
  void marker.finally(() => {
    if (fileQueues.get(filePath) === marker) fileQueues.delete(filePath);
  });
  return current;
}

async function rewriteCredentialFile(address: CredentialFileAddress): Promise<number> {
  const sync = getDefaultCredentialCipher();
  const cipher: EncryptionCipher | AsyncEncryptionCipher = sync.asynchronous ?? sync;
  const files = credentialFiles();
  let target: string | undefined;
  for (let attempt = 0; attempt < 16; attempt++) {
    const before = await files.read(address);
    if (!before.file.credentials.some((c) => typeof c?.secret === "string" && c.secret.length))
      return 0;
    if (target === undefined) {
      try {
        target =
          sync.asynchronous?.storagePrefix ?? storagePrefix(await cipher.encrypt(PROBE_SECRET));
      } catch {
        return 0;
      }
    }
    if (!target) return 0;
    let count = 0;
    const credentials: Credential[] = [];
    for (const record of before.file.credentials) {
      const value = record?.secret;
      if (typeof value !== "string" || !value || storagePrefix(value) === target) {
        credentials.push(record);
        continue;
      }
      let plaintext: string;
      try {
        if (cipher.canDecrypt && !(await cipher.canDecrypt(value))) {
          credentials.push(record);
          continue;
        }
        plaintext = await cipher.decrypt(value);
      } catch {
        credentials.push(record);
        continue;
      }
      credentials.push({ ...record, secret: await cipher.encrypt(plaintext) });
      count++;
    }
    if (!count || (await files.commit(address, before.revision, { ...before.file, credentials })))
      return count;
  }
  throw new Error("Credential store changed repeatedly during migration");
}

function storagePrefix(stored: string): string {
  const encrypted = /^enc:[^:]+:/.exec(stored);
  if (encrypted) return encrypted[0];
  if (stored.startsWith("plain:")) return "plain:";
  return "";
}

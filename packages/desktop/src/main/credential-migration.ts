import {
  getDefaultCredentialCipher,
  userHome,
  type Credential,
  type CredentialStoreFile,
  type EncryptionCipher,
} from "@cjhyy/code-shell-core";
import { mutateJsonFile } from "@cjhyy/code-shell-core/internal";
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CredentialMigrationResult {
  stores: number;
  credentials: number;
}

const fileQueues = new Map<string, Promise<void>>();
const PROBE_SECRET = "__codeshell_migration_probe__";
const MAX_CREDENTIAL_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CREDENTIALS = 4_096;

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
  const filePath = credentialFilePath(scope, cwd);
  if (!filePath) return 0;
  return enqueueForFile(filePath, () => rewriteCredentialFile(filePath));
}

function credentialFilePath(
  scope: "user" | "project",
  cwd: string | undefined,
): string | undefined {
  if (scope === "user") return join(userHome(), ".code-shell", "credentials.json");
  if (!cwd) return undefined;
  return join(cwd, ".code-shell", "credentials.json");
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

function rewriteCredentialFile(filePath: string): number {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentInfo = lstatSync(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("credential migration parent must be a real directory");
  }
  const cipher = getDefaultCredentialCipher();
  return (
    mutateJsonFile<CredentialStoreFile, number>(filePath, {
      parse: (raw) => {
        if (raw === undefined) return { version: 1, credentials: [] };
        const parsed = JSON.parse(raw) as Partial<CredentialStoreFile>;
        if (!Array.isArray(parsed.credentials) || parsed.credentials.length > MAX_CREDENTIALS) {
          throw new Error("credential store is invalid");
        }
        return { version: 1, credentials: parsed.credentials as Credential[] };
      },
      serialize: (file) => `${JSON.stringify(file, null, 2)}\n`,
      mutation: (file) => {
        let count = 0;
        const credentials = file.credentials.map((cred) => {
          if (!cred || typeof cred !== "object" || !shouldRewriteCredential(cred, cipher)) {
            return cred;
          }
          const secret = cred.secret;
          if (typeof secret !== "string" || secret.length === 0) return cred;
          let plaintext: string;
          try {
            plaintext = cipher.decrypt(secret);
          } catch {
            return cred;
          }
          const rewritten = cipher.encrypt(plaintext);
          count += 1;
          return { ...cred, secret: rewritten };
        });
        return {
          ...(count > 0 ? { value: { version: 1 as const, credentials } } : {}),
          result: count,
        };
      },
      mode: 0o600,
      maxBytes: MAX_CREDENTIAL_FILE_BYTES,
    }) ?? 0
  );
}

export function shouldRewriteCredential(
  cred: Credential,
  cipher: EncryptionCipher = getDefaultCredentialCipher(),
): boolean {
  const secret = cred.secret;
  if (typeof secret !== "string" || secret.length === 0) return false;
  const targetPrefix = targetStoragePrefix(cipher);
  if (!targetPrefix) return false;

  if (secret.startsWith("enc:")) {
    if (storagePrefix(secret) === targetPrefix) return false;
    return canDecrypt(cipher, secret);
  }
  if (secret.startsWith("plain:")) return targetPrefix !== "plain:";
  return true;
}

function canDecrypt(cipher: EncryptionCipher, stored: string): boolean {
  try {
    if (cipher.canDecrypt && !cipher.canDecrypt(stored)) return false;
    cipher.decrypt(stored);
    return true;
  } catch {
    return false;
  }
}

function targetStoragePrefix(cipher: EncryptionCipher): string | undefined {
  try {
    return storagePrefix(cipher.encrypt(PROBE_SECRET));
  } catch {
    return undefined;
  }
}

function storagePrefix(stored: string): string {
  const encrypted = /^enc:[^:]+:/.exec(stored);
  if (encrypted) return encrypted[0];
  if (stored.startsWith("plain:")) return "plain:";
  return "";
}

import {
  CredentialStore,
  isCredentialSecretAvailable,
  type Credential,
} from "@cjhyy/code-shell-core";

export interface CredentialMigrationResult {
  stores: number;
  credentials: number;
}

export function migrateCredentialStore(cwd?: string): CredentialMigrationResult {
  const result: CredentialMigrationResult = { stores: 0, credentials: 0 };
  result.credentials += rewriteScope("user", undefined);
  result.stores += 1;
  if (cwd) {
    result.credentials += rewriteScope("project", cwd);
    result.stores += 1;
  }
  return result;
}

export async function migrateKnownCredentialStores(
  cwds: string[],
): Promise<CredentialMigrationResult> {
  const result: CredentialMigrationResult = { stores: 0, credentials: 0 };
  const seen = new Set<string>();
  result.credentials += rewriteScope("user", undefined);
  result.stores += 1;
  for (const cwd of cwds) {
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    result.credentials += rewriteScope("project", cwd);
    result.stores += 1;
  }
  return result;
}

function rewriteScope(scope: "user" | "project", cwd: string | undefined): number {
  if (scope === "project" && !cwd) return 0;
  const store = new CredentialStore(cwd);
  const creds =
    scope === "user" ? new CredentialStore(undefined).list("full") : store.list("project");
  let count = 0;
  for (const cred of creds) {
    if (!shouldRewriteCredential(cred)) continue;
    store.save(scope, cred);
    count += 1;
  }
  return count;
}

function shouldRewriteCredential(cred: Credential): boolean {
  if (!isCredentialSecretAvailable(cred.secret)) return false;
  return true;
}

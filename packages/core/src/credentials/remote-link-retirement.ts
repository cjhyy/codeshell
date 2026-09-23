import { createHash, randomUUID } from "node:crypto";
import type { Credential } from "./types.js";
import type { EncryptionCipher } from "./cipher.js";

// Unknown credential kinds are preserved verbatim by older stores. They are never listed,
// resolved, exported to an agent, or treated as ordinary credentials.
const TYPE = "remote-link-retirement";
interface Entry {
  type: typeof TYPE;
  version: 1;
  id: string;
  secret: string;
  attempts: number;
  nextAttemptAt: number;
  leaseId?: string;
  leaseUntil?: number;
}
export interface RemoteLinkRetirementClaim {
  id: string;
  leaseId: string;
  credential: Credential;
}
function entry(value: unknown): value is Entry {
  const v = value as Entry | undefined;
  return (
    !!v &&
    v.type === TYPE &&
    v.version === 1 &&
    typeof v.id === "string" &&
    /^[a-f0-9]{64}$/.test(v.id) &&
    typeof v.secret === "string" &&
    Number.isSafeInteger(v.attempts) &&
    v.attempts >= 0 &&
    Number.isFinite(v.nextAttemptAt) &&
    (v.leaseUntil === undefined || Number.isFinite(v.leaseUntil))
  );
}
function remote(value: Credential): boolean {
  return (
    value?.type === "oauth" &&
    value.meta?.linkExecutionBackend === "remote" &&
    value.meta.linkExecutionRuntime === "server" &&
    typeof value.secret === "string" &&
    !!value.secret &&
    !!value.meta.linkRemoteIssuer
  );
}
export function retirementId(credential: Credential): string {
  if (!remote(credential)) throw new Error("invalid remote Link retirement");
  return createHash("sha256")
    .update(credential.meta!.linkRemoteIssuer!)
    .update("\0")
    .update(credential.secret!)
    .digest("hex");
}
export function stageRetirement(
  records: unknown[],
  credential: Credential,
  cipher: EncryptionCipher,
  nextAttemptAt: number,
): string {
  const id = retirementId(credential);
  if (!Number.isFinite(nextAttemptAt)) throw new Error("invalid retirement deadline");
  if (!records.some((v) => entry(v) && v.id === id))
    records.push({
      type: TYPE,
      version: 1,
      id,
      secret: cipher.encrypt(JSON.stringify(credential)),
      attempts: 0,
      nextAttemptAt,
    });
  return id;
}
export function removeRetirement(records: unknown[], id: string): void {
  const index = records.findIndex((v) => entry(v) && v.id === id);
  if (index >= 0) records.splice(index, 1);
}
export function adoptRetirement(records: unknown[], id: string): void {
  const value = records.find((v) => entry(v) && v.id === id) as Entry | undefined;
  if (!value || value.leaseId) throw new Error("remote Link cleanup custody changed");
  removeRetirement(records, id);
}
export function readyRetirement(records: unknown[], id: string, now: number): boolean {
  const value = records.find((v) => entry(v) && v.id === id) as Entry | undefined;
  if (!value) return false;
  value.nextAttemptAt = now;
  return true;
}
export function claimRetirement(
  records: unknown[],
  active: Credential[],
  cipher: EncryptionCipher,
  now: number,
): RemoteLinkRetirementClaim | undefined {
  for (const value of records) {
    if (!entry(value) || value.nextAttemptAt > now || (value.leaseUntil ?? 0) > now) continue;
    let credential: Credential;
    try {
      if (cipher.canDecrypt && !cipher.canDecrypt(value.secret)) continue;
      credential = JSON.parse(cipher.decrypt(value.secret));
      if (!remote(credential) || retirementId(credential) !== value.id) continue;
    } catch {
      continue;
    }
    // This also protects a recovered or manually restored active grant after token rotation.
    if (
      active.some(
        (c) =>
          remote(c) &&
          c.meta?.linkRemoteIssuer === credential.meta?.linkRemoteIssuer &&
          (c.secret === credential.secret ||
            (!!credential.meta?.linkRemoteGrantId &&
              c.meta?.linkRemoteGrantId === credential.meta.linkRemoteGrantId)),
      )
    )
      continue;
    value.leaseId = randomUUID();
    value.leaseUntil = now + 60_000;
    return { id: value.id, leaseId: value.leaseId, credential };
  }
}
export function finishRetirement(
  records: unknown[],
  claim: Pick<RemoteLinkRetirementClaim, "id" | "leaseId">,
  success: boolean,
  now: number,
): boolean {
  const value = records.find((v) => entry(v) && v.id === claim.id) as Entry | undefined;
  if (!value || value.leaseId !== claim.leaseId) return false;
  if (success) removeRetirement(records, claim.id);
  else {
    value.attempts = Math.min(16, value.attempts + 1);
    value.nextAttemptAt = now + Math.min(3_600_000, 30_000 * 2 ** (value.attempts - 1));
    delete value.leaseId;
    delete value.leaseUntil;
  }
  return true;
}
export function retirementCount(records: unknown[]): number {
  return records.filter((v) => (v as Entry | undefined)?.type === TYPE).length;
}

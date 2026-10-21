import type { TrustLevel } from "./trust-store.js";

/** Persist the choice, and fail closed on execution even if revocation cannot be saved. */
export async function setProjectTrustWithRevocation(
  cwd: string,
  level: TrustLevel,
  deps: {
    setTrust(cwd: string, level: TrustLevel): Promise<void>;
    revokeExternalRuntimeTrust(cwd: string): Promise<void>;
  },
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await deps.setTrust(cwd, level);
  } catch (error) {
    failures.push(error);
  }
  if (level === "untrusted") {
    try {
      await deps.revokeExternalRuntimeTrust(cwd);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Project trust revocation failed");
}

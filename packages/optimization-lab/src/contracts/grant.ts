import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { HashSchema } from "./experiment.js";

export const BudgetGrantSchema = z
  .object({
    schemaVersion: z.literal(1),
    planHash: HashSchema,
    revision: z.number().int().positive().safe(),
    confirmedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    startOperationId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    maxRequests: z.number().int().positive().safe(),
    maxExecutionMs: z.number().int().positive().safe(),
    maxEstimatedTokens: z.number().finite().positive().nullable(),
    maxEstimatedCostUsd: z.number().finite().positive().nullable(),
    enforcementMode: z.literal("reserved_estimate"),
    revokedAt: z.string().datetime().nullable(),
    revocationReason: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type BudgetGrant = z.infer<typeof BudgetGrantSchema>;

/** Structural verification also works after expiry, so old grants remain auditable. */
export function verifyBudgetGrant(raw: unknown, planHash?: string): BudgetGrant {
  canonicalJson(raw);
  const grant = BudgetGrantSchema.parse(raw);
  if (planHash !== undefined && grant.planHash !== planHash)
    throw new Error("optimization_lab: grant plan mismatch");
  if (Date.parse(grant.expiresAt) <= Date.parse(grant.confirmedAt))
    throw new Error("optimization_lab: expiry must follow confirmation");
  if ((grant.revokedAt === null) !== (grant.revocationReason === null))
    throw new Error("optimization_lab: incomplete revocation");
  return grant;
}

export function assertGrantActive(grant: BudgetGrant, planHash: string, now = Date.now()): void {
  verifyBudgetGrant(grant, planHash);
  if (grant.revokedAt !== null) throw new Error("optimization_lab: grant revoked");
  if (now < Date.parse(grant.confirmedAt))
    throw new Error("optimization_lab: grant is not yet valid");
  if (now >= Date.parse(grant.expiresAt)) throw new Error("optimization_lab: grant expired");
}

export function createBudgetGrant(raw: unknown, planHash: string, now = Date.now()): BudgetGrant {
  const grant = verifyBudgetGrant(raw, planHash);
  assertGrantActive(grant, planHash, now);
  return grant;
}

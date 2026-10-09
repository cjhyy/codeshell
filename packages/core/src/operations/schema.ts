import { z } from "zod";

export const operationStates = [
  "planned",
  "running",
  "succeeded",
  "verified",
  "failed",
  "unknown",
  "blocked",
] as const;
export type OperationState = (typeof operationStates)[number];
export const operationErrors = [
  "transient",
  "stale_reference",
  "validation",
  "authentication",
  "permission",
  "unsupported",
  "postcondition_failed",
  "poll_pending",
  "cancelled",
] as const;
export type OperationError = (typeof operationErrors)[number];

export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const label = z.string().regex(/^[a-z0-9_.-]{1,100}$/);
export const reference = z.object({ id: z.string().regex(/^[a-zA-Z0-9_/-]{1,300}$/) }).strict();
export const recordSchema = z
  .object({
    id: digest,
    owner: digest,
    fingerprint: digest,
    service: label,
    action: label,
    channel: label,
    state: z.enum(operationStates),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    attemptId: z.string().uuid().optional(),
    reference: reference.optional(),
    error: z.enum(operationErrors).optional(),
    verifiedAt: z.number().int().nonnegative().optional(),
    recovery: z.object({ prepared: digest, identity: digest.optional() }).strict().optional(),
    ownerIncarnation: digest.optional(),
    operatorResolution: z
      .object({
        id: z.string().uuid(),
        decision: z.literal("accept_uncertainty"),
        at: z.number().int().nonnegative(),
        reviewedRevision: digest,
      })
      .strict()
      .optional(),
  })
  .strict();
export type OperationReceipt = z.infer<typeof recordSchema>;
export type OperationReference = z.infer<typeof reference>;
export const observationSchema = z
  .object({
    id: z.string().uuid(),
    at: z.number().int().nonnegative(),
    reviewedRevision: digest,
    ownerIncarnation: digest,
    result: z.enum([
      "matches_current",
      "differs_current",
      "identity_changed",
      "unavailable",
      "permission_denied",
      "hooks_unavailable",
    ]),
    actions: z.array(label).max(2),
    evidence: digest,
  })
  .strict();
export type OperationObservation = z.infer<typeof observationSchema>;
export interface OperationReview {
  id: string;
  revision: string;
  service: string;
  action: string;
  state: OperationState;
  createdAt: number;
  hasReference: boolean;
  canResolve: boolean;
  resolvedAt?: number;
  observation?: Pick<OperationObservation, "id" | "at" | "result" | "actions">;
}
export const legacyStateSchema = z
  .object({
    schema: z.literal(1),
    key: z.string().min(1).max(4096),
    records: z.record(z.string(), recordSchema),
    observations: z.record(z.string(), z.array(observationSchema).max(20)).optional(),
  })
  .strict();

import type { ExtensionQueryHandler } from "@cjhyy/code-shell-core/extension";
import { z } from "zod";
import { freezeDataset, validateDataset } from "./contracts/dataset.js";
import { labRoot, projectKey } from "./store-paths.js";
import {
  OptimizationLabController,
  PrepareSchema,
  PrepareTrialSchema,
  type ControllerOptions,
} from "./controller.js";
import { importEvidenceBundle } from "./evidence.js";

const cwd = z.string({ required_error: "cwd is required" }).min(1);
const identity = z.object({ cwd, id: z.string().min(1) }).strict();
const operation = identity.extend({
  expectedRevision: z.number().int().positive().safe(),
  operationId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
});
const control = identity.extend({
  expectedRevision: z.number().int().positive().safe(),
  operationId: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
    .optional(),
});
const grant = operation.extend({
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime(),
  limits: z
    .object({
      maxRequests: z.number().int().positive().safe(),
      maxExecutionMs: z.number().int().positive().safe(),
      maxEstimatedTokens: z.number().finite().positive().nullable().optional(),
      maxEstimatedCostUsd: z.number().finite().positive().nullable().optional(),
    })
    .strict(),
});

/** All methods are trusted-host queries. None are model tools or authorization prompts. */
export function createOptimizationLabQueries(
  options: ControllerOptions = {},
): Readonly<Record<string, ExtensionQueryHandler>> {
  const controllers = new Map<string, OptimizationLabController>();
  const controller = (path: string) => {
    const key = projectKey(path);
    let instance = controllers.get(key);
    if (!instance) {
      instance = new OptimizationLabController(path, options);
      controllers.set(key, instance);
    }
    return instance;
  };
  const handler =
    <T>(schema: z.ZodType<T>, fn: (params: T) => unknown): ExtensionQueryHandler =>
    (params) => {
      const { type: _type, ...payload } = params;
      return fn(schema.parse(payload));
    };
  return {
    optimization_lab_import_evidence: handler(
      z.object({ cwd, bundle: z.unknown() }).strict(),
      (p) => importEvidenceBundle(options.root ?? labRoot(p.cwd), projectKey(p.cwd), p.bundle),
    ),
    optimization_lab_validate_dataset: handler(
      z.object({ dataset: z.unknown(), cwd: cwd.optional() }).strict(),
      (p) => validateDataset(p.dataset),
    ),
    optimization_lab_freeze_dataset: handler(
      z.object({ cwd, dataset: z.unknown() }).strict(),
      (p) => freezeDataset(p.dataset, labRoot(p.cwd)),
    ),
    optimization_lab_discover: handler(z.object({ cwd }).strict(), (p) =>
      controller(p.cwd).discover(),
    ),
    optimization_lab_list: handler(z.object({ cwd }).strict(), (p) => controller(p.cwd).list()),
    optimization_lab_prepare: handler(PrepareSchema, (p) => controller(p.cwd).prepare(p)),
    optimization_lab_prepare_trial: handler(PrepareTrialSchema, (p) =>
      controller(p.cwd).prepareTrial(p),
    ),
    optimization_lab_get: handler(identity, (p) => controller(p.cwd).get(p.id)),
    optimization_lab_status: handler(identity, (p) => controller(p.cwd).get(p.id)),
    optimization_lab_grant: handler(grant, (p) => controller(p.cwd).grant(p.id, p)),
    optimization_lab_start: handler(operation, (p) =>
      controller(p.cwd).start(p.id, p.expectedRevision, p.operationId),
    ),
    optimization_lab_continue: handler(operation, (p) =>
      controller(p.cwd).start(p.id, p.expectedRevision, p.operationId, true),
    ),
    optimization_lab_stop: handler(control, (p) =>
      controller(p.cwd).stop(p.id, p.expectedRevision),
    ),
    optimization_lab_revoke: handler(control, (p) =>
      controller(p.cwd).revoke(p.id, p.expectedRevision),
    ),
    optimization_lab_export_grading: handler(identity, (p) =>
      controller(p.cwd).exportGrading(p.id),
    ),
    optimization_lab_import_grading: handler(
      identity.extend({
        expectedRevision: z.number().int().positive().safe(),
        grading: z.unknown(),
      }),
      (p) => controller(p.cwd).importGrading(p.id, p.grading, p.expectedRevision),
    ),
    optimization_lab_report: handler(identity, (p) => controller(p.cwd).report(p.id)),
  };
}

export const OPTIMIZATION_LAB_QUERIES = createOptimizationLabQueries();

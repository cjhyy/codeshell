import type { RendererConfigurationTarget } from "./renderer-configuration";
import type { EvidenceBundle, EvalCase } from "@cjhyy/code-shell-capability-optimization-lab";

export const LAB_QUERY_TYPES = [
  "discover",
  "bindings",
  "revoke_binding",
  "list",
  "validate_dataset",
  "freeze_dataset",
  "prepare",
  "prepare_trial",
  "get",
  "status",
  "start",
  "stop",
  "continue",
  "revoke",
  "export_grading",
  "import_grading",
  "report",
] as const;
export type LabQueryType = (typeof LAB_QUERY_TYPES)[number];
export type LabTarget = Extract<RendererConfigurationTarget, { projectId: string }>;
export interface LabQueryInput {
  target: LabTarget;
  [key: string]: unknown;
}
export interface LabAuthorizationInput extends LabQueryInput {
  id: string;
  expectedRevision: number;
  planHash: string;
  operationId: string;
  expiresAt: string;
  limits: {
    maxRequests: number;
    maxExecutionMs: number;
    maxEstimatedTokens?: number | null;
    maxEstimatedCostUsd?: number | null;
  };
}
export interface OptimizationLabApi {
  adopt(
    input: LabQueryInput & {
      id: string;
      reportHash: string;
      scope: { kind: "project" } | { kind: "session"; sessionId: string };
    },
  ): Promise<unknown | null>;
  previewEvidence(input: {
    target: LabTarget;
    runIds: string[];
  }): Promise<{ previewId: string; bundle: EvidenceBundle }>;
  importEvidence(input: {
    target: LabTarget;
    previewId: string;
    bundleHash: string;
  }): Promise<{ bundle: EvidenceBundle; cases: EvalCase[] } | null>;
  query<T = unknown>(type: LabQueryType, input: LabQueryInput): Promise<T>;
  authorize(input: LabAuthorizationInput): Promise<unknown | null>;
  exportFile(
    input: LabQueryInput & { id: string; kind: "grading" | "report-json" | "report-markdown" },
  ): Promise<boolean>;
  importGrading(
    input: LabQueryInput & { id: string; expectedRevision: number },
  ): Promise<unknown | null>;
  /** Import editable UTF-8 text; this does not validate, freeze or execute a dataset. */
  importDataset(input: { target: LabTarget }): Promise<string | null>;
  /** Save editable text through a native dialog without modifying frozen artifacts. */
  exportDataset(input: { target: LabTarget; text: string }): Promise<boolean>;
}

/** Generic RPC callers cannot grant themselves the dedicated Main capability. */
export function isOptimizationLabQuery(message: { method?: unknown; params?: unknown }): boolean {
  if (message.method !== "agent/query" || !message.params || typeof message.params !== "object")
    return false;
  const type = (message.params as Record<string, unknown>).type;
  return typeof type === "string" && type.startsWith("optimization_lab_");
}

/** agent/query uses a typed data envelope, unlike ordinary protocol methods. */
export function unwrapOptimizationLabReply(type: string, reply: unknown): unknown {
  if (!reply || typeof reply !== "object" || Array.isArray(reply))
    throw new Error("Invalid Optimization Lab worker reply");
  const envelope = reply as Record<string, unknown>;
  if (envelope.type !== type || !Object.prototype.hasOwnProperty.call(envelope, "data"))
    throw new Error("Mismatched Optimization Lab worker reply");
  return envelope.data;
}

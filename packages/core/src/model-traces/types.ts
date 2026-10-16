import type { TokenUsage } from "../types.js";
import type { UsageReceipt } from "../cost-ledger/types.js";

export type ModelTraceContentState = "recorded" | "not-recorded" | "truncated" | "redacted";
export type ModelTraceStatus = "running" | "completed" | "failed" | "cancelled";
export type ModelTraceCallType =
  | "execution"
  | "task"
  | "panel"
  | "summary"
  | "context"
  | "title"
  | "goal"
  | "memory"
  | "suggestion"
  | "speech"
  | "transcription"
  | "audio"
  | "external"
  | "other";

export interface ModelTraceConfig {
  /** Host-owned generation; changed policy never resumes capture for an existing call. */
  readonly policyRevision: string;
  enabled: boolean;
  captureContent: boolean;
  retentionDays: number;
  includeEphemeral: boolean;
}
export type ModelTraceConfigPatch = Partial<Omit<ModelTraceConfig, "policyRevision">>;

export interface ModelTraceOutput {
  text?: string;
  thinking?: string;
  toolCalls?: unknown[];
  stopReason?: string;
  /** Structured responses or media result metadata; binary payloads are omitted. */
  data?: unknown;
}
export interface ModelTraceAttempt {
  id: string;
  number: number;
  startedAt: number;
  endedAt?: number;
  firstTokenAt?: number;
  status: ModelTraceStatus;
  httpStatus?: number;
  coverage: "provider-wire" | "logical-input" | "external-cli-input";
  inputState: ModelTraceContentState;
  input?: unknown;
  outputState: ModelTraceContentState;
  output?: ModelTraceOutput;
  error?: string;
  usage?: TokenUsage;
  estimatedCostUsd?: number | null;
  pricing?: UsageReceipt["pricing"];
}
export interface ModelTraceRecord {
  version: 1;
  id: string;
  traceId: string;
  sessionId?: string;
  runId?: string;
  parentSessionId?: string;
  workspacePath?: string;
  source: string;
  purpose: string;
  /** Host-derived presentation category. Raw purpose remains available unchanged. */
  callType?: ModelTraceCallType;
  provider: string;
  providerKind?: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  status: ModelTraceStatus;
  stream: boolean;
  inputState: ModelTraceContentState;
  input?: {
    systemPrompt: string;
    messages: unknown[];
    tools: unknown[];
    parameters: Record<string, unknown>;
  };
  outputState: ModelTraceContentState;
  output?: ModelTraceOutput;
  error?: string;
  usage?: TokenUsage;
  /** Known local estimate only; consult unknownCostAttempts for incomplete pricing. */
  estimatedCostUsd?: number | null;
  pricing?: UsageReceipt["pricing"];
  unknownCostAttempts?: number;
  attempts: ModelTraceAttempt[];
}
export interface ModelTraceSummary extends Omit<ModelTraceRecord, "input" | "output" | "attempts"> {
  attemptCount: number;
}
export interface ModelTraceListQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  traceId?: string;
  sessionId?: string;
  /** Restrict to calls with no actual session identity, including when trace IDs coincide. */
  withoutSession?: boolean;
  workspacePath?: string;
  /** Host-only read scopes; transport query validators must reject this field. */
  workspaceScopes?: ReadonlyArray<{ workspacePath: string; sourcePrefix?: string }>;
  model?: string;
  provider?: string;
  purpose?: string;
  callType?: ModelTraceCallType;
  source?: string;
  status?: ModelTraceStatus;
  since?: number;
  until?: number;
}
export interface ModelTracePage {
  items: ModelTraceSummary[];
  nextCursor?: string;
  total: number;
}
/** One real session, or one independently attributed trace when no session exists. */
export interface ModelTraceSessionSummary {
  key: string;
  sessionId?: string;
  /** Present only for calls that have no session identity. */
  traceId?: string;
  latestRequestId: string;
  latestTraceId: string;
  startedAt: number;
  updatedAt: number;
  callCount: number;
  traceCount: number;
  sources: string[];
  models: string[];
  /** Categories of the matching calls, after all query filters and before paging. */
  callTypes?: ModelTraceCallType[];
  runningCount: number;
  failedCount: number;
}
export interface ModelTraceSessionPage {
  items: ModelTraceSessionSummary[];
  nextCursor?: string;
  total: number;
}
export interface ModelTraceEvent {
  id: string;
  traceId: string;
  sessionId?: string;
  runId?: string;
  workspacePath?: string;
  kind: "tool" | "approval" | "lifecycle";
  name: string;
  startedAt: number;
  endedAt?: number;
  status: string;
  inputState: ModelTraceContentState;
  input?: unknown;
  outputState: ModelTraceContentState;
  output?: unknown;
  error?: string;
  parentId?: string;
}
export type ModelTraceEventInput = Omit<
  ModelTraceEvent,
  "id" | "traceId" | "inputState" | "outputState"
> & {
  id?: string;
  traceId?: string;
  inputState?: ModelTraceContentState;
  outputState?: ModelTraceContentState;
  /** Internal span-start marker; continuations cannot recreate an evicted capture policy. */
  first?: boolean;
};

/** Trusted Host/Engine context; never inferred from the operator's process cwd. */
export interface ModelTraceContext {
  storageDir?: string;
  workspacePath?: string;
  ephemeral?: boolean;
  /** Explicit attribution fields override UsageOwner; explicit undefined clears inheritance. */
  sessionId?: string;
  runId?: string;
  parentSessionId?: string;
  source?: string;
  purpose?: string;
}

/** External CLIs expose submitted inputs and events, never their private provider wire. */
export interface ExternalModelTraceInput extends ModelTraceContext {
  id?: string;
  traceId?: string;
  provider: string;
  model: string;
  source: string;
  startedAt: number;
  endedAt?: number;
  status: ModelTraceStatus;
  stream?: boolean;
  input?: Partial<NonNullable<ModelTraceRecord["input"]>>;
  output?: ModelTraceOutput;
  error?: string;
  usage?: TokenUsage;
  /** Host-selected observable boundary; external CLIs retain their narrower default. */
  coverage?: "logical-input" | "external-cli-input";
  inputState?: ModelTraceContentState;
  outputState?: ModelTraceContentState;
}

/** Capability observer: execution attribution and storage are inherited from Core. */
export type ExternalModelCallInput = Omit<ExternalModelTraceInput, keyof ModelTraceContext> & {
  source: string;
  purpose?: string;
};

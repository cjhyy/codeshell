import type { TokenUsage } from "../types.js";
import type { UsageReceipt } from "../cost-ledger/types.js";

export type ModelTraceContentState = "recorded" | "not-recorded" | "truncated" | "redacted";
export type ModelTraceStatus = "running" | "completed" | "failed" | "cancelled";

export interface ModelTraceConfig {
  enabled: boolean;
  captureContent: boolean;
  retentionDays: number;
  includeEphemeral: boolean;
}
export type ModelTraceConfigPatch = Partial<ModelTraceConfig>;

export interface ModelTraceOutput {
  text?: string;
  thinking?: string;
  toolCalls?: unknown[];
  stopReason?: string;
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
  workspacePath?: string;
  model?: string;
  provider?: string;
  purpose?: string;
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
}

/** Capability observer: execution attribution and storage are inherited from Core. */
export type ExternalModelCallInput = Omit<ExternalModelTraceInput, keyof ModelTraceContext> & {
  source: string;
  purpose?: string;
};

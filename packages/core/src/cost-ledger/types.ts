import type { TokenUsage } from "../types.js";

export type UsagePurpose =
  | "main"
  | "aux_summary"
  | "tool_summary"
  | "goal_judge"
  | "title"
  | "context_package"
  | "manual_compact"
  | "subagent"
  | "external";

export interface UsageIdentity {
  provider: string;
  model: string;
  providerKind?: string;
}

export interface UsageReceipt extends UsageIdentity {
  version: 1;
  requestId: string;
  namespace: string;
  runtimeId: string;
  sessionId: string;
  accountingSessionId: string;
  runId?: string;
  ancestors: string[];
  ancestorAccountingIds: string[];
  purpose: UsagePurpose;
  source: "provider" | string;
  startedAt: number;
  settledAt?: number;
  outcome: "pending" | "completed" | "failed";
  /** A preflight rejection proves no handoff to fetch; legacy receipts leave this absent. */
  transmission?: "not-sent";
  usage: TokenUsage | null;
  estimatedCostUsd: number | null;
  pricing: {
    source: "model-metadata" | "openrouter-snapshot";
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cachePricesEstimated: true;
  } | null;
}

export interface UsageTotals {
  notSentRequests?: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  knownEstimatedCostUsd: number;
  unknownCostRequests: number;
  unknownUsageRequests: number;
}

export interface UsageSummary extends UsageTotals {
  version: 1;
  scope: "runtime" | "session" | "store";
  sessionId?: string;
  includesChildren: boolean;
  partial: boolean;
  persistenceErrors: number;
  invalidReceipts: number;
  scannedReceipts: number;
  nextCursor?: string;
  byModel: Array<UsageTotals & UsageIdentity>;
  bySession: Array<UsageTotals & { sessionId: string; accountingSessionId: string }>;
  byPurpose: Array<UsageTotals & { purpose: UsagePurpose }>;
}

export interface UsageQuery {
  runId?: string;
  scope?: "runtime" | "session" | "store";
  sessionId?: string;
  includeChildren?: boolean;
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string;
}

export interface ExternalBilledUsage extends UsageIdentity {
  source: string;
  requestId: string;
  usage?: TokenUsage;
}

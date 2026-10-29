/** Explicit acceptance of a known historical display gap; never a claim of complete old output. */
export type OutputHistoryRecoveryReason =
  | "not_needed"
  | "busy"
  | "unavailable"
  | "unsupported_history"
  | "history_mismatch"
  | "stale"
  | "confirmation_required"
  | "storage_error";

export interface OutputHistoryComparison {
  turns: number;
  userInputs: number;
  toolCalls: number;
  toolResults: number;
}

export type OutputHistoryRecoveryPlan =
  | {
      status: "ready";
      sessionId: string;
      planId: string;
      historicalGap: true;
      notice: "historical_notifications_incomplete";
      comparison: OutputHistoryComparison;
    }
  | { status: "blocked"; sessionId: string; reason: OutputHistoryRecoveryReason };

export interface OutputHistoryRecoveryAcceptance {
  planId: string;
  acceptHistoricalGap: true;
}

export type OutputHistoryRecoveryResult =
  | { status: "applied"; sessionId: string; historicalGap: true }
  | {
      status: "stale" | "blocked";
      sessionId: string;
      reason: OutputHistoryRecoveryReason;
    };

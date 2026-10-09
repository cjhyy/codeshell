/** Masked native activity review. No provider target, body, account, or secret crosses preload. */
export interface OperationResolutionRecord {
  id: string;
  revision: string;
  service: string;
  action: string;
  state: string;
  createdAt: number;
  hasReference: boolean;
  canResolve: boolean;
  resolvedAt?: number;
  observation?: OperationReadObservation;
}

export interface OperationReadObservation {
  id: string;
  at: number;
  result:
    | "matches_current"
    | "differs_current"
    | "identity_changed"
    | "unavailable"
    | "permission_denied"
    | "hooks_unavailable";
  actions: string[];
}

export interface OperationResolutionReview {
  reviewToken: string;
  records: OperationResolutionRecord[];
  truncated: boolean;
}

export interface OperationResolutionInput {
  reviewToken: string;
  operationId: string;
  revision: string;
}

export type OperationResolutionResult = { status: "cancelled" | "resolved"; result: "unknown" };
export type OperationReadResult =
  | { status: "cancelled" }
  | { status: "observed"; observation: OperationReadObservation };

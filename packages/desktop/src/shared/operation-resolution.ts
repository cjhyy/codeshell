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

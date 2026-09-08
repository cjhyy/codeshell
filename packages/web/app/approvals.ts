import type { ApprovalRequestPayload } from "./protocol.js";

export interface ApprovalLease {
  requestId: string;
  holderId: string | null;
  expiresAt: number | null;
}
export type ApprovalState = Record<
  string,
  { payload: ApprovalRequestPayload; lease?: ApprovalLease }
>;

/** Keep all sessions' pending cards until the server acknowledges resolution. */
export function reduceApprovals(
  state: ApprovalState,
  action: { method: string; params: Record<string, unknown> },
): ApprovalState {
  const { method, params } = action;
  if (method === "serve/approvalSnapshot") {
    if (!Array.isArray(params.approvals)) return state;
    const next: ApprovalState = {};
    for (const payload of params.approvals as ApprovalRequestPayload[]) {
      if (payload?.requestId && payload.request) next[payload.requestId] = { payload };
    }
    return next;
  }
  if (method === "agent/approvalRequest") {
    const payload = params as unknown as ApprovalRequestPayload;
    if (!payload.requestId || !payload.request) return state;
    return { ...state, [payload.requestId]: { ...state[payload.requestId], payload } };
  }
  const requestId = params.requestId;
  if (typeof requestId !== "string" || !state[requestId]) return state;
  if (method === "agent/approvalResolved") {
    const next = { ...state };
    delete next[requestId];
    return next;
  }
  if (method === "serve/approvalLease") {
    return {
      ...state,
      [requestId]: { ...state[requestId], lease: params as unknown as ApprovalLease },
    };
  }
  return state;
}

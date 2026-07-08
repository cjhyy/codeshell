export function rawApprovalResolvedRequestId(raw: unknown): string | null {
  const obj = raw as Record<string, unknown> | null;
  if (!obj || obj.method !== "agent/approvalResolved") return null;
  const params = obj.params as Record<string, unknown> | null;
  const requestId = params?.requestId;
  return typeof requestId === "string" && requestId ? requestId : null;
}

export function removeResolvedApproval<T extends { requestId: string }>(
  approvals: T[],
  requestId: string,
): T[] {
  return approvals.filter((approval) => approval.requestId !== requestId);
}

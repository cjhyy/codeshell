import type { ApprovalRequestEnvelope } from "../../preload/types";

/** Request IDs can be reused by separate worker sessions. */
export function approvalKey(envelope: ApprovalRequestEnvelope): string {
  return JSON.stringify([envelope.sessionId ?? null, envelope.requestId]);
}

export function approvalSummary(envelope: ApprovalRequestEnvelope): string {
  const args = (envelope.request.args ?? {}) as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "url", "pattern", "query"] as const) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  return envelope.request.description || envelope.request.toolName;
}

export function approvalMatches(
  envelope: ApprovalRequestEnvelope,
  query: string,
  reason?: string,
): boolean {
  if (!query) return true;
  const values = [
    envelope.requestId,
    envelope.sessionId,
    envelope.request.toolName,
    envelope.request.description,
    JSON.stringify(envelope.request.args ?? {}),
    reason,
  ];
  return values.some((value) => value?.toLocaleLowerCase().includes(query));
}

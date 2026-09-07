import { useEffect, useState } from "react";
import type { ApprovalHistoryEntry } from "../app/appUtils";

export const APPROVAL_HISTORY_STORAGE_KEY = "codeshell.approvalHistory.v1";
export const APPROVAL_HISTORY_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isApprovalHistoryEntry(value: unknown): value is ApprovalHistoryEntry {
  if (!isRecord(value)) return false;
  if (value.decision !== "approve" && value.decision !== "deny") return false;
  if (typeof value.at !== "number" || !Number.isFinite(new Date(value.at).getTime())) return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  const envelope = value.envelope;
  if (!isRecord(envelope) || typeof envelope.requestId !== "string" || !envelope.requestId) {
    return false;
  }
  if (envelope.sessionId !== undefined && typeof envelope.sessionId !== "string") return false;
  const request = envelope.request;
  if (!isRecord(request) || typeof request.toolName !== "string" || !request.toolName) return false;
  // Older workers may omit description/riskLevel. History only renders toolName
  // and args (with an empty-object fallback); it never replays this as a request.
  return request.args === undefined || request.args === null || isRecord(request.args);
}

export function loadApprovalHistory(): ApprovalHistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(APPROVAL_HISTORY_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isApprovalHistoryEntry).slice(-APPROVAL_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function saveApprovalHistory(history: ApprovalHistoryEntry[]): void {
  try {
    localStorage.setItem(
      APPROVAL_HISTORY_STORAGE_KEY,
      JSON.stringify(history.slice(-APPROVAL_HISTORY_LIMIT)),
    );
  } catch {
    // Storage can be unavailable or full; an audit display must never block a decision.
  }
}

/** Read-only decision history, deliberately separate from the live queue and permission grants. */
export function useApprovalHistory() {
  const [history, setHistory] = useState<ApprovalHistoryEntry[]>(loadApprovalHistory);
  useEffect(() => saveApprovalHistory(history), [history]);
  return [history, setHistory] as const;
}

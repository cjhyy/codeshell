import type { PendingApprovalMetadata } from "@cjhyy/code-shell-core/extension";
import {
  LOCAL_PET_OWNER,
  type PendingDecisionProjection,
  type PendingDecisionStatus,
} from "./types.js";

const MAX_TITLE_LENGTH = 80;

export function safePendingTitle(value: string): string {
  const redacted = value
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[redacted]")
    .replace(/(?:sk|api|token|secret)[-_][a-z0-9_-]{6,}/gi, "[redacted]");
  return redacted.replace(/\s+/g, " ").slice(0, MAX_TITLE_LENGTH) || "等待用户决定";
}

function safeToolName(value: string | undefined): string {
  if (!value) return "工具";
  if (/(?:sk|api|token|secret)[-_][a-z0-9_-]{6,}/i.test(value)) return "工具";
  return (
    value
      .replace(/[^\p{L}\p{N}_.:@/-]+/gu, " ")
      .trim()
      .slice(0, 40) || "工具"
  );
}

function projectedTitle(metadata: PendingApprovalMetadata): string {
  if (metadata.kind === "ask_user") return "需要用户回答";
  return `等待批准 ${safeToolName(metadata.toolName)}`;
}

function key(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

export interface PendingDecisionTransition {
  sessionId: string;
  requestId: string;
  routeGeneration?: number;
  status: Exclude<PendingDecisionStatus, "pending">;
  terminalAt: number;
}

/** Resolver-free, cross-session read model for user-visible decisions. */
export class PendingDecisionIndex {
  private readonly entries = new Map<string, PendingDecisionProjection>();

  created(metadata: PendingApprovalMetadata): boolean {
    if (!metadata.surfaceable || metadata.kind === "internal") return false;
    const entryKey = key(metadata.sessionId, metadata.requestId);
    const existing = this.entries.get(entryKey);
    if (existing?.status === "pending") return false;
    this.entries.set(entryKey, {
      owner: LOCAL_PET_OWNER,
      agentSessionId: metadata.sessionId,
      coreSessionId: metadata.sessionId,
      requestId: metadata.requestId,
      routeGeneration: metadata.routeGeneration,
      workerGeneration: metadata.workerGeneration,
      kind: metadata.kind,
      title: projectedTitle(metadata),
      toolName: metadata.toolName,
      riskLevel: metadata.riskLevel,
      createdAt: metadata.createdAt,
      expiresAt: metadata.expiresAt,
      status: "pending",
    });
    return true;
  }

  transition(transition: PendingDecisionTransition): boolean {
    const entryKey = key(transition.sessionId, transition.requestId);
    const existing = this.entries.get(entryKey);
    if (!existing || existing.status !== "pending") return false;
    if (
      transition.routeGeneration !== undefined &&
      existing.routeGeneration !== transition.routeGeneration
    ) {
      return false;
    }
    this.entries.set(entryKey, {
      ...existing,
      status: transition.status,
      terminalAt: transition.terminalAt,
    });
    return true;
  }

  reconcileGeneration(
    workerGeneration: number,
    current: readonly { sessionId: string; requestId: string }[],
    observedAt: number,
  ): void {
    const currentKeys = new Set(current.map((entry) => key(entry.sessionId, entry.requestId)));
    for (const [entryKey, entry] of this.entries) {
      if (entry.status !== "pending") continue;
      if (entry.workerGeneration === workerGeneration && currentKeys.has(entryKey)) continue;
      this.entries.set(entryKey, {
        ...entry,
        status: "cancelled",
        terminalAt: observedAt,
      });
    }
  }

  get(sessionId: string, requestId: string): PendingDecisionProjection | undefined {
    const entry = this.entries.get(key(sessionId, requestId));
    return entry ? structuredClone(entry) : undefined;
  }

  snapshot(): PendingDecisionProjection[] {
    return [...this.entries.values()]
      .map((entry) => structuredClone(entry))
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          a.agentSessionId.localeCompare(b.agentSessionId) ||
          a.requestId.localeCompare(b.requestId),
      );
  }

  pendingSnapshot(): PendingDecisionProjection[] {
    return this.snapshot().filter((entry) => entry.status === "pending");
  }
}

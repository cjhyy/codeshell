import type { PetProjectionSnapshot, PetSessionProjection } from "../../preload/types";

export const PET_WIDGET_RECEIPTS_KEY = "codeshell.pet.widget-work-receipts.v1";

export interface PetWidgetReceiptState {
  baselineAt: number;
  seenCompletionKeys: string[];
}

export interface PetWidgetActivityItem {
  key: string;
  agentSessionId: string;
  title: string;
  detail?: string;
  kind: "working" | "needs-action" | "completed";
  lastActivityAt: number;
  requestId?: string;
  routeGeneration?: number;
}

export interface PetWidgetActivity {
  items: PetWidgetActivityItem[];
  activeCount: number;
  runningCount: number;
  unreadCompletedCount: number;
  badgeCount: number;
}

function completionKey(session: PetSessionProjection): string | null {
  if (session.terminal?.status !== "completed") return null;
  return `completed:${session.agentSessionId}:${session.terminal.at}`;
}

export function parsePetWidgetReceiptState(raw: string | null): PetWidgetReceiptState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PetWidgetReceiptState>;
    if (!Number.isFinite(value.baselineAt) || !Array.isArray(value.seenCompletionKeys)) return null;
    return {
      baselineAt: value.baselineAt!,
      seenCompletionKeys: value.seenCompletionKeys.filter(
        (key): key is string => typeof key === "string" && key.length <= 512,
      ),
    };
  } catch {
    return null;
  }
}

export function initialPetWidgetReceiptState(
  snapshot: PetProjectionSnapshot,
): PetWidgetReceiptState {
  // Installing this UI must not turn the complete historical catalog into a
  // giant unread badge. The first snapshot is the baseline; subsequent
  // completions (including ones that happened while the widget was closed)
  // are unread until their row is clicked.
  return { baselineAt: snapshot.observedAt, seenCompletionKeys: [] };
}

export function markPetWidgetCompletionSeen(
  state: PetWidgetReceiptState,
  key: string,
): PetWidgetReceiptState {
  if (state.seenCompletionKeys.includes(key)) return state;
  return {
    ...state,
    seenCompletionKeys: [...state.seenCompletionKeys, key].slice(-2_000),
  };
}

export function buildPetWidgetActivity(
  snapshot: PetProjectionSnapshot | null,
  receipts: PetWidgetReceiptState | null,
): PetWidgetActivity {
  if (!snapshot || !receipts) {
    return { items: [], activeCount: 0, runningCount: 0, unreadCompletedCount: 0, badgeCount: 0 };
  }

  const pendingBySession = new Map(
    snapshot.pending
      .filter((pending) => pending.status === "pending")
      .map((pending) => [pending.agentSessionId, pending] as const),
  );
  const seen = new Set(receipts.seenCompletionKeys);
  const items: PetWidgetActivityItem[] = [];
  const represented = new Set<string>();
  let runningCount = 0;

  for (const session of snapshot.sessions) {
    const pending = pendingBySession.get(session.agentSessionId);
    if (pending) {
      represented.add(session.agentSessionId);
      items.push({
        key: `pending:${session.agentSessionId}:${pending.requestId}`,
        agentSessionId: session.agentSessionId,
        title: session.title ?? session.workspaceDisplayName ?? session.agentSessionId.slice(-8),
        detail: pending.title,
        kind: "needs-action",
        lastActivityAt: Math.max(session.lastActivityAt, pending.createdAt),
        requestId: pending.requestId,
        routeGeneration: pending.routeGeneration,
      });
      continue;
    }
    if (session.runState === "running" || session.runState === "queued") {
      represented.add(session.agentSessionId);
      runningCount += 1;
      items.push({
        key: `working:${session.agentSessionId}`,
        agentSessionId: session.agentSessionId,
        title: session.title ?? session.workspaceDisplayName ?? session.agentSessionId.slice(-8),
        detail: session.summary,
        kind: "working",
        lastActivityAt: session.lastActivityAt,
      });
      continue;
    }
    const key = completionKey(session);
    if (key && session.terminal!.at > receipts.baselineAt && !seen.has(key)) {
      items.push({
        key,
        agentSessionId: session.agentSessionId,
        title: session.title ?? session.workspaceDisplayName ?? session.agentSessionId.slice(-8),
        detail: session.summary,
        kind: "completed",
        lastActivityAt: session.terminal!.at,
      });
    }
  }

  for (const pending of snapshot.pending) {
    if (pending.status !== "pending" || represented.has(pending.agentSessionId)) continue;
    represented.add(pending.agentSessionId);
    items.push({
      key: `pending:${pending.agentSessionId}:${pending.requestId}`,
      agentSessionId: pending.agentSessionId,
      title: pending.title,
      detail: pending.kind === "ask_user" ? "需要回答" : pending.toolName,
      kind: "needs-action",
      lastActivityAt: pending.createdAt,
      requestId: pending.requestId,
      routeGeneration: pending.routeGeneration,
    });
  }

  items.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  const activeCount = items.filter((item) => item.kind !== "completed").length;
  const unreadCompletedCount = items.length - activeCount;
  return {
    items,
    activeCount,
    runningCount,
    unreadCompletedCount,
    badgeCount: activeCount + unreadCompletedCount,
  };
}

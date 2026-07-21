import type {
  PetLongTask,
  PetLongTaskSnapshot,
  PetProjectionSnapshot,
  PetSessionProjection,
} from "../../preload/types";

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
  longTasks: PetLongTaskSnapshot | null = null,
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
  const projectedSessionIds = new Set(snapshot.sessions.map((session) => session.agentSessionId));
  const latestLongTaskBySession = new Map<string, PetLongTask>();
  for (const task of longTasks?.tasks ?? []) {
    const previous = latestLongTaskBySession.get(task.sessionId);
    if (
      !previous ||
      task.updatedAt > previous.updatedAt ||
      (task.updatedAt === previous.updatedAt && task.revision > previous.revision)
    ) {
      latestLongTaskBySession.set(task.sessionId, task);
    }
  }
  let runningCount = 0;

  const appendLongTask = (task: PetLongTask, session?: PetSessionProjection): void => {
    const title =
      session?.title ?? session?.workspaceDisplayName ?? task.objective ?? task.sessionId.slice(-8);
    const detail = task.waitingFor ?? task.lastError ?? task.summary;
    switch (task.status) {
      case "queued":
      case "running":
        runningCount += 1;
        items.push({
          key: `long-task:${task.id}:${task.revision}`,
          agentSessionId: task.sessionId,
          title,
          detail,
          kind: "working",
          lastActivityAt: task.updatedAt,
        });
        return;
      case "waiting":
      case "paused":
      case "interrupted":
      case "failed":
        items.push({
          key: `long-task:${task.id}:${task.revision}`,
          agentSessionId: task.sessionId,
          title,
          detail,
          kind: "needs-action",
          lastActivityAt: task.updatedAt,
        });
        return;
      case "completed": {
        const completedAt = task.completedAt ?? task.updatedAt;
        const key = `completed-task:${task.id}:${completedAt}`;
        if (completedAt > receipts.baselineAt && !seen.has(key)) {
          items.push({
            key,
            agentSessionId: task.sessionId,
            title,
            detail,
            kind: "completed",
            lastActivityAt: completedAt,
          });
        }
        return;
      }
      case "cancelled":
        return;
    }
  };

  for (const session of snapshot.sessions) {
    const pending = pendingBySession.get(session.agentSessionId);
    const longTask = latestLongTaskBySession.get(session.agentSessionId);
    const terminalLongTask =
      longTask?.status === "completed" ||
      longTask?.status === "failed" ||
      longTask?.status === "cancelled";
    const staleBackgroundWait =
      session.completionKind === "background_wait" || session.summary === "等待后台结果";
    // The durable task journal is authoritative once it is at least as new as
    // both the Session projection and its pending-decision projection. This
    // prevents a missed/late Session delta from leaving a completed task stuck
    // on the widget as “执行中 / 等待后台结果”. A normal Session metadata
    // flush can land a few milliseconds after task closure, so that exact
    // background-wait state is also treated as stale even when its timestamp is
    // slightly newer.
    if (
      longTask &&
      (longTask.updatedAt >= Math.max(session.lastActivityAt, pending?.createdAt ?? 0) ||
        (terminalLongTask && staleBackgroundWait))
    ) {
      represented.add(session.agentSessionId);
      appendLongTask(longTask, session);
      continue;
    }
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

  // A durable long task can outlive catalog hydration or Session archival.
  // Keep it visible even when the current projection has no matching row.
  for (const task of latestLongTaskBySession.values()) {
    if (projectedSessionIds.has(task.sessionId)) continue;
    represented.add(task.sessionId);
    appendLongTask(task);
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

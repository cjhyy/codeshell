import type { PetPendingDecision, PetSessionProjection } from "../../preload/types";

export type PetWorkKind = "unfinished" | "optimization" | "completed" | "other";
export type PetWorkState =
  | "needs-action"
  | "running"
  | "queued"
  | "failed"
  | "cancelled"
  | "optimization"
  | "completed"
  | "idle"
  | "dormant"
  | "unknown";

export interface PetWorkItem {
  id: string;
  kind: PetWorkKind;
  state: PetWorkState;
  workspace?: string;
  title: string;
  detail?: string;
  lastActivityAt: number;
  navigation: {
    agentSessionId: string;
    requestId?: string;
    routeGeneration?: number;
  };
}

export interface PetWorkspaceWorkGroup {
  workspace?: string;
  unfinished: PetWorkItem[];
  optimization: PetWorkItem[];
  completed: PetWorkItem[];
  other: PetWorkItem[];
  latestActivityAt: number;
}

export interface PetWorkMap {
  groups: PetWorkspaceWorkGroup[];
  counts: Record<PetWorkKind, number>;
  itemIds: Record<PetWorkKind, string[]>;
  dismissedCount: number;
  hiddenCount: number;
}

const DISPLAY_LIMITS: Record<PetWorkKind, number> = {
  unfinished: 16,
  optimization: 10,
  completed: 8,
  other: 16,
};

function itemFromSession(
  session: PetSessionProjection,
  pending: PetPendingDecision | undefined,
): PetWorkItem {
  const base = {
    workspace: session.workspaceDisplayName,
    title: session.title ?? session.workspaceDisplayName ?? session.agentSessionId.slice(-8),
    lastActivityAt: pending
      ? Math.max(session.lastActivityAt, pending.createdAt)
      : session.lastActivityAt,
    navigation: {
      agentSessionId: session.agentSessionId,
      requestId: pending?.requestId,
      routeGeneration: pending?.routeGeneration,
    },
  };
  if (pending) {
    return {
      ...base,
      id: `pending:${session.agentSessionId}:${pending.requestId}`,
      kind: "unfinished",
      state: "needs-action",
      detail: pending.title,
    };
  }
  if (session.runState === "running") {
    return {
      ...base,
      id: `unfinished:${session.agentSessionId}`,
      kind: "unfinished",
      state: "running",
      detail: session.summary,
    };
  }
  if (session.runState === "queued") {
    return {
      ...base,
      id: `unfinished:${session.agentSessionId}`,
      kind: "unfinished",
      state: "queued",
      detail: session.summary,
    };
  }
  if (session.terminal?.status === "failed" || session.terminal?.status === "cancelled") {
    return {
      ...base,
      id: `unfinished:${session.agentSessionId}`,
      kind: "unfinished",
      state: session.terminal.status,
      detail: session.summary,
    };
  }
  if (session.terminal?.status === "completed") {
    return {
      ...base,
      id: `completed:${session.agentSessionId}`,
      kind: "completed",
      state: "completed",
      detail: session.summary,
    };
  }
  const state: Extract<PetWorkState, "idle" | "dormant" | "unknown"> =
    session.runState === "idle" ? "idle" : session.runState === "dormant" ? "dormant" : "unknown";
  return {
    ...base,
    id: `other:${session.agentSessionId}`,
    kind: "other",
    state,
    detail: session.summary,
  };
}

function pendingWithoutSession(pending: PetPendingDecision): PetWorkItem {
  return {
    id: `pending:${pending.agentSessionId}:${pending.requestId}`,
    kind: "unfinished",
    state: "needs-action",
    title: pending.title,
    detail: pending.kind === "ask_user" ? "需要回答" : pending.toolName,
    lastActivityAt: pending.createdAt,
    navigation: {
      agentSessionId: pending.agentSessionId,
      requestId: pending.requestId,
      routeGeneration: pending.routeGeneration,
    },
  };
}

/**
 * Presentation-only projection based exclusively on structured projection
 * fields. Titles and summaries are display data, never classification input.
 * Sessions without an authoritative actionable/terminal state remain visible
 * under Other instead of disappearing behind a heuristic.
 */
export function buildPetWorkMap(
  sessions: readonly PetSessionProjection[],
  pending: readonly PetPendingDecision[],
  options: {
    dismissedIds?: ReadonlySet<string>;
    excludedSessionIds?: ReadonlySet<string>;
  } = {},
): PetWorkMap {
  const sessionIds = new Set(sessions.map((session) => session.agentSessionId));
  const pendingBySession = new Map<string, PetPendingDecision>();
  for (const decision of pending) {
    if (!pendingBySession.has(decision.agentSessionId)) {
      pendingBySession.set(decision.agentSessionId, decision);
    }
  }

  const classified: PetWorkItem[] = [];
  for (const session of sessions) {
    if (options.excludedSessionIds?.has(session.agentSessionId)) continue;
    const item = itemFromSession(session, pendingBySession.get(session.agentSessionId));
    classified.push(item);
  }
  for (const decision of pending) {
    if (options.excludedSessionIds?.has(decision.agentSessionId)) continue;
    if (!sessionIds.has(decision.agentSessionId)) classified.push(pendingWithoutSession(decision));
  }

  const dismissedCount = classified.filter((item) => options.dismissedIds?.has(item.id)).length;
  const included = classified.filter((item) => !options.dismissedIds?.has(item.id));
  included.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  const counts: Record<PetWorkKind, number> = {
    unfinished: included.filter((item) => item.kind === "unfinished").length,
    optimization: included.filter((item) => item.kind === "optimization").length,
    completed: included.filter((item) => item.kind === "completed").length,
    other: included.filter((item) => item.kind === "other").length,
  };
  const itemIds: Record<PetWorkKind, string[]> = {
    unfinished: included.filter((item) => item.kind === "unfinished").map((item) => item.id),
    optimization: included.filter((item) => item.kind === "optimization").map((item) => item.id),
    completed: included.filter((item) => item.kind === "completed").map((item) => item.id),
    other: included.filter((item) => item.kind === "other").map((item) => item.id),
  };
  const visible = (["unfinished", "optimization", "completed", "other"] as const).flatMap((kind) =>
    included.filter((item) => item.kind === kind).slice(0, DISPLAY_LIMITS[kind]),
  );
  const groupsByWorkspace = new Map<string, PetWorkspaceWorkGroup>();
  for (const item of visible) {
    const key = item.workspace ?? "";
    const group = groupsByWorkspace.get(key) ?? {
      workspace: item.workspace,
      unfinished: [],
      optimization: [],
      completed: [],
      other: [],
      latestActivityAt: 0,
    };
    group[item.kind].push(item);
    group.latestActivityAt = Math.max(group.latestActivityAt, item.lastActivityAt);
    groupsByWorkspace.set(key, group);
  }

  return {
    groups: [...groupsByWorkspace.values()].sort(
      (left, right) => right.latestActivityAt - left.latestActivityAt,
    ),
    counts,
    itemIds,
    dismissedCount,
    hiddenCount: included.length - visible.length,
  };
}

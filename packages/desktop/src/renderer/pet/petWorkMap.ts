import type { PetPendingDecision, PetSessionProjection } from "../../preload/types";

export type PetWorkKind = "unfinished" | "optimization" | "completed";
export type PetWorkState =
  | "needs-action"
  | "follow-up"
  | "running"
  | "queued"
  | "failed"
  | "cancelled"
  | "optimization"
  | "completed";

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
  latestActivityAt: number;
}

export interface PetWorkMap {
  groups: PetWorkspaceWorkGroup[];
  counts: Record<PetWorkKind, number>;
  itemIds: Record<PetWorkKind, string[]>;
  dismissedCount: number;
  hiddenCount: number;
  unclassifiedCount: number;
}

const DISPLAY_LIMITS: Record<PetWorkKind, number> = {
  unfinished: 16,
  optimization: 10,
  completed: 8,
};

const OPTIMIZATION_PATTERN =
  /(?:优化|改进|改善|重构|性能|体验|技术债|可维护|refactor|optimi[sz]|improve|tech(?:nical)? debt)/i;
const COMPLETED_PATTERN = /(?:本轮已完成|已经完成|处理完成|completed|finished|done)/i;
const FOLLOW_UP_PATTERN =
  /(?:下一步|仍需|还需|需要继续|待处理|待完成|未完成|请确认|请提供|等待(?:你|用户)|需(?:你|用户)|\btodo\b|follow[ -]?up|remaining|needs? (?:input|confirmation|work))/i;

function textOf(session: PetSessionProjection): string {
  return `${session.title ?? ""}\n${session.summary ?? ""}`;
}

function itemFromSession(
  session: PetSessionProjection,
  pending: PetPendingDecision | undefined,
): PetWorkItem | null {
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
  if (
    session.terminal?.status === "completed" ||
    (session.runState === "idle" && COMPLETED_PATTERN.test(session.summary ?? ""))
  ) {
    return {
      ...base,
      id: `completed:${session.agentSessionId}`,
      kind: "completed",
      state: "completed",
      detail: session.summary,
    };
  }
  if (OPTIMIZATION_PATTERN.test(textOf(session))) {
    return {
      ...base,
      id: `optimization:${session.agentSessionId}`,
      kind: "optimization",
      state: "optimization",
      detail: session.summary,
    };
  }
  if (FOLLOW_UP_PATTERN.test(textOf(session))) {
    return {
      ...base,
      id: `follow-up:${session.agentSessionId}`,
      kind: "unfinished",
      state: "follow-up",
      detail: session.summary,
    };
  }
  return null;
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
 * Presentation-only projection. It deliberately omits dormant/idle sessions
 * without an explicit outcome so the Pet never pretends that inactivity means
 * either complete or unfinished. Those records are counted as unclassified
 * until the future structured work-item tools provide an authoritative state.
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
  let unclassifiedCount = 0;
  for (const session of sessions) {
    if (options.excludedSessionIds?.has(session.agentSessionId)) continue;
    const item = itemFromSession(session, pendingBySession.get(session.agentSessionId));
    if (item) classified.push(item);
    else unclassifiedCount += 1;
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
  };
  const itemIds: Record<PetWorkKind, string[]> = {
    unfinished: included.filter((item) => item.kind === "unfinished").map((item) => item.id),
    optimization: included.filter((item) => item.kind === "optimization").map((item) => item.id),
    completed: included.filter((item) => item.kind === "completed").map((item) => item.id),
  };
  const visible = (["unfinished", "optimization", "completed"] as const).flatMap((kind) =>
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
    unclassifiedCount,
  };
}

import type { PetPendingDecision, PetSessionProjection } from "../../preload/types";

/** Structured work group derived from projection state, never from title/summary text. */
export type PetWorkGroup = "running" | "pending" | "follow-up" | "completed" | "other";

export type PetWorkState =
  | "needs-action"
  | "follow-up"
  | "running"
  | "queued"
  | "failed"
  | "cancelled"
  | "completed"
  | "idle";

export interface PetWorkItem {
  id: string;
  group: PetWorkGroup;
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

export interface PetWorkBucket {
  group: PetWorkGroup;
  items: PetWorkItem[];
}

export interface PetWorkspaceWorkGroup {
  workspace?: string;
  buckets: PetWorkBucket[];
  latestActivityAt: number;
}

export interface PetWorkMap {
  groups: PetWorkspaceWorkGroup[];
  counts: Record<PetWorkGroup, number>;
  itemIds: Record<PetWorkGroup, string[]>;
  dismissedCount: number;
  hiddenCount: number;
  /** Retained for the footer contract; structured classification keeps it at 0. */
  unclassifiedCount: number;
}

const GROUP_ORDER: readonly PetWorkGroup[] = [
  "running",
  "pending",
  "follow-up",
  "completed",
  "other",
];

const DISPLAY_LIMITS: Record<PetWorkGroup, number> = {
  running: 16,
  pending: 16,
  "follow-up": 12,
  completed: 8,
  other: 8,
};

/**
 * Pure, presentation-only projection. Classification is derived exclusively
 * from the projection's structured state (runState / terminal / pending
 * decisions), never from title/summary text. Any session that does not match a
 * concrete state falls into the "other" bucket so nothing is ever hidden.
 *
 * "follow-up" = an idle session whose last turn produced a terminal-completed
 * outcome that the user has not yet acted on, i.e. a completed run that is not
 * yet dismissed. "completed" is reserved for sessions whose durable terminal
 * status is completed AND whose run is no longer live (disk/dormant/terminal).
 */
function classify(
  session: PetSessionProjection,
  pending: PetPendingDecision | undefined,
): { group: PetWorkGroup; state: PetWorkState } {
  if (pending) return { group: "pending", state: "needs-action" };
  if (session.pendingDecisionCount > 0) return { group: "pending", state: "needs-action" };
  if (session.runState === "running") return { group: "running", state: "running" };
  if (session.runState === "queued") return { group: "running", state: "queued" };
  if (session.terminal?.status === "failed") return { group: "other", state: "failed" };
  if (session.terminal?.status === "cancelled") return { group: "other", state: "cancelled" };
  // A live idle session that just finished a completed turn is a follow-up: the
  // user may want to review or continue it. A dormant/terminal completed disk
  // session is "completed" (already settled).
  if (session.terminal?.status === "completed") {
    return session.runState === "idle"
      ? { group: "follow-up", state: "follow-up" }
      : { group: "completed", state: "completed" };
  }
  return { group: "other", state: "idle" };
}

function itemFromSession(
  session: PetSessionProjection,
  pending: PetPendingDecision | undefined,
): PetWorkItem {
  const { group, state } = classify(session, pending);
  const idPrefix =
    group === "pending"
      ? `pending:${session.agentSessionId}:${pending?.requestId ?? "self"}`
      : `${group}:${session.agentSessionId}`;
  return {
    id: idPrefix,
    group,
    state,
    workspace: session.workspaceDisplayName,
    title: session.title ?? session.workspaceDisplayName ?? session.agentSessionId.slice(-8),
    detail: pending?.title ?? session.summary,
    lastActivityAt: pending
      ? Math.max(session.lastActivityAt, pending.createdAt)
      : session.lastActivityAt,
    navigation: {
      agentSessionId: session.agentSessionId,
      requestId: pending?.requestId,
      routeGeneration: pending?.routeGeneration,
    },
  };
}

function pendingWithoutSession(pending: PetPendingDecision): PetWorkItem {
  return {
    id: `pending:${pending.agentSessionId}:${pending.requestId}`,
    group: "pending",
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

export function buildPetWorkMap(
  sessions: readonly PetSessionProjection[],
  pending: readonly PetPendingDecision[],
  options: {
    dismissedIds?: ReadonlySet<string>;
    excludedSessionIds?: ReadonlySet<string>;
    workspaceFilter?: string;
  } = {},
): PetWorkMap {
  const sessionIds = new Set(sessions.map((session) => session.agentSessionId));
  const pendingBySession = new Map<string, PetPendingDecision>();
  for (const decision of pending) {
    if (!pendingBySession.has(decision.agentSessionId)) {
      pendingBySession.set(decision.agentSessionId, decision);
    }
  }

  const items: PetWorkItem[] = [];
  for (const session of sessions) {
    if (options.excludedSessionIds?.has(session.agentSessionId)) continue;
    items.push(itemFromSession(session, pendingBySession.get(session.agentSessionId)));
  }
  for (const decision of pending) {
    if (options.excludedSessionIds?.has(decision.agentSessionId)) continue;
    if (!sessionIds.has(decision.agentSessionId)) items.push(pendingWithoutSession(decision));
  }

  const dismissedCount = items.filter((item) => options.dismissedIds?.has(item.id)).length;
  const included = items
    .filter((item) => !options.dismissedIds?.has(item.id))
    .filter((item) => !options.workspaceFilter || item.workspace === options.workspaceFilter);
  included.sort((left, right) => right.lastActivityAt - left.lastActivityAt);

  const counts = Object.fromEntries(
    GROUP_ORDER.map((group) => [group, included.filter((i) => i.group === group).length]),
  ) as Record<PetWorkGroup, number>;
  const itemIds = Object.fromEntries(
    GROUP_ORDER.map((group) => [group, included.filter((i) => i.group === group).map((i) => i.id)]),
  ) as Record<PetWorkGroup, string[]>;

  const visible = GROUP_ORDER.flatMap((group) =>
    included.filter((item) => item.group === group).slice(0, DISPLAY_LIMITS[group]),
  );
  const groupsByWorkspace = new Map<string, PetWorkspaceWorkGroup>();
  for (const item of visible) {
    const key = item.workspace ?? "";
    const group = groupsByWorkspace.get(key) ?? {
      workspace: item.workspace,
      buckets: GROUP_ORDER.map((g) => ({ group: g, items: [] as PetWorkItem[] })),
      latestActivityAt: 0,
    };
    group.buckets.find((bucket) => bucket.group === item.group)!.items.push(item);
    group.latestActivityAt = Math.max(group.latestActivityAt, item.lastActivityAt);
    groupsByWorkspace.set(key, group);
  }

  return {
    groups: [...groupsByWorkspace.values()]
      .map((group) => ({
        ...group,
        buckets: group.buckets.filter((bucket) => bucket.items.length > 0),
      }))
      .sort((left, right) => right.latestActivityAt - left.latestActivityAt),
    counts,
    itemIds,
    dismissedCount,
    hiddenCount: included.length - visible.length,
    unclassifiedCount: 0,
  };
}

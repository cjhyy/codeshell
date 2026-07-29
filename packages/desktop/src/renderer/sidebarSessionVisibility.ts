export function compactSidebarSessions<T extends { id: string }>(
  sessions: readonly T[],
  activeSessionId: string | null,
  expanded: boolean,
  limit: number,
  /**
   * Cap while expanded. Expanding used to return every Session, so a project
   * with ~1000 of them mounted ~1000 rows (and fired one IPC each) in a single
   * commit. Omitted = unbounded, preserving the original behaviour for callers
   * that want it.
   */
  expandedLimit?: number,
): T[] {
  if (expanded) {
    if (expandedLimit === undefined || sessions.length <= expandedLimit) return [...sessions];
    const head = sessions.slice(0, expandedLimit);
    if (!activeSessionId || head.some((session) => session.id === activeSessionId)) return head;
    const active = sessions.find((session) => session.id === activeSessionId);
    if (!active) return head;
    // The active Session must stay visible even past the cap, otherwise the
    // selected row disappears from its own list.
    return [...head.slice(0, Math.max(0, expandedLimit - 1)), active];
  }
  if (sessions.length <= limit) return [...sessions];
  const compact = sessions.slice(0, limit);
  if (!activeSessionId || compact.some((session) => session.id === activeSessionId)) {
    return compact;
  }
  const active = sessions.find((session) => session.id === activeSessionId);
  if (!active) return compact;
  return [...compact.slice(0, Math.max(0, limit - 1)), active];
}

/** Pinned Sessions lead; each group keeps most-recent activity first. */
export function sortSidebarSessions<T extends { pinned?: boolean; updatedAt: number }>(
  sessions: readonly T[],
): T[] {
  return [...sessions].sort(
    (left, right) =>
      Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
      right.updatedAt - left.updatedAt,
  );
}

/** Selecting from Mimi/search must reveal the owning project in the sidebar. */
export function revealSidebarProject(
  collapsedProjects: Set<string>,
  projectId: string | null,
): Set<string> {
  if (projectId === null || !collapsedProjects.has(projectId)) {
    return collapsedProjects;
  }
  const next = new Set(collapsedProjects);
  next.delete(projectId);
  return next;
}

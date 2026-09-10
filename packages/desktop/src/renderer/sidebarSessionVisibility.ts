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
  /** A newly announced host Session stays visible without selecting its chat. */
  revealedSessionId?: string | null,
): T[] {
  const cap = expanded ? expandedLimit : limit;
  if (cap === undefined || sessions.length <= cap) return [...sessions];
  const required = new Set([activeSessionId, revealedSessionId].filter(Boolean));
  const visible = sessions.slice(0, cap);
  for (const session of sessions) {
    if (!required.has(session.id) || visible.some((candidate) => candidate.id === session.id))
      continue;
    for (let index = visible.length - 1; index >= 0; index--) {
      if (required.has(visible[index]!.id)) continue;
      visible[index] = session;
      break;
    }
  }
  const visibleIds = new Set(visible.map((session) => session.id));
  // Keep pinned/activity ordering even when selected or newly announced rows
  // displace otherwise-visible rows near the compact/expanded cap.
  return sessions.filter((session) => visibleIds.has(session.id));
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

/** Selecting or announcing a Session reveals the owning project in the sidebar. */
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

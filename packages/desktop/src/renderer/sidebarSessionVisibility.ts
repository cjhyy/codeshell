export function compactSidebarSessions<T extends { id: string }>(
  sessions: readonly T[],
  activeSessionId: string | null,
  expanded: boolean,
  limit: number,
): T[] {
  if (expanded || sessions.length <= limit) return [...sessions];
  const compact = sessions.slice(0, limit);
  if (!activeSessionId || compact.some((session) => session.id === activeSessionId)) {
    return compact;
  }
  const active = sessions.find((session) => session.id === activeSessionId);
  if (!active) return compact;
  return [...compact.slice(0, Math.max(0, limit - 1)), active];
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

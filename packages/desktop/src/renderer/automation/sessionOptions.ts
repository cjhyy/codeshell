import { NO_REPO_KEY, type SessionIndex, type SessionSummary } from "../transcripts";
import type { TrackedProject } from "../projects";
import { isQuickChatSessionId } from "../quickChatSession";
import { isNoRepoCwd, matchProjectIdForCwd } from "./pathMatch";
import type { DiskSessionMeta } from "./rebuildFromDisk";

/** A durable conversation binding plus the renderer target used to open it. */
export interface AutomationConversation {
  /** Persist this engine ID to the job; `session.id` is only a UI navigation ID. */
  sessionId: string;
  title: string;
  projectLabel: string;
  updatedAt: number;
  projectId: string | null;
  archived: boolean;
  /** Present for a locally indexed conversation, including an archived binding. */
  session?: SessionSummary;
  /** Present only when opening the conversation first requires a disk import. */
  disk?: DiskSessionMeta;
}

/** The server catalog also supplies this durable archive field. */
type CatalogSession = DiskSessionMeta & { archivedAt?: number };

export interface AutomationConversationOptions {
  /** Include archived entries to resolve existing bindings, never for new choices. */
  includeArchived?: boolean;
  /** Caller supplies the platform policy so the mapping remains deterministic. */
  caseInsensitive?: boolean;
  noProjectLabel?: string;
  unknownProjectLabel?: string;
}

function isInternalSessionId(sessionId: string): boolean {
  // Match the server catalog's ephemeral session exclusions. These conversations
  // cannot outlive their quick-chat/panel request and cannot host recurring work.
  return isQuickChatSessionId(sessionId) || sessionId.startsWith("panel-task-");
}

/**
 * Build the automation conversation picker from normal chats and automation
 * chats alike. Local titles/navigation win over disk copies, while disk updates
 * still contribute to recency. Empty drafts have no durable ID and are omitted.
 *
 * The desktop catalog already excludes hidden session kinds and ephemeral state.
 * Child rows are also rejected here in case a transcript query is passed in.
 * Runtime ownership is not exposed by these inputs and is not inferred from IDs.
 */
export function buildAutomationConversations(
  sessionIndices: Record<string, SessionIndex>,
  diskSessions: CatalogSession[],
  projects: TrackedProject[],
  options: AutomationConversationOptions = {},
): AutomationConversation[] {
  const noProjectLabel = options.noProjectLabel ?? "无项目（对话）";
  const unknownProjectLabel = options.unknownProjectLabel ?? "未知项目";
  const projectLabels = new Map(
    projects.map((project) => [project.id, project.displayName?.trim() || project.name]),
  );
  const byId = new Map<string, AutomationConversation>();
  const hiddenIds = new Set<string>();
  const archivedIds = new Set<string>();

  for (const disk of diskSessions) {
    if (disk.parentSessionId || disk.origin === "subagent") {
      hiddenIds.add(disk.engineSessionId);
      hiddenIds.add(disk.id);
    }
    if (typeof disk.archivedAt === "number") {
      archivedIds.add(disk.engineSessionId);
      archivedIds.add(disk.id);
    }
  }
  // Remember archives before considering disk fallback, including old local
  // rows with no engine binding. A disk copy must not resurrect an archived row.
  for (const index of Object.values(sessionIndices)) {
    for (const session of index.sessions) {
      if (session.archived) {
        archivedIds.add(session.id);
        if (session.engineSessionId) archivedIds.add(session.engineSessionId);
      }
    }
  }

  const isHidden = (id: string) => hiddenIds.has(id) || isInternalSessionId(id);
  for (const [bucket, index] of Object.entries(sessionIndices)) {
    const projectId = bucket === NO_REPO_KEY ? null : bucket;
    const projectLabel =
      projectId === null
        ? noProjectLabel
        : projectLabels.get(projectId) || index.deletedProjectLabel || unknownProjectLabel;
    for (const session of index.sessions) {
      const sessionId = session.engineSessionId;
      if (!sessionId?.trim() || isHidden(sessionId) || isHidden(session.id)) continue;
      const archived = archivedIds.has(sessionId) || archivedIds.has(session.id);
      if (archived && !options.includeArchived) continue;
      const existing = byId.get(sessionId);
      if (existing && existing.updatedAt >= session.updatedAt) continue;
      byId.set(sessionId, {
        sessionId,
        title: session.title.trim() || sessionId,
        projectLabel,
        updatedAt: session.updatedAt,
        projectId,
        archived,
        session,
      });
    }
  }

  for (const disk of diskSessions) {
    const sessionId = disk.engineSessionId;
    if (!sessionId?.trim() || isHidden(sessionId) || isHidden(disk.id)) continue;
    const archived = archivedIds.has(sessionId) || archivedIds.has(disk.id);
    if (archived && !options.includeArchived) continue;
    const existing = byId.get(sessionId);
    if (existing) {
      // Keep the local open target and title even when disk activity is newer.
      existing.updatedAt = Math.max(existing.updatedAt, disk.updatedAt);
      continue;
    }
    const projectId = isNoRepoCwd(disk.cwd)
      ? null
      : matchProjectIdForCwd(disk.cwd, projects, options.caseInsensitive ?? false);
    byId.set(sessionId, {
      sessionId,
      title: disk.title.trim() || sessionId,
      projectLabel:
        projectId !== null
          ? projectLabels.get(projectId) || unknownProjectLabel
          : isNoRepoCwd(disk.cwd)
            ? noProjectLabel
            : disk.cwd,
      updatedAt: disk.updatedAt,
      projectId,
      archived,
      disk,
    });
  }

  return [...byId.values()].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId),
  );
}

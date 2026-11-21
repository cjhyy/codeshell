/** Desktop memory views and edits, shared by the Host and its storage worker. */
import { MemoryManager, type MemoryScope } from "@cjhyy/code-shell-core";
import { readWorkspaceProfile, workspaceProfileDir } from "@cjhyy/code-shell-core/internal";

import type { MemoryLevel, RendererMemoryEntry, SaveMemoryInput } from "../preload/types";
function mm(
  level: MemoryLevel,
  scope: MemoryScope,
  cwd?: string,
  profileName?: string,
  beforeWrite?: () => void,
): MemoryManager {
  if (level === "profile") {
    if (!profileName) throw new Error("profile memory requires profileName");
    if (!readWorkspaceProfile(profileName)) {
      throw new Error(`workspace profile ${profileName} does not exist`);
    }
    return new MemoryManager({ beforeWrite, baseDir: workspaceProfileDir(profileName), scope });
  }
  if (level === "project") {
    if (!cwd) throw new Error("project memory requires cwd");
    return new MemoryManager({ beforeWrite, projectDir: cwd, scope });
  }
  return new MemoryManager({ beforeWrite, scope });
}

export function listMemory(
  level: MemoryLevel,
  scope: MemoryScope,
  cwd?: string,
  profileName?: string,
): RendererMemoryEntry[] {
  const entries = mm(level, scope, cwd, profileName).loadAll();
  return entries.map((e) => ({
    name: e.name,
    description: e.description,
    type: e.type,
    fileName: e.fileName,
    scope: e.scope,
    level,
    ...(profileName ? { profileName } : {}),
    pinned: e.pinned,
    id: e.id,
    origin: e.origin,
    useCount: e.useCount,
    updateCount: e.updateCount,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    lastUsedAt: e.lastUsedAt,
    usageCount: e.usageCount,
    lastUsed: e.lastUsed,
    created: e.created,
    originProject: e.originProject,
    originProjects: e.originProjects,
    promotionReason: e.promotionReason,
    promotionStatus: e.promotionStatus,
  }));
}

export function readMemory(
  level: MemoryLevel,
  scope: MemoryScope,
  name: string,
  cwd?: string,
  profileName?: string,
): (RendererMemoryEntry & { content: string }) | null {
  const entries = mm(level, scope, cwd, profileName).loadAll();
  const e = entries.find((x) => x.id === name || x.name === name || x.fileName === name);
  if (!e) return null;
  return {
    name: e.name,
    description: e.description,
    type: e.type,
    fileName: e.fileName,
    scope: e.scope,
    level,
    ...(profileName ? { profileName } : {}),
    content: e.content,
    pinned: e.pinned,
    id: e.id,
    origin: e.origin,
    useCount: e.useCount,
    updateCount: e.updateCount,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    lastUsedAt: e.lastUsedAt,
    usageCount: e.usageCount,
    lastUsed: e.lastUsed,
    created: e.created,
    originProject: e.originProject,
    originProjects: e.originProjects,
    promotionReason: e.promotionReason,
    promotionStatus: e.promotionStatus,
  };
}

export function saveMemory(input: SaveMemoryInput, beforeWrite?: () => void): string {
  return mm(input.level, input.scope, input.cwd, input.profileName, beforeWrite).save({
    id: input.id,
    name: input.name,
    description: input.description,
    type: input.type,
    content: input.content,
    pinned: input.pinned,
    origin: input.origin,
  });
}

export function deleteMemory(
  level: MemoryLevel,
  scope: MemoryScope,
  name: string,
  cwd?: string,
  profileName?: string,
  beforeWrite?: () => void,
): boolean {
  return mm(level, scope, cwd, profileName, beforeWrite).delete(name);
}

// ─── Pending (审批门) ────────────────────────────────────────────────────────
// Auto-extracted "global" candidates wait here until the user approves them
// into the injected global dream store. Pending is global-only (no projectDir).

function pendingMm(beforeWrite?: () => void): MemoryManager {
  return new MemoryManager({ scope: "pending", beforeWrite });
}

/** List global memories awaiting approval (full content included — the panel
 *  shows it inline so the user can judge before approving). */
export function listPendingMemory(): (RendererMemoryEntry & { content: string })[] {
  return pendingMm()
    .loadAll()
    .map((e) => ({
      name: e.name,
      description: e.description,
      type: e.type,
      fileName: e.fileName,
      scope: e.scope,
      level: "user" as const,
      content: e.content,
      id: e.id,
      origin: e.origin,
      useCount: e.useCount,
      updateCount: e.updateCount,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      lastUsedAt: e.lastUsedAt,
      usageCount: e.usageCount,
      lastUsed: e.lastUsed,
      created: e.created,
      originProject: e.originProject,
      originProjects: e.originProjects,
      promotionReason: e.promotionReason,
      promotionStatus: e.promotionStatus,
    }));
}

/** Approve → moves the entry into the global dream store (gets injected). */
export function approvePendingMemory(name: string, beforeWrite?: () => void): string | null {
  return pendingMm(beforeWrite).approvePending(name);
}

/** Demote → 不升全局但保留:落回它来源项目的 user store(无来源则全局兜底)。 */
export function demotePendingMemory(name: string, beforeWrite?: () => void): string | null {
  return pendingMm(beforeWrite).demotePending(name);
}

/** Reject → mark the source project dream rejected, then soft-delete pending. */
export function rejectPendingMemory(name: string, beforeWrite?: () => void): boolean {
  return pendingMm(beforeWrite).rejectPending(name);
}

/** Promote a project-level user memory to the global user store (手动提升). */
export function promoteMemoryToGlobal(
  cwd: string,
  name: string,
  beforeWrite?: () => void,
): string | null {
  return new MemoryManager({ projectDir: cwd, scope: "user", beforeWrite }).promoteToGlobal(name);
}

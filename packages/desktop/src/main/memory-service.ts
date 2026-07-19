/**
 * Renderer-facing wrapper around core's MemoryManager.
 *
 * The renderer can't reach into core's session/memory directly (it
 * lives in the worker process), so we replicate just the four
 * surface calls it needs — list / read / save / delete — and route
 * them through MemoryManager instances created here in the main
 * process. We honour both axes:
 *
 *   - level: "user" (no projectDir → ~/.code-shell/memory/<scope>),
 *            "project" (projectDir set to the active repo path →
 *            ~/.code-shell/projects/<hash>/memory/<scope>), or
 *            "profile" (digital-human-owned →
 *            ~/.code-shell/profiles/<name>/memory/<scope>).
 *   - scope: "user" (manual entries) or "dream" (auto-consolidated).
 *
 * "user" + level=user is the common case the user interacts with;
 * the dream scope is exposed too because cleaning it up is a normal
 * maintenance task. project-level entries land under the repo's
 * dedicated memory dir so we don't pollute the global one.
 */

import { MemoryManager, type MemoryEntry, type MemoryScope } from "@cjhyy/code-shell-core";
import { readWorkspaceProfile, workspaceProfileDir } from "@cjhyy/code-shell-core/internal";

export type MemoryLevel = "user" | "project" | "profile";

export interface RendererMemoryEntry {
  name: string;
  description: string;
  type: MemoryEntry["type"];
  fileName: string;
  scope: MemoryScope;
  level: MemoryLevel;
  profileName?: string;
  pinned?: boolean;
  id?: string;
  origin?: "auto" | "manual" | "dream";
  /** Recall lifecycle — surfaced in the settings panel so the user can see
   *  which memories are actually used and which are aging toward TTL pruning. */
  useCount?: number;
  updateCount?: number;
  createdAt?: string;
  updatedAt?: string;
  lastUsedAt?: string;
  usageCount?: number;
  lastUsed?: string;
  created?: string;
  originProject?: string;
  originProjects?: string[];
  promotionReason?: string;
  promotionStatus?: MemoryEntry["promotionStatus"];
}

function mm(
  level: MemoryLevel,
  scope: MemoryScope,
  cwd?: string,
  profileName?: string,
): MemoryManager {
  if (level === "profile") {
    if (!profileName) throw new Error("profile memory requires profileName");
    if (!readWorkspaceProfile(profileName)) {
      throw new Error(`workspace profile ${profileName} does not exist`);
    }
    return new MemoryManager({ baseDir: workspaceProfileDir(profileName), scope });
  }
  if (level === "project") {
    if (!cwd) throw new Error("project memory requires cwd");
    return new MemoryManager({ projectDir: cwd, scope });
  }
  return new MemoryManager({ scope });
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

export interface SaveMemoryInput {
  level: MemoryLevel;
  scope: MemoryScope;
  name: string;
  description: string;
  type: MemoryEntry["type"];
  content: string;
  cwd?: string;
  profileName?: string;
  pinned?: boolean;
  id?: string;
  origin?: "auto" | "manual" | "dream";
}

export function saveMemory(input: SaveMemoryInput): string {
  return mm(input.level, input.scope, input.cwd, input.profileName).save({
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
): boolean {
  return mm(level, scope, cwd, profileName).delete(name);
}

// ─── Pending (审批门) ────────────────────────────────────────────────────────
// Auto-extracted "global" candidates wait here until the user approves them
// into the injected global dream store. Pending is global-only (no projectDir).

function pendingMm(): MemoryManager {
  return new MemoryManager({ scope: "pending" });
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
export function approvePendingMemory(name: string): string | null {
  return pendingMm().approvePending(name);
}

/** Demote → 不升全局但保留:落回它来源项目的 user store(无来源则全局兜底)。 */
export function demotePendingMemory(name: string): string | null {
  return pendingMm().demotePending(name);
}

/** Reject → mark the source project dream rejected, then soft-delete pending. */
export function rejectPendingMemory(name: string): boolean {
  return pendingMm().rejectPending(name);
}

/** Promote a project-level user memory to the global user store (手动提升). */
export function promoteMemoryToGlobal(cwd: string, name: string): string | null {
  return new MemoryManager({ projectDir: cwd, scope: "user" }).promoteToGlobal(name);
}

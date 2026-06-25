/**
 * Renderer-facing wrapper around core's MemoryManager.
 *
 * The renderer can't reach into core's session/memory directly (it
 * lives in the worker process), so we replicate just the four
 * surface calls it needs — list / read / save / delete — and route
 * them through MemoryManager instances created here in the main
 * process. We honour both axes:
 *
 *   - level: "user" (no projectDir → ~/.code-shell/memory/<scope>) or
 *            "project" (projectDir set to the active repo path →
 *            ~/.code-shell/projects/<hash>/memory/<scope>).
 *   - scope: "user" (manual entries) or "dream" (auto-consolidated).
 *
 * "user" + level=user is the common case the user interacts with;
 * the dream scope is exposed too because cleaning it up is a normal
 * maintenance task. project-level entries land under the repo's
 * dedicated memory dir so we don't pollute the global one.
 */

import {
  MemoryManager,
  type MemoryEntry,
  type MemoryScope,
} from "@cjhyy/code-shell-core";

export type MemoryLevel = "user" | "project";

export interface RendererMemoryEntry {
  name: string;
  description: string;
  type: MemoryEntry["type"];
  fileName: string;
  scope: MemoryScope;
  level: MemoryLevel;
  pinned?: boolean;
  origin?: "auto" | "manual";
  /** Recall lifecycle — surfaced in the settings panel so the user can see
   *  which memories are actually used and which are aging toward TTL pruning. */
  usageCount?: number;
  lastUsed?: string;
  created?: string;
}

function mm(level: MemoryLevel, scope: MemoryScope, cwd?: string): MemoryManager {
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
): RendererMemoryEntry[] {
  const entries = mm(level, scope, cwd).loadAll();
  return entries.map((e) => ({
    name: e.name,
    description: e.description,
    type: e.type,
    fileName: e.fileName,
    scope: e.scope,
    level,
    pinned: e.pinned,
    origin: e.origin,
    usageCount: e.usageCount,
    lastUsed: e.lastUsed,
    created: e.created,
  }));
}

export function readMemory(
  level: MemoryLevel,
  scope: MemoryScope,
  name: string,
  cwd?: string,
): (RendererMemoryEntry & { content: string }) | null {
  const entries = mm(level, scope, cwd).loadAll();
  const e = entries.find((x) => x.name === name || x.fileName === name);
  if (!e) return null;
  return {
    name: e.name,
    description: e.description,
    type: e.type,
    fileName: e.fileName,
    scope: e.scope,
    level,
    content: e.content,
    pinned: e.pinned,
    origin: e.origin,
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
  pinned?: boolean;
  origin?: "auto" | "manual";
}

export function saveMemory(input: SaveMemoryInput): string {
  return mm(input.level, input.scope, input.cwd).save({
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
): boolean {
  return mm(level, scope, cwd).delete(name);
}

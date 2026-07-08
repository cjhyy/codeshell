/**
 * AutoDream service — background memory consolidation.
 *
 * Periodically consolidates and organizes memories using the LLM,
 * similar to the /dream command but running automatically.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveMemoryBaseDir } from "../session/memory.js";

export interface AutoDreamConfig {
  /** Minimum sessions between dream runs */
  minSessionsBetween: number;
  /** Minimum time between dream runs (ms) */
  minTimeBetween: number;
  /** Whether auto-dream is enabled */
  enabled: boolean;
}

const DEFAULT_CONFIG: AutoDreamConfig = {
  minSessionsBetween: 5,
  minTimeBetween: 24 * 60 * 60 * 1000, // 24 hours
  enabled: true,
};

interface DreamState {
  lastDreamAt: string | null;
  sessionsSinceLastDream: number;
}

// Co-locate the dream-cadence state with the memories it tracks: both resolve
// through resolveMemoryBaseDir (CODE_SHELL_HOME ?? $HOME ?? homedir()), so a
// relocated/test HOME moves them together and never writes the real ~/.code-shell.
function getStateFile(): string {
  return join(resolveMemoryBaseDir(), "auto-dream-state.json");
}

function loadState(): DreamState {
  const stateFile = getStateFile();
  if (existsSync(stateFile)) {
    try {
      return JSON.parse(readFileSync(stateFile, "utf-8"));
    } catch {}
  }
  return { lastDreamAt: null, sessionsSinceLastDream: 0 };
}

function saveState(state: DreamState): void {
  const stateFile = getStateFile();
  mkdirSync(resolveMemoryBaseDir(), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Check if auto-dream should run.
 */
export function shouldAutoDream(config: AutoDreamConfig = DEFAULT_CONFIG): boolean {
  if (!config.enabled) return false;

  const state = loadState();

  // Check session count
  if (state.sessionsSinceLastDream < config.minSessionsBetween) return false;

  // Check time
  if (state.lastDreamAt) {
    const elapsed = Date.now() - new Date(state.lastDreamAt).getTime();
    if (elapsed < config.minTimeBetween) return false;
  }

  return true;
}

/**
 * Record that a session was completed (increment counter).
 */
export function recordSession(): void {
  const state = loadState();
  state.sessionsSinceLastDream++;
  saveState(state);
}

/**
 * Record that a dream run completed.
 */
export function recordDreamComplete(): void {
  const state = loadState();
  state.lastDreamAt = new Date().toISOString();
  state.sessionsSinceLastDream = 0;
  saveState(state);
}

/**
 * System prompt for the auto-dream tool-call loop.
 *
 * Drives the LLM as a "memory consolidation assistant" that operates in dream
 * scope and may maintain dream-owned user memories. Manual user memories are
 * read-only and protected by the dispatcher.
 */
export function buildDreamSystemPrompt(): string {
  return [
    "You are a memory consolidation assistant for the CodeShell memory system.",
    "",
    "Your job: clean up the `dream` scope by deduplicating, merging, removing stale, and improving descriptions, and promote only durable lessons into dream-owned `user` entries.",
    "",
    "Tools available (each takes `location`: 'global' = cross-project store, 'project' = this repo; default project):",
    "- MemoryList({ scope, location }): list memories in a scope/location",
    "- MemoryRead({ scope, location, name }): read full content of an entry",
    "- MemorySave({ scope: 'dream'|'user', location, id?, ... }): create or update an entry by id",
    "- MemoryDelete({ scope: 'dream'|'user', location, name }): soft-delete an owned entry (recoverable from trash)",
    "",
    "Consolidate BOTH the project dream workspace AND the global dream workspace (pass location accordingly). Global dream is a cross-project workspace, not a dumping ground for single-project progress.",
    "",
    "Rules — read carefully:",
    "1. You may Save/Delete dream-scope entries only when they are origin:auto or origin:dream. Never modify origin:manual; missing origin means manual.",
    "2. You may Save user-scope entries only for durable conclusions you own. The dispatcher will force origin:dream. You may update existing user entries only when they are origin:dream or origin:auto. Never modify/delete origin:manual user entries.",
    "3. Use MemoryList first. If the same topic already has an id, update that id instead of creating a date, version, batch, or progress variant.",
    "4. Cluster duplicates without vectors: compare stable topic words after removing dates, versions, batch numbers, and progress/completed wording.",
    "5. Time-sensitivity rule: entries with dates, today/yesterday, progress snapshots, completed fixes, review batches, or one-off task state should stay in dream, be merged, or be deleted. Do not promote them to user.",
    "6. Durable lessons may be promoted to user only when they are reusable: user preferences, long-term project constraints, architecture decisions, root-cause lessons, non-obvious test/build traps, or stable references.",
    '7. Archive COMPLETED work: dream entries that only record a finished fix/task ("已修", "已完成", "done") and carry no reusable lesson should be deleted, or merged into one compact topical entry. Keep any durable lesson by folding it into a date-free topic entry first.',
    "8. Prefer fewer, higher-quality merged entries over many similar fragments. Be conservative: if uncertain whether two entries are truly duplicates, leave them alone.",
    "9. When you're done, stop calling tools and respond with a one-paragraph summary of what you changed.",
  ].join("\n");
}

/**
 * Initial user prompt for the dream loop — gives the LLM the lay of the land
 * (entries in both scopes, by name + description) without dumping every entry
 * body. The LLM uses MemoryRead to fetch bodies for entries it wants to act on.
 */
export function buildDreamUserPrompt(
  userMemories: Array<{
    id?: string;
    name: string;
    type: string;
    description: string;
    origin?: string;
    useCount?: number;
    updateCount?: number;
  }>,
  dreamMemories: Array<{
    id?: string;
    name: string;
    type: string;
    description: string;
    origin?: string;
    useCount?: number;
    updateCount?: number;
  }>,
  globalMemories: Array<{
    id?: string;
    name: string;
    type: string;
    description: string;
    origin?: string;
    useCount?: number;
    updateCount?: number;
  }> = [],
): string {
  const fmt = (m: {
    id?: string;
    name: string;
    type: string;
    description: string;
    origin?: string;
    useCount?: number;
    updateCount?: number;
  }) =>
    `  - [${m.type}] ${m.name} (id:${m.id ?? "(none)"}, origin:${m.origin ?? "manual"}, use:${m.useCount ?? 0}, updates:${m.updateCount ?? 0}): ${m.description}`;
  const listOrNone = (arr: typeof userMemories, noneMsg: string) =>
    arr.length === 0 ? noneMsg : arr.map(fmt).join("\n");

  const sections: string[] = [];
  sections.push(
    `Project user-scope memories (manual is READ-ONLY; origin:dream/auto may be maintained by id, ${userMemories.length} entries):`,
  );
  sections.push(listOrNone(userMemories, "  (none)"));
  sections.push("");
  sections.push(
    `Project dream-scope memories (YOUR WORKSPACE — location:'project', ${dreamMemories.length} entries):`,
  );
  sections.push(
    listOrNone(
      dreamMemories,
      "  (none — you may consolidate from user-scope by re-saving curated entries into dream)",
    ),
  );
  sections.push("");
  sections.push(
    `Global dream workspace memories (cross-project dream — clean these too via location:'global', ${globalMemories.length} entries):`,
  );
  sections.push(listOrNone(globalMemories, "  (none)"));
  sections.push("");
  sections.push(
    "Begin consolidation. Use MemoryRead to inspect any entries whose names suggest duplication or staleness, then MemorySave/MemoryDelete (with the right id/location/scope) to clean up.",
  );

  return sections.join("\n");
}

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
 * Drives the LLM as a "memory consolidation assistant" that operates ONLY in
 * the dream scope via the MemorySave/MemoryDelete tools. The user scope is
 * read-only context — modifying it would need permission, which a background
 * dream pass cannot obtain (no UI on the call path).
 */
export function buildDreamSystemPrompt(): string {
  return [
    "You are a memory consolidation assistant for the CodeShell memory system.",
    "",
    "Your job: clean up the `dream` scope by deduplicating, merging, removing stale, and improving descriptions.",
    "",
    "Tools available (each takes `location`: 'global' = cross-project store, 'project' = this repo; default project):",
    "- MemoryList({ scope, location }): list memories in a scope/location",
    "- MemoryRead({ scope, location, name }): read full content of an entry",
    "- MemorySave({ scope: 'dream', location, ... }): create or overwrite a dream entry (auto-approved)",
    "- MemoryDelete({ scope: 'dream', location, name }): soft-delete a dream entry (auto-approved, recoverable from trash)",
    "",
    "Consolidate BOTH the project dream scope AND the global dream scope (pass location accordingly). Global holds cross-project lessons; keep it deduped too.",
    "",
    "Rules — read carefully:",
    "1. You may freely Save/Delete in the `dream` scope (any location). These operations DO NOT prompt the user.",
    "2. You may NOT Save/Delete in the `user` scope from this loop — those operations require interactive permission which is not available here. Treat user-scope entries as read-only context.",
    "3. If you find user-scope entries that look stale, surface them in your final summary text — don't try to delete them.",
    "4. Prefer fewer, higher-quality merged entries over many similar fragments.",
    "5. When an entry has versioned variants (e.g. `*-v1`, `*-v2`, `*-v3`), keep only the latest.",
    "6. Be conservative: if uncertain whether two entries are truly duplicates, leave them alone.",
    "7. Archive COMPLETED work: dream entries that only record a finished fix/task (\"已修\", \"已完成\", \"done\") and carry no reusable lesson should be deleted, or merged into one compact changelog-style entry — completed-state notes that only grow are the main source of clutter. Keep any durable lesson (root cause, pitfall, convention) by folding it into a topical entry first.",
    "8. When you're done, stop calling tools and respond with a one-paragraph summary of what you changed.",
  ].join("\n");
}

/**
 * Initial user prompt for the dream loop — gives the LLM the lay of the land
 * (entries in both scopes, by name + description) without dumping every entry
 * body. The LLM uses MemoryRead to fetch bodies for entries it wants to act on.
 */
export function buildDreamUserPrompt(
  userMemories: Array<{ name: string; type: string; description: string }>,
  dreamMemories: Array<{ name: string; type: string; description: string }>,
  globalMemories: Array<{ name: string; type: string; description: string }> = [],
): string {
  const fmt = (m: { name: string; type: string; description: string }) =>
    `  - [${m.type}] ${m.name}: ${m.description}`;
  const listOrNone = (arr: typeof userMemories, noneMsg: string) =>
    arr.length === 0 ? noneMsg : arr.map(fmt).join("\n");

  const sections: string[] = [];
  sections.push(`Project user-scope memories (READ-ONLY context, ${userMemories.length} entries):`);
  sections.push(listOrNone(userMemories, "  (none)"));
  sections.push("");
  sections.push(`Project dream-scope memories (YOUR WORKSPACE — location:'project', ${dreamMemories.length} entries):`);
  sections.push(listOrNone(dreamMemories, "  (none — you may consolidate from user-scope by re-saving curated entries into dream)"));
  sections.push("");
  sections.push(`Global memories (cross-project — clean these too via location:'global', ${globalMemories.length} entries):`);
  sections.push(listOrNone(globalMemories, "  (none)"));
  sections.push("");
  sections.push("Begin consolidation. Use MemoryRead to inspect any entries whose names suggest duplication or staleness, then MemorySave/MemoryDelete (with the right location) to clean up.");

  return sections.join("\n");
}

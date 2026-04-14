/**
 * AutoDream service — background memory consolidation.
 *
 * Periodically consolidates and organizes memories using the LLM,
 * similar to the /dream command but running automatically.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

function getStateFile(): string {
  return join(homedir(), ".code-shell", "auto-dream-state.json");
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
  mkdirSync(join(homedir(), ".code-shell"), { recursive: true });
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
 * Build the consolidation prompt for auto-dream.
 */
export function buildDreamPrompt(
  memories: Array<{ name: string; type: string; description: string; content: string }>,
): string {
  if (memories.length === 0) return "";

  const memoryDump = memories
    .map((m) => `## [${m.type}] ${m.name}\n${m.description}\n\n${m.content}`)
    .join("\n\n---\n\n");

  return `Analyze and consolidate the following persistent memories:

${memoryDump}

Tasks:
1. Identify duplicate or near-duplicate memories — merge them
2. Identify outdated or stale memories — flag for removal
3. Consolidate related memories into cleaner entries
4. Ensure each memory has a clear, specific description
5. Re-categorize any mistyped memories

For each change, explain what you'd update and why.
Output the consolidated memory list as JSON.`;
}

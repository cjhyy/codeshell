/**
 * Tool-result persistence — write large tool_result content to disk and
 * replace the in-context message with a reference + preview.
 *
 * Mirrors Claude Code's services/compact/microcompact.ts + utils/toolResultStorage.ts
 * approach, simplified for codeshell:
 *
 *   • One file per tool_use_id (UUID), so the same id always maps to the
 *     same file — guarantees byte-identical preview on every turn.
 *   • Decision state (ContentReplacementState) is held by the caller and
 *     mutated in place. Once a result is "seen", its fate is frozen for
 *     the rest of the session (prevents flapping replacement choices that
 *     would constantly invalidate the prompt prefix).
 *   • No transcript persistence / no fork-subagent gap-fill. Resume just
 *     re-derives the seenIds set from the loaded messages.
 *
 * Strategy:
 *   • Per-result cap (DEFAULT_PERSIST_THRESHOLD): when a single tool_result
 *     exceeds it, persist + replace.
 *   • Per-message aggregate cap (PER_MESSAGE_AGGREGATE_CAP): when a single
 *     user message's tool_results together exceed it (e.g. a batch of
 *     parallel Read results), persist the largest ones first until under.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContentBlock, Message } from "../types.js";
import { logger } from "../logging/logger.js";

// ─── Tunables ───────────────────────────────────────────────────────

/** Per-result threshold. Larger than this → persist + replace. */
export const DEFAULT_PERSIST_THRESHOLD = 50_000;

/** Per-message aggregate cap (sum of tool_result content sizes in one user msg). */
export const PER_MESSAGE_AGGREGATE_CAP = 200_000;

/** Preview length included in the replacement string. */
export const PREVIEW_SIZE = 2_000;

/** Sentinel tags so re-runs detect "already-persisted" content. */
const PERSISTED_OPEN = "<persisted-output>";
const PERSISTED_CLOSE = "</persisted-output>";
const CLEARED_PREFIX = "[Old tool result cleared";

// ─── State ───────────────────────────────────────────────────────────

/**
 * Per-session decision state for tool-result persistence.
 *
 *  seenIds       — every tool_use_id we've evaluated; once seen, its fate
 *                  (persisted or not) is fixed for the rest of the session.
 *  replacements  — subset of seenIds that were persisted, mapped to the
 *                  EXACT replacement string sent to the model. Re-applying
 *                  is a Map lookup, never re-reads the file, guarantees
 *                  byte-identical output.
 */
export interface ContentReplacementState {
  seenIds: Set<string>;
  replacements: Map<string, string>;
}

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() };
}

/**
 * Rebuild a state object by walking the loaded message history.
 * Used on resume so the budget makes the same decisions it made before.
 * Replacements are taken from the messages themselves (we identify them
 * by the PERSISTED_OPEN sentinel), so we don't need a side-channel log.
 */
export function reconstructContentReplacementState(
  messages: Message[],
): ContentReplacementState {
  const state = createContentReplacementState();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      state.seenIds.add(block.tool_use_id);
      if (typeof block.content === "string" && block.content.startsWith(PERSISTED_OPEN)) {
        state.replacements.set(block.tool_use_id, block.content);
      }
    }
  }
  return state;
}

// ─── Persistence ─────────────────────────────────────────────────────

/**
 * Resolve the directory tool results are written to, given the engine's
 * transcript path. Layout:  <transcriptDir>/tool-results/
 */
export function resolveToolResultsDir(transcriptPath: string): string {
  return join(dirname(transcriptPath), "tool-results");
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Existing directory is fine.
  }
}

/**
 * Write content to <dir>/<toolUseId>.txt. Idempotent: skips if the file
 * already exists (tool_use_id is a UUID, content is deterministic per id).
 */
function persistToFile(dir: string, toolUseId: string, content: string): string {
  ensureDir(dir);
  const filepath = join(dir, `${toolUseId}.txt`);
  try {
    // 'wx' = fail if exists. Skipping on collision is correct: same id =
    // same content. Avoids re-writing the same bytes every turn.
    writeFileSync(filepath, content, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      // Read-only FS (CI containers, ephemeral runtimes) hits EROFS/EACCES/
      // ENOENT here on every large tool_result. The caller already catches
      // and marks the id as seen so we don't re-attempt; degrade to debug
      // so a headless run on a read-only FS doesn't flood the log with
      // warnings. The block is left in-place untouched, which is the
      // correct user-facing behavior.
      logger.debug("tool_result.persist_failed", {
        toolUseId,
        code,
        error: (err as Error).message,
      });
      throw err;
    }
  }
  return filepath;
}

function buildReplacement(filepath: string, originalSize: number, content: string): string {
  const sizeKb = (originalSize / 1024).toFixed(1);
  const previewRaw = content.slice(0, PREVIEW_SIZE);
  // Cut at the last newline within the preview if there's one in the
  // back half — avoids slicing mid-line which looks ugly to the model.
  const lastNl = previewRaw.lastIndexOf("\n");
  const preview = lastNl > PREVIEW_SIZE * 0.5 ? previewRaw.slice(0, lastNl) : previewRaw;
  const hasMore = content.length > preview.length;
  return (
    `${PERSISTED_OPEN}\n` +
    `Output too large (${sizeKb} KB). Full output saved to: ${filepath}\n\n` +
    `Preview (first ${preview.length} chars${hasMore ? ", truncated" : ""}):\n` +
    preview +
    (hasMore ? "\n..." : "") +
    `\n${PERSISTED_CLOSE}`
  );
}

// ─── Application ─────────────────────────────────────────────────────

interface ToolResultCandidate {
  toolUseId: string;
  block: ContentBlock;
  content: string;
  size: number;
}

function collectCandidates(msg: Message): ToolResultCandidate[] {
  if (!Array.isArray(msg.content)) return [];
  const out: ToolResultCandidate[] = [];
  for (const block of msg.content) {
    if (block.type !== "tool_result" || !block.tool_use_id) continue;
    if (typeof block.content !== "string") continue;
    // Skip blocks already in a persisted/cleared sentinel — nothing to do
    // and we must not re-persist (would change replacement strings →
    // prompt cache miss).
    if (
      block.content.startsWith(PERSISTED_OPEN) ||
      block.content.startsWith(CLEARED_PREFIX)
    )
      continue;
    out.push({
      toolUseId: block.tool_use_id,
      block,
      content: block.content,
      size: block.content.length,
    });
  }
  return out;
}

interface PersistOptions {
  /** Per-result threshold; default DEFAULT_PERSIST_THRESHOLD. */
  perResultThreshold?: number;
  /** Per-message aggregate cap; default PER_MESSAGE_AGGREGATE_CAP. */
  perMessageCap?: number;
  /** Directory to write tool-result files to. Required. */
  toolResultsDir: string;
  /** Decision state, mutated in place. */
  state: ContentReplacementState;
  /** Optional callback fired when a result is freshly persisted. */
  onPersist?: (info: {
    toolUseId: string;
    filepath: string;
    originalSize: number;
    reason: "per-result-cap" | "per-message-budget";
  }) => void;
}

/**
 * Walk each user message, decide which tool_result blocks should be
 * persisted (per-result cap OR per-message aggregate), persist them,
 * and return a new message array with those blocks replaced.
 *
 * Frozen decisions:
 *  - If a tool_use_id is already in state.replacements, that exact
 *    replacement is re-applied (no I/O).
 *  - If it's in state.seenIds but NOT replacements, it was decided
 *    "don't persist" on an earlier pass — leave it unreplaced even if
 *    it now exceeds the threshold (changing the decision mid-session
 *    would invalidate any model state built on the prior content).
 *
 * @returns the new messages array, with replacements applied.
 */
export function applyToolResultPersistence(
  messages: Message[],
  options: PersistOptions,
): Message[] {
  const {
    perResultThreshold = DEFAULT_PERSIST_THRESHOLD,
    perMessageCap = PER_MESSAGE_AGGREGATE_CAP,
    toolResultsDir,
    state,
    onPersist,
  } = options;

  // Pass 1: figure out the replacement string for every block we need
  // to change in this call. Walks each user msg independently — parallel
  // tool results in different msgs don't combine for the aggregate cap.
  const newReplacements = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const candidates = collectCandidates(msg);
    if (candidates.length === 0) continue;

    // Partition by prior decision.
    const fresh: ToolResultCandidate[] = [];
    for (const c of candidates) {
      if (state.replacements.has(c.toolUseId)) {
        // Already replaced — re-apply the cached string. (The block in
        // `msg` might still hold the original content if we're seeing
        // these messages for the first time this turn; the rewrite
        // pass below picks up the cached replacement either way.)
        continue;
      }
      if (state.seenIds.has(c.toolUseId)) {
        // Seen and explicitly left alone before — frozen.
        continue;
      }
      fresh.push(c);
    }

    if (fresh.length === 0) continue;

    // Per-result: anything individually over the threshold gets persisted.
    const toPersist = new Set<string>();
    for (const c of fresh) {
      if (c.size > perResultThreshold) {
        toPersist.add(c.toolUseId);
      }
    }

    // Per-message: if the total (frozen + fresh) still exceeds the cap,
    // pick more from the largest remaining fresh blocks until under.
    const frozenSize = candidates
      .filter((c) => state.seenIds.has(c.toolUseId) && !state.replacements.has(c.toolUseId))
      .reduce((s, c) => s + c.size, 0);
    let projected =
      frozenSize +
      fresh.reduce((s, c) => s + (toPersist.has(c.toolUseId) ? 0 : c.size), 0);
    if (projected > perMessageCap) {
      const remaining = fresh
        .filter((c) => !toPersist.has(c.toolUseId))
        .sort((a, b) => b.size - a.size);
      for (const c of remaining) {
        if (projected <= perMessageCap) break;
        toPersist.add(c.toolUseId);
        projected -= c.size;
      }
    }

    // Persist + mark.
    for (const c of fresh) {
      if (toPersist.has(c.toolUseId)) {
        try {
          const filepath = persistToFile(toolResultsDir, c.toolUseId, c.content);
          const replacement = buildReplacement(filepath, c.size, c.content);
          state.replacements.set(c.toolUseId, replacement);
          newReplacements.set(c.toolUseId, replacement);
          state.seenIds.add(c.toolUseId);
          onPersist?.({
            toolUseId: c.toolUseId,
            filepath,
            originalSize: c.size,
            reason: c.size > perResultThreshold ? "per-result-cap" : "per-message-budget",
          });
        } catch {
          // Persistence failed — leave block untouched, but mark seen so
          // we don't try again next turn (and don't risk flapping if a
          // transient FS issue clears up).
          state.seenIds.add(c.toolUseId);
        }
      } else {
        // Decided "don't persist" → freeze that decision.
        state.seenIds.add(c.toolUseId);
      }
    }
  }

  // Pass 2: rewrite messages. For every tool_result whose id is in
  // state.replacements, swap content for the cached replacement string.
  if (state.replacements.size === 0) return messages;

  let mutated = false;
  const out = messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    let blockChanged = false;
    const newContent = msg.content.map((block) => {
      if (block.type !== "tool_result" || !block.tool_use_id) return block;
      const replacement = state.replacements.get(block.tool_use_id);
      if (replacement === undefined) return block;
      if (block.content === replacement) return block;
      // microcompact may have already cleared this block to a fingerprint.
      // Don't roll it back — that would cause persistence and microcompact
      // to overwrite each other every turn, doing 2 redundant rewrites on
      // a stable end-state. The cleared fingerprint is the legitimate
      // downstream form; leave it alone.
      if (
        typeof block.content === "string" &&
        block.content.startsWith(CLEARED_PREFIX)
      ) {
        return block;
      }
      blockChanged = true;
      return { ...block, content: replacement };
    });
    if (!blockChanged) return msg;
    mutated = true;
    return { ...msg, content: newContent };
  });

  if (mutated && newReplacements.size > 0) {
    logger.info("tool_result.persisted", {
      count: newReplacements.size,
      ids: [...newReplacements.keys()],
    });
  }

  return mutated ? out : messages;
}

/**
 * Public test helper: check whether content already wears the persisted
 * sentinel. Used by tests to assert idempotency.
 */
export function isPersistedReplacement(s: string): boolean {
  return s.startsWith(PERSISTED_OPEN);
}

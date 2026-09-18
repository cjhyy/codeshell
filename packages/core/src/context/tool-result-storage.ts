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
 *   • Raw transcripts stay unchanged. A versioned text-only sidecar freezes
 *     each saved preview, including text-slot positions, for cold replay.
 *
 * Strategy:
 *   • Per-result cap (DEFAULT_PERSIST_THRESHOLD): when a single tool_result
 *     exceeds it, persist + replace.
 *   • Per-message aggregate cap (PER_MESSAGE_AGGREGATE_CAP): when a single
 *     user message's tool_results together exceed it (e.g. a batch of
 *     parallel Read results), persist the largest ones first until under.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { ContentBlock, Message } from "../types.js";
import { logger } from "../logging/logger.js";
import { estimateStringTokens } from "./token-counter.js";
import {
  DEFAULT_TOOL_OUTPUT_TOKEN_LIMIT,
  DEFAULT_TOOL_MESSAGE_TOKEN_LIMIT,
  createToolTextReplacement,
  replaceToolResultText,
  toolResultText,
} from "./tool-output-budget.js";

// ─── Tunables ───────────────────────────────────────────────────────

/** Per-result threshold. Larger than this → persist + replace. */
export const DEFAULT_PERSIST_THRESHOLD = 30_000;

/** Per-message aggregate cap (sum of tool_result content sizes in one user msg). */
export const PER_MESSAGE_AGGREGATE_CAP = 100_000;

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
  /** Text slots are retained for multimodal results; media never enter sidecars. */
  textReplacements?: Map<string, string[]>;
}

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map(), textReplacements: new Map() };
}

/**
 * Rebuild a state object by walking the loaded message history.
 * Used on resume so the budget makes the same decisions it made before.
 * Replacements come from already-reduced messages or the saved model view
 * beside an intact original output when the transcript still contains raw text.
 */
export function reconstructContentReplacementState(
  messages: Message[],
  toolResultsDir?: string,
): ContentReplacementState {
  const state = createContentReplacementState();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      state.seenIds.add(block.tool_use_id);
      const text = toolResultText(block.content);
      if (text?.startsWith(PERSISTED_OPEN)) {
        state.replacements.set(block.tool_use_id, text);
        if (Array.isArray(block.content)) {
          state.textReplacements!.set(block.tool_use_id, textParts(block.content));
        }
      } else if (toolResultsDir && text !== undefined) {
        const saved = readSavedReplacement(toolResultsDir, block.tool_use_id, block.content);
        if (saved) {
          state.replacements.set(block.tool_use_id, saved.replacement);
          if (saved.parts) state.textReplacements!.set(block.tool_use_id, saved.parts);
        }
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
 * Convert an externally supplied tool_use_id to a bounded internal filename.
 * The original id remains the key in ContentReplacementState/onPersist; it is
 * never used as a path component.
 */
export function safeToolResultFilename(toolUseId: string): string {
  if (toolUseId.length > 256) {
    throw new RangeError("tool_use_id exceeds the 256 character limit");
  }
  if (
    isAbsolute(toolUseId) ||
    win32.isAbsolute(toolUseId) ||
    toolUseId.includes("/") ||
    toolUseId.includes("\\")
  ) {
    throw new Error("tool_use_id must not contain a path");
  }
  return `${createHash("sha256").update(toolUseId, "utf8").digest("hex")}.txt`;
}

/** Write content to the contained hashed path. Idempotent by original id. */
function persistToFile(dir: string, toolUseId: string, content: string): string {
  const root = resolve(dir);
  const filename = safeToolResultFilename(toolUseId);
  const filepath = resolve(root, filename);
  const rel = relative(root, filepath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("tool_result path escaped its storage root");
  }
  ensureDir(dir);
  try {
    // 'wx' = fail if exists. Only reuse an existing original if it is complete
    // and identical; an interrupted prior write must not yield a false receipt.
    writeFileSync(filepath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && readFileSync(filepath, "utf8") !== content) {
      throw new Error("Saved tool output does not match this result", { cause: err });
    }
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

interface SavedReplacement {
  replacement: string;
  parts?: string[];
}

function textParts(content: ContentBlock[]): string[] {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!);
}

function buildReplacement(
  filepath: string,
  originalSize: number,
  content: ContentBlock["content"],
): SavedReplacement {
  const preview = createToolTextReplacement(content, { maxChars: PREVIEW_SIZE });
  const header =
    `${PERSISTED_OPEN}\n` +
    `Text output too large (${originalSize} chars). Full output saved to: ${filepath}\n` +
    (Array.isArray(content) ? "Non-text attachments remain in their original positions.\n" : "") +
    `Use Read with offset/limit or Grep on this file for omitted details; do not repeat a write operation to retrieve output.\n\n` +
    `Preview (head and tail):\n`;
  const footer = `\n${PERSISTED_CLOSE}`;
  if (preview.parts?.length) {
    const parts = [...preview.parts];
    parts[0] = header + parts[0];
    parts[parts.length - 1] += footer;
    return { replacement: parts.join("\n\n"), parts };
  }
  return { replacement: header + preview.text + footer };
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Store the exact model view beside the raw output, without changing the transcript. */
function saveReplacement(filepath: string, content: string, saved: SavedReplacement): void {
  const record = JSON.stringify({ version: 1, hash: contentHash(content), ...saved });
  const previewPath = `${filepath}.preview.json`;
  try {
    if (readFileSync(previewPath, "utf8") === record) return;
  } catch {
    // Missing or interrupted previews are replaced below.
  }
  const temporaryPath = `${previewPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, record, { flag: "wx", mode: 0o600 });
    // Commit the complete record at once, also repairing a corrupt sidecar.
    renameSync(temporaryPath, previewPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function readSavedReplacement(
  dir: string,
  toolUseId: string,
  original: ContentBlock["content"],
): SavedReplacement | undefined {
  try {
    const content = toolResultText(original);
    if (content === undefined) return undefined;
    const filepath = join(resolve(dir), safeToolResultFilename(toolUseId));
    const previewPath = `${filepath}.preview.json`;
    if (statSync(previewPath).size > 32_768 || !statSync(filepath).isFile()) return undefined;
    const record = JSON.parse(readFileSync(previewPath, "utf8"));
    const validParts = Array.isArray(original)
      ? Array.isArray(record.parts) &&
        record.parts.length === textParts(original).length &&
        record.parts.every((part: unknown) => typeof part === "string") &&
        record.parts.join("\n\n") === record.replacement
      : record.parts === undefined;
    if (
      record.version === 1 &&
      record.hash === contentHash(content) &&
      validParts &&
      typeof record.replacement === "string" &&
      record.replacement.startsWith(PERSISTED_OPEN) &&
      record.replacement.includes(`Full output saved to: ${filepath}\n`) &&
      readFileSync(filepath, "utf8") === content
    )
      return { replacement: record.replacement, ...(record.parts ? { parts: record.parts } : {}) };
  } catch {
    // Legacy sessions, deleted output files, or interrupted sidecar writes.
  }
  return undefined;
}

// ─── Application ─────────────────────────────────────────────────────

interface ToolResultCandidate {
  toolUseId: string;
  block: ContentBlock;
  content: string;
  size: number;
  tokens: number;
}

function collectCandidates(msg: Message): ToolResultCandidate[] {
  if (!Array.isArray(msg.content)) return [];
  const out: ToolResultCandidate[] = [];
  for (const block of msg.content) {
    if (block.type !== "tool_result" || !block.tool_use_id) continue;
    const content = toolResultText(block.content);
    if (content === undefined) continue;
    // Skip blocks already in a persisted/cleared sentinel — nothing to do
    // and we must not re-persist (would change replacement strings →
    // prompt cache miss).
    if (content.startsWith(PERSISTED_OPEN) || content.startsWith(CLEARED_PREFIX)) continue;
    out.push({
      toolUseId: block.tool_use_id,
      block,
      content,
      size: content.length,
      tokens: estimateStringTokens(content),
    });
  }
  return out;
}

interface PersistOptions {
  /** Per-result threshold; default DEFAULT_PERSIST_THRESHOLD. */
  perResultThreshold?: number;
  /** Per-message aggregate cap; default PER_MESSAGE_AGGREGATE_CAP. */
  perMessageCap?: number;
  /** Estimated text token budgets, shared by all text parts of a result/batch. */
  perResultTokenLimit?: number;
  perMessageTokenLimit?: number;
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
    perResultTokenLimit = DEFAULT_TOOL_OUTPUT_TOKEN_LIMIT,
    perMessageTokenLimit = DEFAULT_TOOL_MESSAGE_TOKEN_LIMIT,
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

    // Include the ACTUAL size of existing previews, not only fresh candidates.
    let projectedChars = 0;
    let projectedTokens = 0;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type !== "tool_result") continue;
      const current = toolResultText(block.content);
      const text = current?.startsWith(CLEARED_PREFIX)
        ? current
        : ((block.tool_use_id ? state.replacements.get(block.tool_use_id) : undefined) ?? current);
      if (text === undefined) continue;
      projectedChars += text.length;
      projectedTokens += estimateStringTokens(text);
    }
    const oversized = (c: ToolResultCandidate) =>
      c.size > perResultThreshold || c.tokens > perResultTokenLimit;
    const persist = (c: ToolResultCandidate, reason: "per-result-cap" | "per-message-budget") => {
      try {
        const filepath = persistToFile(toolResultsDir, c.toolUseId, c.content);
        const saved =
          readSavedReplacement(toolResultsDir, c.toolUseId, c.block.content) ??
          buildReplacement(filepath, c.size, c.block.content);
        const { replacement, parts } = saved;
        // Very small results must not grow just because a batch is over budget.
        if (reason === "per-message-budget" && replacement.length >= c.size) return;
        saveReplacement(filepath, c.content, saved);
        state.replacements.set(c.toolUseId, replacement);
        if (parts) (state.textReplacements ??= new Map()).set(c.toolUseId, parts);
        newReplacements.set(c.toolUseId, replacement);
        projectedChars -= c.size - replacement.length;
        projectedTokens -= c.tokens - estimateStringTokens(replacement);
        onPersist?.({ toolUseId: c.toolUseId, filepath, originalSize: c.size, reason });
      } catch {
        // The in-context backstop still applies if saving the original fails.
      } finally {
        state.seenIds.add(c.toolUseId);
      }
    };
    for (const c of fresh.filter(oversized)) persist(c, "per-result-cap");
    const remaining = fresh
      .filter((c) => !oversized(c))
      .sort(
        (a, b) =>
          Math.max(b.size / perMessageCap, b.tokens / perMessageTokenLimit) -
          Math.max(a.size / perMessageCap, a.tokens / perMessageTokenLimit),
      );
    for (const c of remaining) {
      if (projectedChars <= perMessageCap && projectedTokens <= perMessageTokenLimit) break;
      persist(c, "per-message-budget");
    }
    for (const c of fresh) state.seenIds.add(c.toolUseId);
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
      const text = toolResultText(block.content);
      if (text === replacement) return block;
      // microcompact may have already cleared this block to a fingerprint.
      // Don't roll it back — that would cause persistence and microcompact
      // to overwrite each other every turn, doing 2 redundant rewrites on
      // a stable end-state. The cleared fingerprint is the legitimate
      // downstream form; leave it alone.
      if (text?.startsWith(CLEARED_PREFIX)) {
        return block;
      }
      blockChanged = true;
      return {
        ...block,
        content: replaceToolResultText(
          block.content,
          replacement,
          state.textReplacements?.get(block.tool_use_id),
        ),
      };
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

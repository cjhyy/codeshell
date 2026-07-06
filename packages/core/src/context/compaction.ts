/**
 * Context compaction strategies.
 *
 * Tier 0: truncateToolResult — truncate oversized individual results
 * Tier 1: microcompact — zero-cost, clears old tool_result content
 * Tier 2: LLM summary — generates summary via model call (async)
 * Tier 3: window compact — keeps first + last N messages (sync fallback)
 * Emergency: dropOldestRounds — progressive API-round-based truncation
 *
 * All slicing functions use adjustIndexToPreserveAPIInvariants()
 * to prevent splitting tool_use / tool_result pairs.
 */

import type { ContentBlock, Message } from "../types.js";
import { estimateMessagesTokens } from "./token-counter.js";

/**
 * Estimate token count from messages.
 * Uses per-block-type estimation with 33% overhead padding.
 */
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(estimateMessagesTokens(messages) * (4 / 3));
}

export const IMAGE_HISTORY_PLACEHOLDER_PREFIX = "[image #";
export const IMAGE_HISTORY_PLACEHOLDER_SUFFIX = ", 已处理 / already provided earlier]";

interface ImagePreserveSet {
  has(message: Message): boolean;
}

export interface DowngradeImageHistoryOptions {
  /**
   * Messages whose image payloads are being sent for their first model
   * consumption in this request. They still count toward image numbering but
   * keep their base64 until the caller clears the preserve set after a
   * successful model response.
   */
  preserveMessages?: ImagePreserveSet;
}

export interface DowngradeImageHistoryResult {
  messages: Message[];
  replacedCount: number;
}

/**
 * Replace already-consumed image payload blocks with compact text markers.
 *
 * The transcript may retain the full image bytes for rendering/resume, but the
 * working message history sent to the model should not re-send base64 after the
 * model has seen it once. This handles both our internal Anthropic-style image
 * blocks and OpenAI-style data-url image blocks defensively, including images
 * nested inside tool_result.content arrays (view_image / browser screenshots).
 */
export function downgradeImagePayloadsInHistory(
  messages: Message[],
  options: DowngradeImageHistoryOptions = {},
): DowngradeImageHistoryResult {
  let nextImageNumber = 1;
  let replacedCount = 0;
  let changed = false;

  const placeholderFor = (imageNumber: number): ContentBlock => ({
    type: "text",
    text: `${IMAGE_HISTORY_PLACEHOLDER_PREFIX}${imageNumber}${IMAGE_HISTORY_PLACEHOLDER_SUFFIX}`,
  });

  const transformBlocks = (
    blocks: ContentBlock[],
    preserve: boolean,
  ): { blocks: ContentBlock[]; changed: boolean } => {
    let blocksChanged = false;
    const out = blocks.map((block) => {
      const placeholderNumber = imageHistoryPlaceholderNumber(block);
      if (placeholderNumber !== undefined) {
        nextImageNumber = Math.max(nextImageNumber, placeholderNumber + 1);
        return block;
      }

      if (isBase64ImageBlock(block)) {
        const imageNumber = nextImageNumber++;
        if (preserve) return block;
        replacedCount++;
        blocksChanged = true;
        return placeholderFor(imageNumber);
      }

      if (block.type === "tool_result" && Array.isArray(block.content)) {
        const nested = transformBlocks(block.content, preserve);
        if (nested.changed) {
          blocksChanged = true;
          return { ...block, content: nested.blocks };
        }
      }

      return block;
    });

    return { blocks: blocksChanged ? out : blocks, changed: blocksChanged };
  };

  const out = messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    const preserve = options.preserveMessages?.has(msg) === true;
    const result = transformBlocks(msg.content, preserve);
    if (!result.changed) return msg;
    changed = true;
    return { ...msg, content: result.blocks };
  });

  return { messages: changed ? out : messages, replacedCount };
}

export function messageHasBase64ImagePayload(message: Message): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some(blockHasBase64ImagePayload);
}

function blockHasBase64ImagePayload(block: ContentBlock): boolean {
  if (isBase64ImageBlock(block)) return true;
  return (
    block.type === "tool_result" &&
    Array.isArray(block.content) &&
    block.content.some(blockHasBase64ImagePayload)
  );
}

function imageHistoryPlaceholderNumber(block: ContentBlock): number | undefined {
  if (block.type !== "text" || typeof block.text !== "string") return undefined;
  const escapedPrefix = IMAGE_HISTORY_PLACEHOLDER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedSuffix = IMAGE_HISTORY_PLACEHOLDER_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.text.match(new RegExp(`^${escapedPrefix}(\\d+)${escapedSuffix}$`));
  if (!match?.[1]) return undefined;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function isBase64ImageBlock(block: ContentBlock): boolean {
  if (
    block.type === "image" &&
    block.source?.type === "base64" &&
    typeof block.source.data === "string" &&
    block.source.data.length > 0
  ) {
    return true;
  }

  const maybeOpenAI = block as unknown as {
    type?: string;
    image_url?: { url?: string };
  };
  return (
    maybeOpenAI.type === "image_url" &&
    typeof maybeOpenAI.image_url?.url === "string" &&
    /^data:image\/[^;,]+;base64,/i.test(maybeOpenAI.image_url.url)
  );
}

/**
 * Reconcile user-supplied compaction ratios into a safe ordering.
 *
 * The three tiers must satisfy `floor < compact < summarize` or the manager
 * fires them in the wrong order (e.g. an emergency window-compact before the
 * cheaper summary). Users edit these freely in settings.json, so we clamp
 * rather than trust: summarize is pulled up to at least compact, floor is
 * pushed down to at most compact. Absent fields are left undefined so the
 * ContextManager keeps its own default for them.
 */
export function clampContextRatios(input: {
  compactAtRatio?: number;
  summarizeAtRatio?: number;
  microcompactFloorRatio?: number;
}): {
  compactAtRatio?: number;
  summarizeAtRatio?: number;
  microcompactFloorRatio?: number;
} {
  const compact = input.compactAtRatio;
  const summarize =
    input.summarizeAtRatio !== undefined && compact !== undefined
      ? Math.max(input.summarizeAtRatio, compact)
      : input.summarizeAtRatio;
  const floor =
    input.microcompactFloorRatio !== undefined && compact !== undefined
      ? Math.min(input.microcompactFloorRatio, compact)
      : input.microcompactFloorRatio;
  return {
    compactAtRatio: compact,
    summarizeAtRatio: summarize,
    microcompactFloorRatio: floor,
  };
}

// ─── Tool Use / Result Pair Protection ──────────────────────────────

/**
 * Expand a slice start-index backwards so that every tool_result in the
 * kept range has its corresponding tool_use in the kept range too.
 *
 * Without this, windowCompact / applySummaryCompaction can produce
 * messages where tool_result references a tool_use_id that was
 * compacted away, causing an API validation error.
 */
export function adjustIndexToPreserveAPIInvariants(
  messages: Message[],
  startIndex: number,
): number {
  let adjusted = startIndex;

  // Collect all tool_use_ids referenced by tool_results in the kept range
  const neededToolUseIds = new Set<string>();
  for (let i = adjusted; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        neededToolUseIds.add(block.tool_use_id);
      }
    }
  }

  // Remove IDs that are already in the kept range
  for (let i = adjusted; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        neededToolUseIds.delete(block.id);
      }
    }
  }

  if (neededToolUseIds.size === 0) return adjusted;

  // Search backwards for assistant messages containing needed tool_use blocks
  for (let i = adjusted - 1; i >= 0 && neededToolUseIds.size > 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id && neededToolUseIds.has(block.id)) {
        neededToolUseIds.delete(block.id);
        if (i < adjusted) adjusted = i;
      }
    }
  }

  return adjusted;
}

/**
 * Snip strategy: keep first N + last M messages, replace middle with a marker.
 * Less aggressive than windowCompact — preserves initial context AND recent history.
 * Uses adjustIndexToPreserveAPIInvariants on both boundaries.
 */
export function snipCompact(
  messages: Message[],
  keepFirstN = 3,
  keepLastM = 8,
): Message[] {
  if (messages.length <= keepFirstN + keepLastM + 1) return messages;

  // Adjust last-M boundary to preserve tool pairs
  let lastStart = messages.length - keepLastM;
  lastStart = adjustIndexToPreserveAPIInvariants(messages, lastStart);

  // Ensure we don't overlap with the first-N range
  if (lastStart <= keepFirstN) return messages;

  const snippedCount = lastStart - keepFirstN;
  const snipMarker: Message = {
    role: "user",
    content:
      `<system-reminder>[${snippedCount} messages snipped to save context. ` +
      `Use the transcript file to review details if needed.]</system-reminder>`,
  };

  return [
    ...messages.slice(0, keepFirstN),
    snipMarker,
    ...messages.slice(lastStart),
  ];
}

/**
 * Window strategy: keep first message + last N messages.
 * Uses adjustIndexToPreserveAPIInvariants to avoid splitting tool pairs.
 */
export function windowCompact(messages: Message[], keepLastN: number): Message[] {
  if (messages.length <= keepLastN + 1) return messages;

  let startIndex = messages.length - keepLastN;
  startIndex = adjustIndexToPreserveAPIInvariants(messages, startIndex);

  // Always keep first message (system context / user's initial prompt)
  if (startIndex <= 1) return messages;
  return [messages[0], ...messages.slice(startIndex)];
}

/**
 * Tools whose results are safe to clear during microcompact.
 *
 * Tracks the CC `COMPACTABLE_TOOLS` set: only "data-fetching" tools where the
 * result is reconstructible (re-Read, re-Glob, re-Bash). Orchestration tools
 * (TaskCreate / TaskUpdate / Agent / Skill / etc.) are excluded — their
 * results carry conversation state the model needs to keep referencing.
 */
export const COMPACTABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "Bash",
  "PowerShell",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "REPL",
]);

/**
 * Build a tool_use_id → tool name map from the assistant messages preceding
 * the tool_results. tool_use always appears before its tool_result, so this
 * walk lets us decide per-result whether it's compactable.
 */
function buildToolUseIdToNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id && block.name) {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

/**
 * Short fingerprint of the original call so cleared results still tell the
 * model what was here. Picks the most useful arg keys per tool, falls back
 * to a generic JSON preview. Caps total length so we don't reintroduce bulk.
 */
function summarizeToolCallArgs(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): string {
  if (!input || typeof input !== "object") return "";
  const pick = (keys: string[]): string => {
    const parts: string[] = [];
    for (const key of keys) {
      const v = (input as Record<string, unknown>)[key];
      if (typeof v === "string" && v.length > 0) {
        parts.push(`${key}=${v.length > 80 ? v.slice(0, 77) + "..." : v}`);
      }
    }
    return parts.join(" ");
  };

  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return pick(["file_path", "path", "notebook_path"]);
    case "Glob":
    case "Grep":
      return pick(["pattern", "path", "glob"]);
    case "Bash":
    case "PowerShell":
    case "REPL":
      return pick(["command"]);
    case "WebFetch":
    case "WebSearch":
      return pick(["url", "query"]);
    default: {
      const json = JSON.stringify(input);
      return json.length > 100 ? json.slice(0, 97) + "..." : json;
    }
  }
}

export interface MicrocompactOptions {
  /** Keep this many most-recent compactable tool-result rounds untouched. */
  keepRecentN?: number;
  /** Tool names whose results may be cleared. Defaults to COMPACTABLE_TOOL_NAMES. */
  compactableTools?: ReadonlySet<string>;
  /** Optional callback invoked once when any clearing actually happened. */
  onClear?: (info: { clearedRounds: number; toolNames: string[] }) => void;
}

/**
 * Remove old tool_result content (microcompact).
 *
 * For each tool_result block older than the most-recent N compactable rounds,
 * replaces its content with a short fingerprint of the originating call
 * (e.g. `[Old tool result cleared — Read file_path=/.../foo.ts]`) so the
 * model can decide whether it's worth re-running the tool instead of
 * guessing what it had seen.
 *
 * Behavior changes vs. earlier versions:
 *  - Only clears whitelisted tool names (Read/Glob/Bash/...). Orchestration
 *    tool results (TaskCreate/TaskUpdate/Agent/etc.) are left intact.
 *  - "Round" count is per *compactable* result, not per message with any
 *    tool_result. A round containing only TaskUpdate doesn't count toward N.
 *  - Replacement string includes tool name + key args so the model isn't
 *    forced into blind re-Reads (which then trip the Investigation guard).
 */
export function microcompact(
  messages: Message[],
  options: MicrocompactOptions = {},
): Message[] {
  const keepRecentN = options.keepRecentN ?? 5;
  const compactable = options.compactableTools ?? COMPACTABLE_TOOL_NAMES;

  const idToName = buildToolUseIdToNameMap(messages);
  const idToInput = new Map<string, Record<string, unknown> | undefined>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        idToInput.set(block.id, block.input);
      }
    }
  }

  // Walk back, counting only compactable rounds. A round is a message that
  // contains at least one *eligible* tool_result we haven't cleared yet.
  let compactableRoundCount = 0;
  const indicesToTouch: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    const hasEligible = msg.content.some(
      (b) =>
        b.type === "tool_result" &&
        b.tool_use_id != null &&
        compactable.has(idToName.get(b.tool_use_id) ?? "") &&
        typeof b.content === "string" &&
        !b.content.startsWith("[Old tool result cleared"),
    );
    if (!hasEligible) continue;
    compactableRoundCount++;
    if (compactableRoundCount > keepRecentN) {
      indicesToTouch.push(i);
    }
  }

  if (indicesToTouch.length === 0) return messages;

  const touchSet = new Set(indicesToTouch);
  const clearedToolNames = new Set<string>();
  let clearedBlocks = 0;

  const result = messages.map((msg, i) => {
    if (!touchSet.has(i) || !Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.map((block) => {
        if (block.type !== "tool_result" || !block.tool_use_id) return block;
        const toolName = idToName.get(block.tool_use_id);
        if (!toolName || !compactable.has(toolName)) return block;
        if (typeof block.content !== "string") return block;
        if (block.content.startsWith("[Old tool result cleared")) return block;
        const argsSummary = summarizeToolCallArgs(toolName, idToInput.get(block.tool_use_id));
        const fingerprint = argsSummary
          ? `[Old tool result cleared — ${toolName} ${argsSummary}]`
          : `[Old tool result cleared — ${toolName}]`;
        clearedToolNames.add(toolName);
        clearedBlocks++;
        return { ...block, content: fingerprint };
      }),
    };
  });

  if (clearedBlocks > 0) {
    options.onClear?.({
      clearedRounds: indicesToTouch.length,
      toolNames: [...clearedToolNames].sort(),
    });
  }

  return result;
}

/** Tools whose result is the content of a single file, keyed by path. */
const FILE_READ_TOOLS: ReadonlySet<string> = new Set(["Read"]);

export interface DedupeFileReadsResult {
  messages: Message[];
  /** How many stale Read results were cleared. */
  clearedCount: number;
}

/**
 * Content-aware dedup: when the SAME file is Read more than once, every Read
 * result except the most recent is stale — the file's current state is in the
 * latest read. Clear the older ones (replace with a fingerprint pointing at
 * the newer read) regardless of the recency window or pressure floor, because
 * this is pure waste removal, not lossy compaction: the model never needs two
 * copies of the same file.
 *
 * Distinct from microcompact (which is recency-gated and pressure-gated): a
 * file Read 3 times in the last 3 turns keeps 3 full copies under microcompact
 * but only the newest under this pass. Zero-cost and always safe to run, so the
 * ContextManager calls it as an early tier.
 *
 * Only `Read` is deduped (its result is exactly the file content). Edit/Write
 * results are diffs/confirmations, not full snapshots, so they're left alone.
 */
export function dedupeFileReads(messages: Message[]): DedupeFileReadsResult {
  const idToName = buildToolUseIdToNameMap(messages);
  const idToInput = new Map<string, Record<string, unknown> | undefined>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) idToInput.set(block.id, block.input);
    }
  }

  // Resolve a Read tool_use_id to its file_path arg (the dedup key).
  const pathOf = (toolUseId: string): string | undefined => {
    const input = idToInput.get(toolUseId);
    const p = input?.file_path ?? input?.path;
    return typeof p === "string" && p.length > 0 ? p : undefined;
  };

  // Collect, per file path, the message indices + block positions of every
  // non-cleared Read result. Walk forward so "last" is the newest.
  const byPath = new Map<string, Array<{ msgIdx: number; toolUseId: string }>>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      if (!FILE_READ_TOOLS.has(idToName.get(block.tool_use_id) ?? "")) continue;
      if (typeof block.content !== "string") continue;
      if (block.content.startsWith("[Old tool result cleared")) continue;
      const path = pathOf(block.tool_use_id);
      if (!path) continue;
      const list = byPath.get(path) ?? [];
      list.push({ msgIdx: i, toolUseId: block.tool_use_id });
      byPath.set(path, list);
    }
  }

  // For each path read more than once, mark all-but-last for clearing.
  const clearIds = new Set<string>();
  for (const [, reads] of byPath) {
    if (reads.length < 2) continue;
    for (let k = 0; k < reads.length - 1; k++) clearIds.add(reads[k].toolUseId);
  }
  if (clearIds.size === 0) return { messages, clearedCount: 0 };

  let clearedCount = 0;
  const result = messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.map((block) => {
        if (block.type !== "tool_result" || !block.tool_use_id) return block;
        if (!clearIds.has(block.tool_use_id)) return block;
        const argsSummary = summarizeToolCallArgs("Read", idToInput.get(block.tool_use_id));
        clearedCount++;
        return {
          ...block,
          content: `[Old tool result cleared — superseded by a newer Read${argsSummary ? ` of ${argsSummary}` : ""}]`,
        };
      }),
    };
  });

  return { messages: result, clearedCount };
}

/** Build id → true for tool_use blocks that are a browser snapshot observation,
 *  i.e. `browser_observe` with mode "snapshot" (the default when mode omitted).
 *  Only snapshots produce large, supersede-able element lists worth masking. */
function buildSnapshotObserveIdSet(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use" || !block.id || block.name !== "browser_observe") continue;
      const mode = (block.input as { mode?: string } | undefined)?.mode;
      if (mode === undefined || mode === "snapshot") ids.add(block.id);
    }
  }
  return ids;
}

const OLD_SNAPSHOT_PLACEHOLDER =
  "[Old browser snapshot collapsed — superseded by a newer browser_observe(snapshot). " +
  "Re-run browser_observe for the current page's elements.]";

/**
 * Observation masking for browser_observe(snapshot) results (the research's
 * highest-leverage browser-token saving: a page snapshot is large and only the
 * LATEST one matters for the next decision; older ones are stale element lists).
 * Keep the most recent snapshot result verbatim; replace every earlier one with
 * a one-line placeholder. Deterministic — no LLM summarization needed.
 *
 * Keyed on the snapshot OBSERVATION (browser_observe with mode snapshot) — read/
 * extract observations and act results are left untouched. Renamed from
 * maskOldBrowserSnapshots when the 9 browser_* tools collapsed into 3.
 */
export function maskOldObservations(messages: Message[]): { messages: Message[]; maskedCount: number } {
  const snapshotIds = buildSnapshotObserveIdSet(messages);
  const snapResults: string[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      if (!snapshotIds.has(block.tool_use_id)) continue;
      if (typeof block.content !== "string") continue;
      if (block.content.startsWith("[Old browser snapshot collapsed")) continue;
      snapResults.push(block.tool_use_id);
    }
  }
  if (snapResults.length < 2) return { messages, maskedCount: 0 };

  // Mask all but the last (newest walked-forward).
  const maskIds = new Set(snapResults.slice(0, -1));
  let maskedCount = 0;
  const result = messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.map((block) => {
        if (block.type !== "tool_result" || !block.tool_use_id) return block;
        if (!maskIds.has(block.tool_use_id)) return block;
        maskedCount++;
        return { ...block, content: OLD_SNAPSHOT_PLACEHOLDER };
      }),
    };
  });
  return { messages: result, maskedCount };
}

/**
 * Apply aggregate per-message tool result budget.
 * When total tool_result content in a single message exceeds maxTotalChars,
 * truncates the largest results first with a notice.
 */
export function applyToolResultBudget(messages: Message[], maxTotalChars = 100_000): Message[] {
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;

    // Collect tool_result blocks with their sizes
    const resultBlocks: Array<{ index: number; size: number }> = [];
    let totalSize = 0;

    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i];
      if (block.type === "tool_result" && typeof block.content === "string") {
        const size = block.content.length;
        resultBlocks.push({ index: i, size });
        totalSize += size;
      }
    }

    if (totalSize <= maxTotalChars || resultBlocks.length === 0) return msg;

    // Sort by size descending — truncate largest first
    resultBlocks.sort((a, b) => b.size - a.size);

    // Build the exact replacement for a block, so the running budget uses the
    // real post-truncation length (the old code assumed a flat ~200 chars,
    // but the replacement is ~150 boilerplate + up to 500 preview ≈ 650+,
    // which under-truncated and could even leave the message LARGER).
    const truncate = (content: string): string => {
      const preview = content.slice(0, 500);
      const sizeKb = (content.length / 1000).toFixed(0);
      return (
        `Output too large (${sizeKb}KB) — truncated to fit the per-message budget. ` +
        `Re-run the originating tool if you need the full output.\n\n` +
        `Preview (first 500 chars):\n${preview}`
      );
    };

    let remaining = totalSize;
    const replacements = new Map<number, string>();

    for (const rb of resultBlocks) {
      if (remaining <= maxTotalChars) break;
      const original = msg.content[rb.index]!.content as string;
      const replaced = truncate(original);
      // Only truncate if it actually shrinks the block; otherwise skip it
      // (truncating a barely-oversized block would grow the message).
      if (replaced.length >= rb.size) continue;
      replacements.set(rb.index, replaced);
      remaining -= rb.size - replaced.length;
    }

    if (replacements.size === 0) return msg;

    const newContent = msg.content.map((block, i) => {
      const replaced = replacements.get(i);
      return replaced === undefined ? block : { ...block, content: replaced };
    });

    return { ...msg, content: newContent };
  });
}

/**
 * Truncate a single tool result if it exceeds the character limit.
 * Returns the truncated string with a notice.
 */
export function truncateToolResult(result: string, maxChars = 30_000): string {
  if (result.length <= maxChars) return result;

  // Keep head and tail for context
  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = Math.floor(maxChars * 0.2);
  const head = result.slice(0, headSize);
  const tail = result.slice(-tailSize);

  return (
    head +
    `\n\n... [${result.length - headSize - tailSize} characters truncated] ...\n\n` +
    tail
  );
}

/**
 * Build a structured summarization prompt from messages to be compacted.
 * Produces a 9-section summary preserving key details.
 */
export function buildSummarizationPrompt(
  messagesToSummarize: Message[],
  priorSummary?: string,
): string {
  const parts: string[] = [];

  for (const msg of messagesToSummarize) {
    if (typeof msg.content === "string") {
      parts.push(`[${msg.role}]: ${msg.content.slice(0, 3000)}`);
    } else {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          parts.push(`[${msg.role}]: ${block.text.slice(0, 3000)}`);
        } else if (block.type === "tool_use") {
          const args = JSON.stringify(block.input).slice(0, 500);
          parts.push(`[tool_use]: ${block.name}(${args})`);
        } else if (block.type === "tool_result") {
          const content = typeof block.content === "string" ? block.content : "";
          parts.push(`[tool_result]: ${content.slice(0, 1500)}`);
        }
      }
    }
  }

  const sectionList =
    "1. **Primary Request**: What the user originally asked for\n" +
    "2. **Key Concepts**: Important technical terms, patterns, file paths\n" +
    "3. **Files Referenced**: List of files read/edited with key content\n" +
    "4. **Errors & Fixes**: Any errors encountered and how they were resolved\n" +
    "5. **Actions Taken**: Tools used and their outcomes\n" +
    "6. **User Messages**: All distinct user requests (verbatim if short)\n" +
    "7. **Pending Tasks**: Anything started but not finished\n" +
    "8. **Current State**: Where things stand right now\n" +
    "9. **Next Steps**: What should happen next\n";

  if (priorSummary) {
    return (
      "You are updating an anchored conversation summary. A prior summary is " +
      "shown first, followed by NEW conversation that occurred after that " +
      "summary was produced. Produce an UPDATED summary that:\n" +
      "- Preserves every critical fact from the prior summary (file paths, " +
      "decisions, the user's original intent, errors that were fixed)\n" +
      "- Merges in new facts from the new conversation\n" +
      "- Resolves contradictions in favor of the newer information\n" +
      "- Stays in the same 9-section structure below\n" +
      "- Is factual; preserves file paths, function names, and error " +
      "messages exactly\n\n" +
      sectionList +
      "\n=== Prior summary ===\n" +
      priorSummary +
      "\n\n=== New conversation ===\n\n" +
      parts.join("\n")
    );
  }

  return (
    "Summarize the following conversation into these sections. " +
    "Be factual. Preserve file paths, function names, and error messages exactly.\n\n" +
    sectionList +
    "\nConversation:\n\n" +
    parts.join("\n")
  );
}

// ─── Anchored summary marker ────────────────────────────────────────
//
// applySummaryCompaction wraps the LLM-generated summary in these tags so the
// next compaction pass can grep it out and ask the LLM to merge-update it
// (rolling summary), instead of re-summarizing from scratch each time. The
// marker also survives session resume: messages persist via the session
// transcript, so a process restart can still recover the latest summary
// without needing a side-channel state file.

const ANCHORED_OPEN = "<anchored-summary>";
const ANCHORED_CLOSE = "</anchored-summary>";

export function extractAnchoredSummary(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content) continue;
    const start = content.indexOf(ANCHORED_OPEN);
    if (start < 0) continue;
    const end = content.indexOf(ANCHORED_CLOSE, start + ANCHORED_OPEN.length);
    if (end <= start) continue;
    return content.slice(start + ANCHORED_OPEN.length, end).trim();
  }
  return undefined;
}

/**
 * Apply LLM-generated summary compaction (hybrid mode).
 *
 * Instead of eagerly restoring file contents (wastes tokens), gives the
 * model a summary + the transcript path so it can Read on demand.
 * Also lists recently-referenced files so the model knows what to re-read.
 */
export function applySummaryCompaction(
  messages: Message[],
  summary: string,
  keepRecentN: number,
  transcriptPath?: string,
): Message[] {
  if (messages.length <= keepRecentN + 2) return messages;

  // Adjust slice point to preserve tool pairs
  let startIndex = messages.length - keepRecentN;
  startIndex = adjustIndexToPreserveAPIInvariants(messages, startIndex);
  if (startIndex <= 1) return messages;

  const first = messages[0];
  const compactedMessages = messages.slice(1, startIndex);
  const recent = messages.slice(startIndex);

  // Extract file paths (not contents) that were referenced before compaction
  const referencedFiles = extractReferencedFilePaths(compactedMessages);

  let body =
    `This session is being continued from a previous conversation that ran out of context. ` +
    `The summary below covers the earlier portion of the conversation.\n\n` +
    `${ANCHORED_OPEN}\n${summary}\n${ANCHORED_CLOSE}`;

  if (transcriptPath) {
    body +=
      `\n\nIf you need specific details from before compaction (like exact code snippets, ` +
      `error messages, or content you generated), read the full transcript at: ${transcriptPath}`;
  }

  if (referencedFiles.length > 0) {
    body +=
      `\n\nFiles referenced before compaction (use Read tool if you need their current content):\n` +
      referencedFiles.map((f) => `- ${f}`).join("\n");
  }

  body += `\n\nRecent messages are preserved verbatim below. Continue from where you left off.`;

  const summaryMsg: Message = {
    role: "user",
    content: `<system-reminder>${body}</system-reminder>`,
  };

  return [first, summaryMsg, ...recent];
}

// ─── API Round Grouping & Progressive Recovery ──────────────────────

/**
 * Group messages by API round-trip boundaries.
 * Each group represents one complete assistant response + its tool results.
 */
export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let current: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && current.length > 0) {
      // New assistant message = new API round
      groups.push(current);
      current = [msg];
    } else {
      current.push(msg);
    }
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Drop the oldest API rounds from messages, preserving tool pairs.
 * Used for progressive prompt-too-long recovery.
 */
export function dropOldestRounds(messages: Message[], roundsToDrop: number): Message[] {
  const groups = groupMessagesByApiRound(messages);
  if (groups.length <= roundsToDrop + 1) {
    // Can't drop that many — keep at least the last group
    return groups[groups.length - 1];
  }

  const kept = groups.slice(roundsToDrop).flat();

  // Ensure tool pair safety
  const safeStart = adjustIndexToPreserveAPIInvariants(
    kept,
    0, // already sliced, just validate from start
  );

  const result = kept.slice(safeStart);

  // If first message is assistant, prepend synthetic user message
  if (result.length > 0 && result[0].role === "assistant") {
    result.unshift({
      role: "user",
      content: "<system-reminder>Earlier conversation context was removed to fit within the context window. Continue from the assistant's response below.</system-reminder>",
    });
  }

  return result;
}

// ─── Post-Compaction: Lightweight File Path Extraction ──────────────

/**
 * Extract file paths that were referenced (Read/Edit/Write) in compacted
 * messages. Returns paths only — the model uses Read tool on demand.
 */
export function extractReferencedFilePaths(messages: Message[]): string[] {
  const paths = new Set<string>();
  const FILE_TOOLS = new Set(["Read", "Edit", "Write", "Glob", "Grep"]);

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.name && FILE_TOOLS.has(block.name) && block.input) {
        const input = block.input as Record<string, unknown>;
        const fp = (input.file_path ?? input.path) as string | undefined;
        if (fp) paths.add(fp);
      }
    }
  }

  return [...paths];
}

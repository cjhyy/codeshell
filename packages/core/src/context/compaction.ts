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

import type { Message } from "../types.js";
import { estimateMessagesTokens } from "./token-counter.js";

/**
 * Estimate token count from messages.
 * Uses per-block-type estimation with 33% overhead padding.
 */
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(estimateMessagesTokens(messages) * (4 / 3));
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

    let remaining = totalSize;
    const toTruncate = new Set<number>();

    for (const rb of resultBlocks) {
      if (remaining <= maxTotalChars) break;
      toTruncate.add(rb.index);
      remaining -= rb.size;
      remaining += 200; // truncated replacement is ~200 chars
    }

    if (toTruncate.size === 0) return msg;

    const newContent = msg.content.map((block, i) => {
      if (!toTruncate.has(i)) return block;
      const preview = typeof block.content === "string" ? block.content.slice(0, 500) : "";
      const sizeKb = ((block.content as string).length / 1000).toFixed(0);
      return {
        ...block,
        content:
          `Output too large (${sizeKb}KB) — truncated to fit the per-message budget. ` +
          `Re-run the originating tool if you need the full output.\n\n` +
          `Preview (first 500 chars):\n${preview}`,
      };
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

import type { ContentBlock } from "../types.js";
import { estimateStringTokens } from "./token-counter.js";

/** Estimates, not a provider tokenizer contract. Character limits still apply. */
export const DEFAULT_TOOL_OUTPUT_TOKEN_LIMIT = 10_000;
export const DEFAULT_TOOL_MESSAGE_TOKEN_LIMIT = 20_000;
export const TOOL_OUTPUT_TRUNCATED = "[... tool output truncated ...]";

export interface ToolOutputBudget {
  maxChars: number;
  maxTokens?: number;
}

export interface ToolTextReplacement {
  text: string;
  /** One string for each original text slot, in its original position. */
  parts?: string[];
}

/** Text parts share one budget; images and other typed blocks are not text. */
export function toolResultText(content: ContentBlock["content"]): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.filter((part) => part.type === "text" && typeof part.text === "string");
  return texts.length ? texts.map((part) => part.text).join("\n\n") : undefined;
}

/** Keep non-text blocks, including their order and identity, when text is reduced. */
export function replaceToolResultText(
  content: ContentBlock["content"],
  replacement: string,
  parts?: string[],
): ContentBlock["content"] {
  if (!Array.isArray(content)) return replacement;
  const slots = content.filter((part) => part.type === "text" && typeof part.text === "string");
  // A legacy scalar replacement is unambiguous only for one text slot. Never
  // move a later image caption into an earlier slot to guess a multi-part view.
  const replacements = parts ?? (slots.length === 1 ? [replacement] : undefined);
  if (!replacements || replacements.length !== slots.length) return content;
  let textIndex = 0;
  return content.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    const text = replacements[textIndex++]!;
    return part.text === text ? part : { ...part, text };
  });
}

/** Share a bounded allowance, retaining short slots before splitting the remainder. */
function allocateBudget(sizes: number[], total: number): number[] {
  if (!Number.isFinite(total)) return sizes.slice();
  let remaining = Math.max(0, Math.floor(total));
  const order = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
  const allocations = sizes.map(() => 0);
  for (let i = 0; i < order.length; i++) {
    const slot = order[i]!;
    const allowance = Math.min(slot.size, Math.floor(remaining / (order.length - i)));
    allocations[slot.index] = allowance;
    remaining -= allowance;
  }
  return allocations;
}

/** Reduce text in place across its existing slots; media never changes position. */
export function createToolTextReplacement(
  content: ContentBlock["content"],
  budget: ToolOutputBudget,
): ToolTextReplacement {
  if (!Array.isArray(content)) {
    return { text: truncateToolOutput(typeof content === "string" ? content : "", budget) };
  }
  const originalParts = content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!);
  const originalText = originalParts.join("\n\n");
  if (!exceedsToolOutputBudget(originalText, budget)) {
    return { text: originalText, parts: originalParts };
  }
  const separatorChars = Math.max(0, originalParts.length - 1) * 2;
  const separatorTokens = estimateStringTokens("\n".repeat(separatorChars));
  const availableTokens =
    budget.maxTokens === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, budget.maxTokens - separatorTokens);
  const originalDensity = estimateStringTokens(originalText) / Math.max(1, originalText.length);
  let availableChars = Math.max(
    0,
    Math.floor(
      Math.min(
        budget.maxChars - separatorChars,
        availableTokens / Math.max(originalDensity, Number.EPSILON),
      ),
    ),
  );
  if (!Number.isFinite(availableChars)) availableChars = 0;
  const sizes = originalParts.map((part) => part.length);
  const tokenAllocations = allocateBudget(originalParts.map(estimateStringTokens), availableTokens);
  for (;;) {
    const charAllocations = allocateBudget(sizes, availableChars);
    const parts = originalParts.map((part, index) =>
      truncateToolOutput(part, {
        maxChars: charAllocations[index]!,
        maxTokens: tokenAllocations[index]!,
      }),
    );
    const text = parts.join("\n\n");
    if (!exceedsToolOutputBudget(text, budget) || availableChars === 0) return { text, parts };
    // Content heuristics can change when text is shortened. Check the actual
    // joined view and retry from original slots, never from an earlier preview.
    availableChars = Math.floor(availableChars * 0.75);
  }
}

export function exceedsToolOutputBudget(text: string, budget: ToolOutputBudget): boolean {
  return (
    text.length > budget.maxChars ||
    (budget.maxTokens !== undefined && estimateStringTokens(text) > budget.maxTokens)
  );
}

function headTail(text: string, keepChars: number): [string, string] {
  let headEnd = Math.ceil(keepChars / 2);
  let tailStart = text.length - Math.floor(keepChars / 2);
  // Do not cut a UTF-16 surrogate pair in half.
  if (headEnd > 0 && /[\uD800-\uDBFF]/.test(text[headEnd - 1]!)) headEnd--;
  if (tailStart < text.length && /[\uDC00-\uDFFF]/.test(text[tailStart]!)) tailStart++;
  const headNewline = text.lastIndexOf("\n", headEnd - 1);
  if (headNewline > headEnd / 2) headEnd = headNewline;
  const tailNewline = text.indexOf("\n", tailStart);
  if (tailNewline >= tailStart && tailNewline < (tailStart + text.length) / 2) {
    tailStart = tailNewline + 1;
  }
  return [text.slice(0, headEnd), text.slice(tailStart)];
}

/** Deterministic head/tail view: reserve the notice inside both output budgets. */
export function truncateToolOutput(text: string, budget: ToolOutputBudget): string {
  if (!exceedsToolOutputBudget(text, budget)) return text;
  const marker = `\n${TOOL_OUTPUT_TRUNCATED}\n`;
  if (text.length <= marker.length || exceedsToolOutputBudget(marker, budget)) return "";
  const originalDensity = estimateStringTokens(text) / text.length;
  const tokenCharLimit =
    budget.maxTokens === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(
          0,
          Math.floor(
            (budget.maxTokens - estimateStringTokens(marker)) /
              Math.max(originalDensity, Number.EPSILON),
          ),
        );
  let low = 0;
  let high = Math.max(
    0,
    Math.min(
      text.length - marker.length - 1,
      Math.floor(budget.maxChars) - marker.length,
      tokenCharLimit,
    ),
  );
  let best = marker;
  while (low <= high) {
    const keepChars = Math.floor((low + high) / 2);
    const [head, tail] = headTail(text, keepChars);
    const candidate = head + marker + tail;
    if (exceedsToolOutputBudget(candidate, budget)) {
      high = keepChars - 1;
    } else {
      best = candidate;
      low = keepChars + 1;
    }
  }
  return best;
}

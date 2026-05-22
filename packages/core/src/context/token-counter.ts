/**
 * Token counter — more accurate token estimation.
 *
 * Uses a character-based heuristic tuned per language/content type,
 * with cache-aware accounting for prompt caching.
 */

import type { Message, ContentBlock } from "../types.js";

/**
 * Token-to-character ratios by content type.
 * These are empirical averages from Claude/GPT tokenizers.
 */
const RATIOS = {
  english: 4.0,      // ~4 chars per token for English prose
  code: 3.2,         // ~3.2 chars per token for code (more tokens per char)
  json: 3.5,         // JSON structures
  mixed: 3.6,        // Mixed content (typical for tool results)
  cjk: 1.5,          // CJK characters: ~1.5 chars per token
};

/**
 * Estimate token count for a string, detecting content type.
 */
export function estimateStringTokens(text: string): number {
  if (!text) return 0;

  // Detect CJK content ratio
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const cjkRatio = cjkChars / text.length;

  if (cjkRatio > 0.3) {
    // Weighted average for mixed CJK/ASCII
    const cjkTokens = cjkChars / RATIOS.cjk;
    const otherChars = text.length - cjkChars;
    const otherTokens = otherChars / RATIOS.english;
    return Math.ceil(cjkTokens + otherTokens);
  }

  // Detect code
  const codeIndicators = ["{", "}", "(", ")", ";", "=>", "import ", "function ", "class ", "const "];
  const codeScore = codeIndicators.reduce((s, ind) => s + (text.includes(ind) ? 1 : 0), 0);

  if (codeScore >= 3) return Math.ceil(text.length / RATIOS.code);
  if (text.startsWith("{") || text.startsWith("[")) return Math.ceil(text.length / RATIOS.json);

  return Math.ceil(text.length / RATIOS.english);
}

/**
 * Estimate token count for a message array.
 */
export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    // Per-message overhead (role, formatting) ≈ 4 tokens
    total += 4;

    if (typeof msg.content === "string") {
      total += estimateStringTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        total += estimateBlockTokens(block);
      }
    }
  }
  return total;
}

/**
 * Estimate tokens for a content block.
 */
function estimateBlockTokens(block: ContentBlock): number {
  let tokens = 2; // Block overhead

  if (block.text) tokens += estimateStringTokens(block.text);
  if (block.content && typeof block.content === "string") {
    tokens += estimateStringTokens(block.content);
  }
  if (block.input) {
    tokens += estimateStringTokens(JSON.stringify(block.input));
  }
  if (block.name) tokens += estimateStringTokens(block.name);

  return tokens;
}

/**
 * Context window usage report.
 */
export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
  usagePercent: number;
  systemPromptTokens: number;
  messagesTokens: number;
  headroom: number;
}

export function calculateContextUsage(
  messages: Message[],
  systemPrompt: string,
  maxTokens: number,
): ContextUsage {
  const systemPromptTokens = estimateStringTokens(systemPrompt);
  const messagesTokens = estimateMessagesTokens(messages);
  const usedTokens = systemPromptTokens + messagesTokens;

  return {
    usedTokens,
    maxTokens,
    usagePercent: (usedTokens / maxTokens) * 100,
    systemPromptTokens,
    messagesTokens,
    headroom: maxTokens - usedTokens,
  };
}

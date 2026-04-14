/**
 * Compaction service — context window management and auto-compaction.
 *
 * Provides microcompact (inline trimming), autocompact (threshold-based),
 * and full compaction (LLM-based summarization) strategies.
 */

export interface CompactionConfig {
  /** Max context tokens before triggering auto-compaction */
  autoCompactThreshold: number;
  /** Percentage of context to retain after compaction (0-1) */
  retentionRatio: number;
  /** Whether to preserve system messages during compaction */
  preserveSystemMessages: boolean;
  /** Whether auto-compaction is enabled */
  autoCompactEnabled: boolean;
}

export interface CompactionResult {
  /** Summary text that replaces the compacted content */
  summary: string;
  /** Number of messages removed */
  messagesRemoved: number;
  /** Tokens freed */
  tokensFreed: number;
  /** Strategy used */
  strategy: "micro" | "auto" | "full";
}

export interface Message {
  role: string;
  content: string | unknown[];
  tokenEstimate?: number;
}

const DEFAULT_CONFIG: CompactionConfig = {
  autoCompactThreshold: 150_000,
  retentionRatio: 0.3,
  preserveSystemMessages: true,
  autoCompactEnabled: true,
};

/**
 * Micro-compaction: trim tool results and long messages inline.
 */
export function microCompact(messages: Message[], maxTokensPerMessage = 4000): Message[] {
  return messages.map((msg) => {
    if (typeof msg.content !== "string") return msg;
    const estimate = Math.ceil(msg.content.length / 4);
    if (estimate <= maxTokensPerMessage) return msg;

    // Truncate middle, keep start and end
    const keepChars = maxTokensPerMessage * 4;
    const headLen = Math.floor(keepChars * 0.7);
    const tailLen = keepChars - headLen;
    const truncated =
      msg.content.slice(0, headLen) +
      "\n\n... [truncated] ...\n\n" +
      msg.content.slice(-tailLen);

    return { ...msg, content: truncated };
  });
}

/**
 * Check if auto-compaction should be triggered.
 */
export function shouldAutoCompact(
  currentTokens: number,
  config: CompactionConfig = DEFAULT_CONFIG,
): boolean {
  return config.autoCompactEnabled && currentTokens > config.autoCompactThreshold;
}

/**
 * Build a compaction prompt for LLM-based summarization.
 */
export function buildCompactionPrompt(
  messages: Message[],
  customInstructions?: string,
): string {
  const conversationText = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${m.role}]: ${content.slice(0, 2000)}`;
    })
    .join("\n\n");

  return `Summarize the following conversation concisely, preserving:
1. Key decisions and outcomes
2. Important file paths, function names, and code references
3. Outstanding tasks or questions
4. Any errors encountered and their resolutions

${customInstructions ? `Additional instructions: ${customInstructions}\n\n` : ""}Conversation:
${conversationText.slice(0, 50000)}

Provide a structured summary that captures the essential context needed to continue the conversation.`;
}

/**
 * Apply compaction by removing old messages and inserting a summary.
 */
export function applyCompaction(
  messages: Message[],
  summary: string,
  config: CompactionConfig = DEFAULT_CONFIG,
): { messages: Message[]; result: CompactionResult } {
  const retain = Math.max(1, Math.floor(messages.length * config.retentionRatio));
  const toRemove = messages.length - retain;

  // Keep system messages if configured
  const systemMessages = config.preserveSystemMessages
    ? messages.filter((m) => m.role === "system")
    : [];

  const keptMessages = messages.slice(-retain);
  const removedTokens = messages
    .slice(0, toRemove)
    .reduce((sum, m) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return sum + Math.ceil(content.length / 4);
    }, 0);

  const summaryMessage: Message = {
    role: "system",
    content: `[Previous conversation summary]\n\n${summary}`,
  };

  return {
    messages: [...systemMessages, summaryMessage, ...keptMessages],
    result: {
      summary,
      messagesRemoved: toRemove,
      tokensFreed: removedTokens,
      strategy: "full",
    },
  };
}

export const compactionService = {
  microCompact,
  shouldAutoCompact,
  buildCompactionPrompt,
  applyCompaction,
};

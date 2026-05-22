/**
 * Tool use summary — generates a 1-line progress label after tool batch execution.
 *
 * Runs async (fire-and-forget) so it doesn't block the next model call.
 * Returns a short commit-subject-style string like "Read 3 files, fixed NPE in auth.ts"
 */

import type { ToolCall, ToolResult } from "../types.js";
import { logger } from "../logging/logger.js";

const SUMMARY_SYSTEM_PROMPT =
  "Generate a very brief (under 40 chars) summary of what these tools did. " +
  "Use past tense, commit-subject style. Examples: " +
  '"Read 3 config files", "Fixed import in auth.ts", "Searched for API endpoints". ' +
  "Respond with ONLY the summary text, nothing else.";

export type SummarizeFn = (systemPrompt: string, userMessage: string) => Promise<string>;

/**
 * Generate a 1-line summary of completed tool executions.
 * Returns null on failure (non-critical).
 */
export async function generateToolUseSummary(
  toolCalls: ToolCall[],
  results: ToolResult[],
  summarize: SummarizeFn,
): Promise<string | null> {
  if (toolCalls.length === 0) return null;

  try {
    const parts: string[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const result = results[i];
      const input = JSON.stringify(tc.args).slice(0, 200);
      const output = (result?.result ?? result?.error ?? "").slice(0, 300);
      parts.push(`Tool: ${tc.toolName}(${input}) → ${output}`);
    }

    const summary = await summarize(SUMMARY_SYSTEM_PROMPT, parts.join("\n"));
    return summary?.trim() || null;
  } catch (err) {
    logger.warn("tool_summary.failed", { error: (err as Error).message });
    return null;
  }
}

/**
 * Session title generation — best-effort, one-line LLM title for the sidebar.
 *
 * Pure function (no Engine `this`) so it's trivially unit-testable. The Engine
 * resolves the aux client and wiring; this only does the LLM call + cleanup.
 */
import type { LLMClientBase } from "../llm/client-base.js";
import type { TokenUsage } from "../types.js";

const SYSTEM_PROMPT =
  "You generate a very short title (≤6 words, no quotes, no trailing punctuation) " +
  "summarizing a chat, in the same language as the user's message.";

/** Strip wrapping quotes/whitespace the model sometimes adds. */
function clean(raw: string): string {
  return raw
    .trim()
    .replace(/^["'“”‘’「『]+/, "")
    .replace(/["'“”‘’」』]+$/, "")
    .trim();
}

/**
 * Ask the aux client for a one-line title from the first user message + first
 * assistant reply. Returns the cleaned title, or null on any failure / empty
 * output (caller treats null as "keep existing title").
 */
export async function buildSessionTitle(
  client: LLMClientBase,
  firstUserText: string,
  firstAssistantText: string,
  recordBilledUsage?: (usage: TokenUsage) => void,
): Promise<string | null> {
  try {
    const prompt =
      `User: ${firstUserText.slice(0, 2000)}\n\n` +
      `Assistant: ${firstAssistantText.slice(0, 2000)}\n\n` +
      `Title:`;
    const resp = await client.createMessage({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      tools: [],
      maxTokens: 64,
      requestVisible: false,
      reasoning: { mode: "off" },
    });
    if (resp.usage) recordBilledUsage?.(resp.usage);
    const title = clean(resp.text ?? "");
    return title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

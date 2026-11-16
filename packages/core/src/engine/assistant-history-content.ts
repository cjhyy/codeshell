import type { ContentBlock, LLMResponse, Message, ToolCall } from "../types.js";

/** One representation for live and persisted assistant history, including reasoning. */
export function assistantHistoryContent(
  response: Pick<LLMResponse, "text" | "reasoningContent" | "toolCalls">,
  toolCalls: readonly ToolCall[] = response.toolCalls,
  text = response.text,
): Message["content"] {
  if (!response.reasoningContent && toolCalls.length === 0) return text;
  const blocks: ContentBlock[] = [];
  if (response.reasoningContent) {
    blocks.push({ type: "reasoning", reasoningContent: response.reasoningContent });
  }
  if (text) blocks.push({ type: "text", text });
  for (const call of toolCalls) {
    blocks.push({ type: "tool_use", id: call.id, name: call.toolName, input: call.args });
  }
  return blocks;
}

import type { Message, ToolResult } from "../types.js";

export const SENSITIVE_TOOL_RESULT_PLACEHOLDER = "[credential value withheld]";

export function toolResultDisplayText(result: ToolResult): string | undefined {
  if (!result.sensitive) return result.result;
  return result.displayResult ?? result.transcriptResult ?? SENSITIVE_TOOL_RESULT_PLACEHOLDER;
}

export function toolResultTranscriptText(result: ToolResult): string | undefined {
  if (!result.sensitive) return result.result;
  return result.transcriptResult ?? result.displayResult ?? SENSITIVE_TOOL_RESULT_PLACEHOLDER;
}

export function toolResultForDisplay(result: ToolResult): ToolResult {
  if (!result.sensitive) return result;
  const { displayResult: _displayResult, transcriptResult: _transcriptResult, ...rest } = result;
  return {
    ...rest,
    result: toolResultDisplayText(result),
    contentBlocks: undefined,
  };
}

export function toolResultsForDisplay(results: ToolResult[]): ToolResult[] {
  return results.map((result) => toolResultForDisplay(result));
}

export function redactSensitiveToolResultsInMessages(
  messages: Message[],
  redactions: ReadonlyMap<string, string>,
): Message[] {
  if (redactions.size === 0) return messages;
  let changed = false;
  const out = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    let contentChanged = false;
    const content = message.content.map((block) => {
      if (block.type !== "tool_result") return block;
      const replacement =
        typeof block.tool_use_id === "string" ? redactions.get(block.tool_use_id) : undefined;
      if (replacement === undefined) return block;
      contentChanged = true;
      return { ...block, content: replacement };
    });
    if (!contentChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? out : messages;
}

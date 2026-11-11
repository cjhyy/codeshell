import type { Message } from "../types.js";

/**
 * Discovery results carry the only in-context schemas for deferred tools.
 * Keep them verbatim until a full context rebase moves those schemas into the
 * frozen tool surface. Match the original wire call, including CallTool.
 */
export function toolSchemaResultIds(messages: Message[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "tool_use" || !block.id) continue;
      if (
        block.name === "ToolSearch" ||
        (block.name === "CallTool" && block.input?.name === "ToolSearch")
      ) {
        ids.add(block.id);
      }
    }
  }
  return ids;
}

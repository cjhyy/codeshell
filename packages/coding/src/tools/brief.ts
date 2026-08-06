/**
 * Legacy Brief formatter.
 *
 * Kept as a root compatibility export for existing programmatic consumers. It
 * is intentionally not registered in the default coding capability because a
 * tool result is not a user-facing assistant message.
 */

import type { ToolDefinition } from "@cjhyy/code-shell-core/extension";

/** @deprecated Return user-facing Markdown as normal assistant text instead. */
export const briefToolDef: ToolDefinition = {
  name: "Brief",
  description:
    "Send a structured brief/summary message. Useful for providing concise status updates, " +
    "summaries, or formatted output to the user.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Brief title or heading",
      },
      content: {
        type: "string",
        description: "Markdown-formatted content of the brief",
      },
      status: {
        type: "string",
        enum: ["info", "success", "warning", "error"],
        description: "Status level for the brief (default: info)",
      },
    },
    required: ["content"],
  },
};

/** @deprecated Return user-facing Markdown as normal assistant text instead. */
export async function briefTool(args: Record<string, unknown>): Promise<string> {
  const title = args.title as string | undefined;
  const content = args.content as string;
  const status = (args.status as string) ?? "info";

  const icons: Record<string, string> = {
    info: "ℹ",
    success: "✓",
    warning: "⚠",
    error: "✗",
  };

  const icon = icons[status] ?? "ℹ";
  const header = title ? `${icon} ${title}\n\n` : "";
  return `${header}${content}`;
}

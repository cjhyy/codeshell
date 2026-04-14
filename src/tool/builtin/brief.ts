/**
 * BriefTool — send structured messages with markdown support.
 */

import type { ToolDefinition } from "../../types.js";

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

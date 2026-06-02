/**
 * complete_goal — Goal mode P0.
 *
 * The model calls this to explicitly DECLARE the current goal complete
 * (mirrors Codex's update_goal(status=Complete)). When the turn loop sees
 * this tool call it short-circuits to a "completed" stop WITHOUT running the
 * judge LLM (wired in Task 4). This tool itself just records an
 * acknowledgement string into the transcript; the loop-level short-circuit
 * lives in turn-loop.ts.
 *
 * Shape note: builtin tools in this codebase are a `ToolDefinition`
 * (name/description/inputSchema only — see types.ts) plus a separate executor
 * `(args: Record<string, unknown>) => Promise<string>`. The runtime metadata
 * (source/permissionDefault/isReadOnly/...) is attached in builtin/index.ts at
 * registration time, NOT on the def. Registration is Task 6.
 */

import type { ToolDefinition } from "../../types.js";

export const completeGoalToolDef: ToolDefinition = {
  name: "complete_goal",
  description:
    "声明当前目标已完全达成。仅当目标确实完整完成时才调用本工具(模型在目标完全达成时显式调用以声明完成)。" +
    "调用后应当停止。可选传入 summary 作为一句话完成总结。\n" +
    "Declare the current goal complete. Call this ONLY when the goal is fully achieved. " +
    "After calling, you should stop. Optionally pass a one-line summary of what was accomplished.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "可选:一句话总结所完成的工作。Optional one-line summary of what was accomplished.",
      },
    },
    required: [],
  },
};

export async function completeGoalTool(
  args: Record<string, unknown>,
): Promise<string> {
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  return summary
    ? `目标已完成 (goal complete). Summary: ${summary}`
    : "目标已完成 (goal complete).";
}

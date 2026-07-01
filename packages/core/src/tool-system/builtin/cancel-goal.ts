/**
 * cancel_goal — user-initiated goal ABANDONMENT (distinct from complete_goal).
 *
 * complete_goal = "the goal is fully achieved, stop." cancel_goal = "the user
 * explicitly asked to STOP pursuing this goal even though it isn't done." Both
 * short-circuit the turn loop to a stop and clear the persisted goal so a later
 * bare send won't re-inherit it — but cancel_goal is a controlled escape hatch,
 * NOT a self-judgment the model may make on its own.
 *
 * "Strong intent" guard (the whole point of this tool): the model must NOT
 * cancel a goal on its own initiative — only when the user has clearly asked to
 * stop/abandon it. To make that hard to do accidentally, the schema REQUIRES:
 *   - confirm: true         — an explicit boolean gate (a bare call is invalid)
 *   - reason: string        — the user's own words / paraphrase of the request
 * The turn loop only honors the cancellation when confirm === true; anything
 * else records a refusal string and does NOT stop or clear the goal.
 *
 * Shape note: like complete_goal, this is a ToolDefinition + a separate executor
 * returning a string. The loop-level short-circuit lives in turn-loop.ts and
 * keys off CANCEL_GOAL_TOOL_NAME.
 */

import type { ToolDefinition } from "../../types.js";

/** Shared with turn-loop.ts's short-circuit check — the name lives in one place. */
export const CANCEL_GOAL_TOOL_NAME = "cancel_goal";

export const cancelGoalToolDef: ToolDefinition = {
  name: CANCEL_GOAL_TOOL_NAME,
  description:
    "取消(放弃)当前的持久目标。⚠️ 仅当用户明确要求停止/取消/放弃当前目标时才调用本工具;" +
    "绝不要自行判断放弃目标(“目标太难”“暂时做不完”都不是取消理由——那种情况应继续或用 complete_goal)。" +
    "必须传 confirm=true 并在 reason 里复述用户要求取消的原话/意图。调用后目标会被清除,agent 停止。\n" +
    "Cancel (abandon) the current persistent goal. ⚠️ Call this ONLY when the user has EXPLICITLY asked to " +
    "stop/cancel/abandon the goal. NEVER decide to abandon a goal on your own (a hard or unfinished goal is " +
    "NOT a reason to cancel). You MUST pass confirm=true and put the user's own words/intent in `reason`. " +
    "After calling, the goal is cleared and the agent stops.",
  inputSchema: {
    type: "object",
    properties: {
      confirm: {
        type: "boolean",
        description:
          "必须为 true 才会真正取消目标。缺省或 false 视为无效调用,不会取消。" +
          "Must be true to actually cancel. Missing/false is treated as an invalid call and cancels nothing.",
      },
      reason: {
        type: "string",
        description:
          "用户要求取消目标的原话或意图复述(必填)。Required: the user's own words / paraphrased request to cancel.",
      },
    },
    required: ["confirm", "reason"],
  },
};

/**
 * Executor. Returns a human-readable acknowledgement. The ACTUAL cancellation
 * (stop + clear persisted goal) is enforced in turn-loop.ts, which re-checks
 * confirm===true — this executor's string is only what lands in the transcript.
 */
export async function cancelGoalTool(args: Record<string, unknown>): Promise<string> {
  const confirmed = args.confirm === true;
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!confirmed) {
    return (
      "cancel_goal 未生效:confirm 必须为 true 且需说明用户要求取消的原因。" +
      "(cancel_goal ignored: confirm must be true and a reason is required.)"
    );
  }
  return reason
    ? `目标已按用户要求取消 (goal cancelled by user). Reason: ${reason}`
    : "目标已按用户要求取消 (goal cancelled by user).";
}

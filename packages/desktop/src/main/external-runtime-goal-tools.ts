import type { RegisteredTool } from "@cjhyy/code-shell-core";
import type { BuiltinToolExposure } from "@cjhyy/code-shell-core/extension";
import { EXTERNAL_GOAL_TOOLS, type ExternalRuntimeGoals } from "./external-runtime-goals.js";
import { GOAL_WAIT_FOR_USER_PROPERTIES } from "../shared/goal-questions.js";

type GoalToolName = (typeof EXTERNAL_GOAL_TOOLS)[number];

const IDENTITY = {
  goalId: { type: "string" },
  revision: { type: "integer", minimum: 1 },
} as const;

const CONTRACTS: Record<
  GoalToolName,
  { description: string; properties: Record<string, unknown>; required: string[] }
> = {
  get_goal: {
    description: "Read this CodeShell session's persisted goal and its goalId/revision.",
    properties: {},
    required: [],
  },
  complete_goal: {
    description:
      "Declare the CodeShell goal fully achieved. For a judgment-based objective, the user accepting the current result counts as achieved. Supply its current goalId and revision.",
    properties: { ...IDENTITY, summary: { type: "string" } },
    required: ["goalId", "revision"],
  },
  cancel_goal: {
    description:
      "Cancel a CodeShell goal ONLY when the user explicitly requests cancellation. Include the user's reason.",
    properties: { ...IDENTITY, confirm: { type: "boolean" }, reason: { type: "string" } },
    required: ["goalId", "revision", "confirm", "reason"],
  },
  wait_for_user: {
    description:
      "Stop the CodeShell goal until the user replies, when you need their decision, consent or missing information. " +
      "For a choice between known options, pass `questions` so the user picks from a banner; never write a multiple-choice question as text. " +
      "CodeShell shows the question to the user: do not repeat it in your reply text. At most one call per turn; never re-ask a question that is still unanswered or that the user already passed over.",
    properties: { ...IDENTITY, ...GOAL_WAIT_FOR_USER_PROPERTIES },
    required: ["goalId", "revision"],
  },
  wait_for_background: {
    description:
      "Park the CodeShell goal until background work you started completes. Call it only when nothing is left to do that does not depend on that work; completion wakes the goal automatically, so never poll or sleep instead.",
    properties: {
      ...IDENTITY,
      reason: { type: "string", description: "Optional: what you are waiting for." },
    },
    required: ["goalId", "revision"],
  },
};

/** The Host controller's schemas differ from native Engine acknowledgement tools. */
export const EXTERNAL_GOAL_TOOL_CATALOG: readonly {
  definition: RegisteredTool;
  exposure: BuiltinToolExposure;
}[] = EXTERNAL_GOAL_TOOLS.map((name) => ({
  definition: {
    name,
    description: CONTRACTS[name].description,
    inputSchema: {
      type: "object",
      properties: CONTRACTS[name].properties,
      required: CONTRACTS[name].required,
    },
    source: "builtin",
    permissionDefault: "allow",
    isReadOnly: name === "get_goal",
    isConcurrencySafe: false,
  },
  exposure: {
    presetTags: [],
    external: {
      kind: "self-contained",
      status: "exposed",
      requires: "goal-controller",
      reason:
        "Host-owned persisted Goal controller with goalId/revision checks. Available only " +
        "with Host tools in execution mode; native Engine acknowledgement handlers remain excluded.",
    },
  },
}));

/** Run one Goal controller tool against the live, version-checked controller. */
export function runExternalGoalTool(
  goals: ExternalRuntimeGoals,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  backgroundRunning: () => boolean,
): string {
  const result = (): unknown => {
    switch (name as GoalToolName) {
      case "get_goal":
        return goals.get(sessionId);
      case "wait_for_user":
        return goals.waitForUser(sessionId, args);
      case "wait_for_background":
        return goals.waitForBackground(sessionId, args, backgroundRunning());
      case "complete_goal":
        return goals.settle(sessionId, "completed", args);
      default:
        return goals.settle(sessionId, "cancelled", args);
    }
  };
  return JSON.stringify(result());
}

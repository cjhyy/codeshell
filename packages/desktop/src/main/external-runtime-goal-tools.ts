import type { RegisteredTool } from "@cjhyy/code-shell-core";
import type { BuiltinToolExposure } from "@cjhyy/code-shell-core/extension";
import { EXTERNAL_GOAL_TOOLS } from "./external-runtime-goals.js";

/** The Host controller's schemas differ from native Engine acknowledgement tools. */
export const EXTERNAL_GOAL_TOOL_CATALOG: readonly {
  definition: RegisteredTool;
  exposure: BuiltinToolExposure;
}[] = EXTERNAL_GOAL_TOOLS.map((name) => ({
  definition: {
    name,
    description:
      name === "get_goal"
        ? "Read this CodeShell session's persisted goal and its goalId/revision."
        : name === "complete_goal"
          ? "Declare the CodeShell goal fully achieved. Supply its current goalId and revision."
          : name === "wait_for_user"
            ? "Stop the CodeShell goal until the user replies, when you need their decision, approval or missing information. Ask the same question in your reply."
            : "Cancel a CodeShell goal ONLY when the user explicitly requests cancellation. Include the user's reason.",
    inputSchema: {
      type: "object",
      properties:
        name === "get_goal"
          ? {}
          : {
              goalId: { type: "string" },
              revision: { type: "integer", minimum: 1 },
              ...(name === "complete_goal"
                ? { summary: { type: "string" } }
                : name === "wait_for_user"
                  ? { question: { type: "string" } }
                  : { confirm: { type: "boolean" }, reason: { type: "string" } }),
            },
      required:
        name === "get_goal"
          ? []
          : [
              "goalId",
              "revision",
              ...(name === "cancel_goal"
                ? ["confirm", "reason"]
                : name === "wait_for_user"
                  ? ["question"]
                  : []),
            ],
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

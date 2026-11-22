import type { ExternalRuntimeGoals } from "../main/external-runtime-goals.js";

export interface GoalRecoveryOperations {
  "goals/recent": { input: { sinceMs: number }; result: string[] };
  "goals/attention": {
    input: { sessionId: string };
    result: {
      topLevel: boolean;
      external: boolean;
      attention?: import("../main/external-runtime-goal-attention.js").ExternalGoalAttention;
    };
  };
  "goals/read": {
    input: { sessionId: string };
    result: { external: boolean; goal: ReturnType<ExternalRuntimeGoals["get"]> };
  };
  "goals/resume": {
    input: { sessionId: string; includeContext: boolean };
    result: {
      identity: string;
      projectBound: boolean;
      modelKey: string;
      cwd: string;
      mainRoot: string;
      initialContext?: string;
    };
  };
}

/** Run-local task tracking and durable Goal progress projection. */
import type { SessionBundle } from "../session/session-manager.js";
import type { StreamCallback, TaskInfo } from "../types.js";

export function buildWrappedOnStream(args: {
  userOnStream: StreamCallback | undefined;
  getSession: () => SessionBundle;
  setLatestTodos: (todos: TaskInfo[]) => void;
}): StreamCallback {
  const { userOnStream, getSession, setLatestTodos } = args;
  return (event) => {
    if (event.type === "task_update") {
      setLatestTodos(event.tasks);
    }
    // Persist goal progress so replay/history shows how many rounds the
    // goal ran. Display-only — toMessages() ignores this type, so it never
    // re-enters the LLM context.
    if (event.type === "goal_progress") {
      getSession().transcript.append("goal_progress", {
        ...(event.goalId ? { goalId: event.goalId } : {}),
        status: event.status,
        round: event.round,
        ...(event.gaps ? { gaps: event.gaps } : {}),
      });
    }
    userOnStream?.(event);
  };
}

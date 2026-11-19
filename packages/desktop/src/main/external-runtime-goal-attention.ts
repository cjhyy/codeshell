import type { SessionState } from "@cjhyy/code-shell-core";
import { replayedGoalQuestionDetail, type GoalQuestion } from "../shared/goal-questions.js";

/** The fields of a Session's persisted state (core `SessionState`) read here. */
export type GoalAttentionState = Pick<
  SessionState,
  "goalLifecycle" | "runId" | "lastCompletionKind"
>;

/** A limit a Goal can pause on (`GoalPauseReason` without the user's own pauses). */
export type GoalLimitPause = "time_budget" | "token_budget" | "turn_limit" | "no_progress";
const LIMIT_PAUSES: readonly string[] = [
  "time_budget",
  "token_budget",
  "turn_limit",
  "no_progress",
];

interface GoalAttentionBase {
  goalId: string;
  revision: number;
  /** The run that paused or asked, when it is known. */
  runId?: string;
  /** When the Goal stopped (epoch ms). */
  atMs: number;
}

/**
 * Why a persisted external-runtime Goal is stopped and needs its owner:
 * - `limit`: a budget or limit paused it (`limit` absent for a pause recorded
 *   before reasons were persisted);
 * - `question`: it waits for the user's answer to this question;
 * - `waiting`: it waits for the user, and the question was not recorded
 *   (asked by an older build): nothing can be stated about it.
 * Undefined for every other state: active, paused by the user, waiting on
 * background work, completed or cleared.
 */
export type ExternalGoalAttention = GoalAttentionBase &
  (
    | { kind: "limit"; limit?: GoalLimitPause }
    | { kind: "question"; question: GoalQuestion }
    | { kind: "waiting" }
  );

/** The open wait_for_user question a Session's state records, validated like a replayed one. */
export function persistedGoalQuestion(
  state: Pick<SessionState, "goalLifecycle"> | undefined,
): GoalQuestion | undefined {
  const lifecycle = state?.goalLifecycle;
  if (lifecycle?.phase !== "waiting" || lifecycle.waitKind !== "user") return undefined;
  const text = lifecycle.question?.text.trim();
  if (!text) return undefined;
  const detail = replayedGoalQuestionDetail(text, lifecycle.question?.detail);
  return {
    text,
    level: detail?.level ?? "preference",
    ...(detail?.questions ? { questions: detail.questions } : {}),
  };
}

/** Read what a Session's persisted Goal needs from its owner, if anything. */
export function persistedGoalAttention(
  state: GoalAttentionState | undefined,
): ExternalGoalAttention | undefined {
  const lifecycle = state?.goalLifecycle;
  if (!state || !lifecycle) return undefined;
  if (lifecycle.phase !== "paused" && lifecycle.phase !== "waiting") return undefined;
  // A record that names no run (an older build's) stopped in the Session's latest one.
  const runId = lifecycle.runId ?? state.runId;
  const base = {
    goalId: lifecycle.goalId,
    revision: lifecycle.revision,
    ...(runId ? { runId } : {}),
  };
  if (lifecycle.phase === "paused") {
    const reason = lifecycle.pauseReason;
    // A record from before the reason was persisted: the run that ended on a limit says so.
    const limited =
      reason === undefined
        ? state.lastCompletionKind === "limit_stop"
        : LIMIT_PAUSES.includes(reason);
    if (!limited) return undefined;
    return {
      ...base,
      kind: "limit",
      atMs: lifecycle.updatedAtMs,
      ...(reason !== undefined ? { limit: reason as GoalLimitPause } : {}),
    };
  }
  if (lifecycle.waitKind !== "user") return undefined;
  const question = persistedGoalQuestion(state);
  return question
    ? { ...base, kind: "question", atMs: lifecycle.waitingSinceMs, question }
    : { ...base, kind: "waiting", atMs: lifecycle.waitingSinceMs };
}
